import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CuaDriver, DriverMetadata } from "@trycua/cua-driver";
import {
  ObservationError,
  type DesktopAdapter,
  type DesktopBinding,
  type DesktopSnapshot,
  type DesktopTarget,
  type DesktopHost,
} from "../contracts.js";
import { json } from "../util.js";
import { desktopVersions } from "./versions.js";

const exec = promisify(execFile);
// A shared queue covers all embedded instances in this Node host. Cross-process
// coordination belongs to the caller's desktop lease; it is not silently assumed.
let desktopInputs: Promise<unknown> = Promise.resolve();

export class CuaDesktopAdapter implements DesktopAdapter {
  constructor(private host: DesktopHost = { mode: "embedded" }) {}
  private driver?: CuaDriver;
  private sdk?: typeof import("@trycua/cua-driver");
  private binding?: DesktopBinding;
  private closing = false;
  private pending = new Set<Promise<unknown>>();
  private closePromise?: Promise<void>;
  private session = `ui-observation-${randomUUID()}`;
  private sessionStarted = false;
  private hostMetadata?: DriverMetadata;
  private async verifyHost(signal: AbortSignal) {
    if (this.host.mode !== "daemon") return;
    const metadata = await this.driver!.metadata({ signal });
    if (
      metadata.embedded ||
      metadata.pid !== this.host.expectedPid ||
      metadata.driverVersion !== this.host.expectedVersion
    )
      throw new ObservationError(
        "SDK_HOST_MISMATCH",
        "The explicit SDK host identity/version changed",
        "desktop",
      );
    this.hostMetadata = metadata;
  }
  private async call<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing)
      throw new ObservationError(
        "CLOSED",
        "Desktop adapter is closing",
        "desktop",
      );
    const signal = AbortSignal.timeout(10000);
    const p = this.verifyHost(signal).then(() => fn(signal));
    this.pending.add(p);
    try {
      return await p;
    } finally {
      this.pending.delete(p);
    }
  }
  async connect(target: DesktopTarget): Promise<DesktopBinding> {
    if (this.driver || this.closing)
      throw new ObservationError(
        "LIFECYCLE",
        "Use a new desktop adapter for each run",
      );
    this.sdk = await import("@trycua/cua-driver");
    this.driver = (
      this.host.mode === "daemon"
        ? this.sdk.CuaDriver.connect(this.host.socketPath)
        : this.sdk.CuaDriver.create({
            embedded: true,
            claudeCodeCompatibility: false,
          })
    ) as CuaDriver;
    await this.call((signal) =>
      this.driver!.startSession({ session: this.session }, { signal }),
    );
    this.sessionStarted = true;
    const permissions =
      this.host.mode === "daemon"
        ? {
            source: "explicit-sdk-host",
            status:
              "channel availability is verified by getWindowState; local Node grants are not substituted",
          }
        : process.platform === "darwin"
          ? this.sdk.currentMacOsPermissionStatus()
          : { accessibility: null, screenRecording: null };
    const apps = await this.call((signal) =>
      this.driver!.listApps({}, { signal }),
    );
    const matches = apps.apps.filter(
      (a) =>
        a.running &&
        a.bundleId === target.bundleId &&
        (target.pid === undefined || a.pid === target.pid),
    );
    if (matches.length !== 1)
      throw new ObservationError(
        "APP_NOT_UNIQUE",
        `Expected one running ${target.bundleId}; found ${matches.length}. Permissions: ${json(permissions).trim()}`,
        "desktop",
      );
    const app = matches[0]!;
    const windows = await this.call((signal) =>
      this.driver!.listWindows(
        { pid: app.pid, onScreenOnly: false },
        { signal },
      ),
    );
    const selected = windows.windows.filter(
      (w) =>
        w.pid === app.pid &&
        w.title === target.title &&
        (target.windowId === undefined ||
          String(w.windowId) === target.windowId),
    );
    if (selected.length !== 1)
      throw new ObservationError(
        "WINDOW_NOT_UNIQUE",
        `Exact title/window matched ${selected.length} windows; permissions: ${json(permissions).trim()}`,
        "desktop",
      );
    const window = selected[0]!;
    let version: string | null = null;
    if (process.platform === "darwin" && app.launchPath?.endsWith(".app")) {
      try {
        version = (
          await exec("/usr/libexec/PlistBuddy", [
            "-c",
            "Print :CFBundleShortVersionString",
            join(app.launchPath, "Contents/Info.plist"),
          ])
        ).stdout.trim();
      } catch {
        /* unavailable, never infer from title */
      }
    }
    this.binding = {
      app: {
        pid: app.pid,
        bundleId: target.bundleId,
        version,
        path: app.launchPath,
      },
      window: {
        id: String(window.windowId),
        title: window.title,
        bounds: window.bounds,
      },
      permissions,
      sdk: {
        ...(await desktopVersions()),
        mode: this.host.mode,
        host: this.hostMetadata ?? null,
        transport:
          this.host.mode === "daemon"
            ? "native SDK Unix-domain IPC (DaemonRequest), no MCP client"
            : "in-process native SDK",
        compatibility:
          this.hostMetadata?.driverVersion === "0.32.0"
            ? "SDK callTool omits fields unsupported by this daemon version"
            : null,
      },
    };
    return this.binding;
  }
  async snapshot(): Promise<DesktopSnapshot> {
    if (!this.binding)
      throw new ObservationError("NOT_CONNECTED", "No desktop window binding");
    const { app, window } = this.binding;
    if (this.hostMetadata?.driverVersion === "0.32.0") {
      // The pinned 0.36 typed serializer includes null 0.36-only arguments.
      // 0.32 rejects them. This public SDK compatibility call uses the same
      // native DaemonRequest IPC, not an MCP tools/call transport.
      const result = await this.call((signal) =>
        this.driver!.callTool(
          "get_window_state",
          JSON.stringify({
            pid: app.pid,
            window_id: Number(window.id),
            session: this.session,
            include_accessibility_tree: true,
            include_screenshot: true,
            max_image_dimension: 0,
            max_elements: 3000,
            timeout_ms: 4000,
          }),
          { signal },
        ),
      );
      if (result.isError)
        throw new ObservationError(
          result.errorCode ?? "SDK_CAPTURE_FAILED",
          result.text,
          "desktop",
        );
      const raw = JSON.parse(result.structuredJson ?? "null");
      if (!raw || raw.pid !== app.pid || String(raw.window_id) !== window.id)
        throw new ObservationError(
          "TARGET_CHANGED",
          "SDK returned another window",
        );
      const img =
        raw.screenshot_frame_valid === false ? undefined : result.images[0];
      const mimeType =
        img?.mimeType === "image/png" || img?.mimeType === "image/jpeg"
          ? img.mimeType
          : undefined;
      return {
        raw,
        image:
          img && mimeType ? Buffer.from(img.dataBase64, "base64") : undefined,
        mimeType,
        width: raw.screenshot_width,
        height: raw.screenshot_height,
        axAvailable:
          !raw.degraded &&
          (raw.elements !== undefined || raw.tree_markdown !== undefined),
        issues: [
          ...(raw.degraded
            ? [
                {
                  code: "AX_DEGRADED",
                  message: raw.degraded_reason ?? "Degraded SDK capture",
                  scope: "desktop",
                },
              ]
            : []),
          ...(raw.truncated
            ? [
                {
                  code: "AX_TRUNCATED",
                  message: raw.truncation_reason ?? "Truncated SDK capture",
                  scope: "desktop",
                },
              ]
            : []),
        ],
      };
    }
    const raw = await this.call((signal) =>
      this.driver!.getWindowState(
        {
          pid: app.pid,
          windowId: BigInt(window.id),
          session: this.session,
          includeAccessibilityTree: true,
          includeScreenshot: true,
          maxImageDimension: 0,
          treeFormat: "both",
          timeoutMs: 2000,
          fullOutput: true,
        },
        { signal },
      ),
    );
    if (raw.pid !== app.pid || String(raw.windowId) !== window.id)
      throw new ObservationError(
        "TARGET_CHANGED",
        "SDK returned another window",
      );
    const image =
      raw.screenshotFrameValid === false ? undefined : raw.images[0];
    const mimeType =
      image?.mimeType === "image/png" || image?.mimeType === "image/jpeg"
        ? image.mimeType
        : undefined;
    return {
      raw: JSON.parse(json(raw)),
      image:
        image && mimeType ? Buffer.from(image.dataBase64, "base64") : undefined,
      mimeType,
      width: raw.screenshotWidth,
      height: raw.screenshotHeight,
      axAvailable:
        !raw.degraded &&
        (raw.treeMarkdown !== undefined || raw.elements !== undefined),
      issues: [
        ...(raw.degraded
          ? [
              {
                code: "AX_DEGRADED",
                message: raw.degradedReason ?? "SDK degraded capture",
                scope: "desktop",
              },
            ]
          : []),
        ...(raw.truncated
          ? [
              {
                code: "AX_TRUNCATED",
                message: raw.truncationReason ?? "SDK truncated capture",
                scope: "desktop",
              },
            ]
          : []),
      ],
    };
  }
  async click(
    selector: string,
    delivery: "foreground" | "background",
  ): Promise<{
    delivery: "acknowledged" | "unknown" | "refused";
    raw: unknown;
  }> {
    const work = desktopInputs.then(() =>
      this.call(async (signal) => {
        if (!this.binding || !this.sdk)
          throw new ObservationError("NOT_CONNECTED", "No desktop binding");
        const { app, window } = this.binding;
        // The selector is a fresh SDK AX query, never a token saved in a recipe.
        let state: {
          degraded?: boolean;
          truncated?: boolean;
          elements?: Array<{
            label?: string;
            value?: string;
            enabled?: boolean;
            actions?: string[];
            elementToken?: string;
          }>;
        };
        if (this.hostMetadata?.driverVersion === "0.32.0") {
          const result = await this.driver!.callTool(
            "get_window_state",
            JSON.stringify({
              pid: app.pid,
              window_id: Number(window.id),
              session: this.session,
              query: selector,
              include_accessibility_tree: true,
              include_screenshot: false,
            }),
            { signal },
          );
          if (result.isError)
            throw new ObservationError(
              result.errorCode ?? "SDK_READ_FAILED",
              result.text,
            );
          const raw = JSON.parse(result.structuredJson ?? "null");
          if (
            !raw ||
            raw.pid !== app.pid ||
            String(raw.window_id) !== window.id
          )
            throw new ObservationError(
              "TARGET_CHANGED",
              "SDK returned another window",
            );
          state = {
            degraded: raw.degraded,
            truncated: raw.truncated,
            elements: raw.elements?.map(
              (e: {
                label?: string;
                value?: string;
                enabled?: boolean;
                actions?: string[];
                element_token?: string;
              }) => ({ ...e, elementToken: e.element_token }),
            ),
          };
        } else
          state = await this.driver!.getWindowState(
            {
              pid: app.pid,
              windowId: BigInt(window.id),
              session: this.session,
              query: selector,
              includeAccessibilityTree: true,
              includeScreenshot: false,
              treeFormat: "elements",
            },
            { signal },
          );
        const actionable = (state.elements ?? []).filter(
          (e) =>
            e.enabled !== false &&
            e.actions?.some((a) => a === "AXPress" || a === "press"),
        );
        const exact = actionable.filter((e) => e.label === selector);
        const matches = exact.length
          ? exact
          : actionable.filter((e) =>
              e.label?.toLowerCase().includes(selector.toLowerCase()),
            );
        if (state.degraded || state.truncated || matches.length !== 1)
          throw new ObservationError(
            "AX_NOT_UNIQUE",
            "AX query did not yield one complete current element",
          );
        const token = matches[0]!.elementToken;
        if (!token)
          throw new ObservationError(
            "AX_TOKEN_MISSING",
            "Current element has no actionable token",
          );
        await this.verifyHost(signal);
        const raw = await this.driver!.click(
          {
            session: this.session,
            target: new this.sdk.ActionTarget.Window({
              pid: app.pid,
              windowId: BigInt(window.id),
            }),
            position: new this.sdk.ClickPosition.Element({
              elementToken: token,
            }),
            deliveryMode:
              delivery === "background"
                ? this.sdk.InputDeliveryMode.Background
                : this.sdk.InputDeliveryMode.Foreground,
          },
          { signal },
        );
        const receipt: "acknowledged" | "unknown" | "refused" =
          raw.effect === this.sdk.ActionEffect.Refused
            ? "refused"
            : raw.delivery?.mode === this.sdk.ActionDeliveryMode.Unknown ||
                raw.effect === this.sdk.ActionEffect.Unverifiable
              ? "unknown"
              : "acknowledged";
        return { delivery: receipt, raw: JSON.parse(json(raw)) };
      }),
    );
    desktopInputs = work.catch(() => undefined);
    return work;
  }
  close(): Promise<void> {
    return (this.closePromise ??= (async () => {
      this.closing = true;
      await Promise.allSettled([...this.pending]);
      if (this.driver) {
        // Do not free a handle while shutdown is still executing.
        try {
          if (this.sessionStarted)
            await this.driver.endSession({ session: this.session });
        } finally {
          await this.driver.shutdown();
          this.driver.uniffiDestroy();
        }
      }
    })());
  }
}
