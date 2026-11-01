import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import type { Protocol } from "devtools-protocol";
import {
  ObservationError,
  issue,
  type CdpAdapter,
  type DesktopAdapter,
  type RuntimeDependencies,
  type Scene,
  type Scope,
  type Issue,
  type Frame,
  type Fact,
  type Validation,
  type CdpBinding,
  type DesktopBinding,
} from "./contracts.js";
import { ChromeCdpAdapter } from "./adapters/cdp.js";
import { CuaDesktopAdapter } from "./adapters/desktop.js";
import { ElectronCdpAdapter } from "./adapters/electron.js";
import { BundleWriter } from "./storage/writer.js";
import { systemClock, checkAbort, hash, collectorIdentity } from "./util.js";
import { parseScene, executeAction, waitCondition } from "./recipes.js";
import { bindDesktopRenderer } from "./targets.js";
import {
  captureSnapshot,
  readingFacts,
  readRenderer,
  type RendererReading,
} from "./capture/snapshot.js";
import {
  calibrateClock,
  intervals,
  type ClockMapping,
} from "./capture/clock.js";
import { coordinateMapping } from "./capture/mapping.js";
import { startTimeline } from "./capture/timeline.js";

interface Connection {
  desktop?: DesktopAdapter;
  cdp?: CdpAdapter;
  desktopBinding?: DesktopBinding;
  cdpBinding?: CdpBinding;
  association?: unknown;
  issues: Issue[];
}
async function connect(
  scene: Scene,
  deps: RuntimeDependencies,
): Promise<Connection> {
  const connection: Connection = { issues: [] };
  if (scene.target.desktop) {
    try {
      connection.desktop = (
        deps.desktop ?? (() => new CuaDesktopAdapter(scene.desktopHost))
      )();
      connection.desktopBinding = await connection.desktop.connect(
        scene.target.desktop,
      );
    } catch (e) {
      connection.issues.push(issue(e, "desktop"));
    }
  }
  if (scene.target.cdp) {
    try {
      connection.cdp = (
        deps.cdp ??
        (() =>
          scene.target.cdp?.transport === "electron-inspector"
            ? new ElectronCdpAdapter()
            : new ChromeCdpAdapter())
      )();
      connection.cdpBinding = await connection.cdp.connect(scene.target.cdp);
    } catch (e) {
      connection.issues.push(issue(e, "cdp"));
    }
  }
  if (connection.desktopBinding && connection.cdpBinding) {
    try {
      connection.association = await bindDesktopRenderer(
        connection.desktopBinding,
        connection.cdpBinding,
      );
    } catch (e) {
      connection.issues.push(issue(e, "binding"));
    }
  } else if (scene.target.desktop && scene.target.cdp)
    connection.issues.push({
      code: "ASSOCIATION_UNKNOWN",
      message:
        "Both requested channels are not bound; available channels are retained independently",
      scope: "binding",
    });
  return connection;
}
async function close(connection: Connection): Promise<Issue[]> {
  const issues: Issue[] = [];
  // Close renderer subscriptions first, then drain the native runtime.
  for (const adapter of [connection.cdp, connection.desktop])
    if (adapter)
      try {
        await adapter.close();
      } catch (e) {
        issues.push(issue(e, "shutdown"));
      }
  return issues;
}
export async function checkConnection(
  input: unknown,
  deps: RuntimeDependencies = {},
) {
  const scene = parseScene(input);
  let connection: Connection | undefined;
  try {
    connection = await connect(scene, deps);
    return {
      desktop: connection.desktopBinding ?? null,
      cdp: connection.cdpBinding ?? null,
      association: connection.association ?? null,
      issues: connection.issues,
      shutdown: await close(connection),
    };
  } catch (e) {
    if (connection) await close(connection);
    throw e;
  }
}

export async function captureScene(
  input: unknown,
  options: { outputDir: string; runId?: string; signal?: AbortSignal },
  deps: RuntimeDependencies = {},
) {
  const scene = parseScene(input);
  const clock = deps.clock ?? systemClock;
  const runId = options.runId ?? randomUUID();
  const writer = await (deps.writer ?? BundleWriter.create)(
    options.outputDir,
    runId,
    scene,
    clock,
  );
  let connection: Connection = { issues: [] };
  const issues: Issue[] = [];
  const validation: Validation[] = [];
  const frames: Frame[] = [];
  const facts: Fact[] = [];
  const clocks: ClockMapping[] = [];
  const channels: ("os" | "ax" | "renderer")[] = [];
  let outcome: "completed" | "partial" | "cancelled" | "failed" = "completed";
  let timeline: Awaited<ReturnType<typeof startTimeline>> | undefined;
  let timelineStats:
    | Awaited<ReturnType<Awaited<ReturnType<typeof startTimeline>>["stop"]>>
    | undefined;
  let removeEvents: (() => void) | undefined;
  let boundary: Issue | undefined;
  const assets: {
    kind: string;
    id: string;
    url: string;
    engineHash?: string;
    sha256?: string;
    path?: string;
    error?: string;
  }[] = [];
  let scope: Scope = {
    runId,
    targetId: "unbound",
    frameId: "none",
    documentId: "none",
    segment: 0,
  };
  const assertActive = () => {
    checkAbort(options.signal);
    if (boundary)
      throw new ObservationError(
        boundary.code,
        boundary.message,
        boundary.scope,
      );
  };
  try {
    await writer.write("tool.json", await collectorIdentity());
    checkAbort(options.signal);
    connection = await connect(scene, deps);
    checkAbort(options.signal);
    issues.push(...connection.issues);
    await writer.write("target.json", {
      desktop: connection.desktopBinding ?? null,
      cdp: connection.cdpBinding ?? null,
      association: connection.association ?? null,
    });
    if (!connection.cdpBinding && !connection.desktopBinding)
      throw new ObservationError(
        "NO_CHANNEL",
        "No exact target could be connected",
      );
    if (connection.desktop && connection.desktopBinding) {
      const start = clock.now();
      try {
        const snapshot = await connection.desktop.snapshot();
        const end = clock.now();
        await writer.write("os.json", {
          time: { requestStartMs: start, requestEndMs: end },
          ...snapshot,
          image: undefined,
        });
        issues.push(...snapshot.issues);
        if (snapshot.axAvailable) channels.push("ax");
        if (
          snapshot.image &&
          snapshot.width &&
          snapshot.height &&
          snapshot.mimeType
        ) {
          const path = `frames/os-0000.${snapshot.mimeType === "image/png" ? "png" : "jpg"}`;
          await writer.bytes(path, snapshot.image);
          channels.push("os");
          frames.push({
            path,
            channel: "os",
            mimeType: snapshot.mimeType,
            width: snapshot.width,
            height: snapshot.height,
            time: { hostMs: end, requestStartMs: start, requestEndMs: end },
            scope: {
              ...scope,
              targetId: `pid:${connection.desktopBinding.app.pid}/window:${connection.desktopBinding.window.id}`,
              documentId: "ax-snapshot",
            },
          });
        }
      } catch (e) {
        issues.push(issue(e, "desktop-capture"));
      }
    }
    if (connection.cdp && connection.cdpBinding) {
      const cdp = connection.cdp;
      const binding = connection.cdpBinding;
      scope = {
        runId,
        targetId: binding.targetId,
        frameId: binding.frameId,
        documentId: binding.documentId,
        segment: 0,
      };
      removeEvents = cdp.onEvent((event) => {
        const changedFrame =
          event.method === "Page.frameNavigated" &&
          (event.params.frame as { id?: string })?.id === binding.frameId;
        const replaced =
          event.method === "Runtime.executionContextsCleared" ||
          event.method === "Observation.disconnected" ||
          event.method === "Inspector.detached";
        if ((changedFrame || replaced) && !boundary) {
          boundary = {
            code: "SEGMENT_ENDED",
            message: `${event.method}; a new capture must resolve the target and document again`,
            scope: "timeline",
          };
          writer.record("events", { ...event, scope, segmentBoundary: true });
        }
        if (
          event.method === "Debugger.scriptParsed" &&
          event.params.url &&
          assets.length < 500
        )
          assets.push({
            kind: "script",
            id: String(event.params.scriptId),
            url: String(event.params.url),
            engineHash: String(event.params.hash ?? ""),
          });
        if (event.method === "CSS.styleSheetAdded" && assets.length < 500) {
          const h = event.params.header as {
            styleSheetId: string;
            sourceURL: string;
          };
          assets.push({ kind: "style", id: h.styleSheetId, url: h.sourceURL });
        }
        if (
          event.method.startsWith("Animation.") ||
          event.method.startsWith("DOM.")
        )
          writer.record("events", {
            ...event,
            scope,
            originalClock:
              "only protocol-provided fields; receivedHostMs is receipt time",
          });
      });
      // CSS.enable emitted initial headers before subscription; repeat disable /
      // enable to enumerate without fetching unrelated network resources.
      await cdp.send("CSS.disable");
      await cdp.send("CSS.enable");
      try {
        await cdp.send("Debugger.enable");
      } catch (e) {
        issues.push(issue(e, "assets"));
      }
      try {
        await cdp.send("Animation.enable");
      } catch (e) {
        issues.push(issue(e, "animation-events"));
      }
      for (const action of scene.entry) {
        assertActive();
        await executeAction(
          action,
          cdp,
          connection.desktop,
          clock,
          (d) => writer.record("actions", { phase: "entry", ...(d as object) }),
          options.signal,
        );
      }
      if (scene.ready)
        await waitCondition(cdp, scene.ready, clock, options.signal);
      assertActive();
      clocks.push(await calibrateClock(cdp, clock));
      const snapshotStart = clock.now();
      const snapshot = await captureSnapshot(
        cdp,
        scene.elements,
        scene.fullDocument,
      );
      const snapshotEnd = clock.now();
      assertActive();
      issues.push(...snapshot.issues);
      await writer.write("dom.json", snapshot.dom);
      await writer.write("styles.json", snapshot.styles);
      await writer.write("snapshot.json", snapshot.reading);
      facts.push(
        ...readingFacts(
          snapshot.reading,
          scope,
          {
            hostMs: snapshotEnd,
            requestStartMs: snapshotStart,
            requestEndMs: snapshotEnd,
          },
          "snapshot.json",
          "snapshot",
        ),
      );
      if (snapshot.reading.missing.length)
        issues.push({
          code: "ELEMENT_NOT_UNIQUE",
          message: JSON.stringify(snapshot.reading.missing),
          scope: "scene",
        });
      await writer.write("conditions.json", {
        ...scene.conditions,
        ...snapshot.reading.conditions,
        declared: {
          density: scene.conditions.density,
          dataState: scene.conditions.dataState,
          fontState: scene.conditions.fontState,
        },
      });
      for (const key of ["viewport", "dpr", "theme", "reducedMotion"] as const)
        if (scene.conditions[key] !== undefined) {
          const pass =
            JSON.stringify(scene.conditions[key]) ===
            JSON.stringify(snapshot.reading.conditions[key]);
          validation.push({
            id: `condition:${key}`,
            status: pass ? "pass" : "fail",
            reason: `requested=${JSON.stringify(scene.conditions[key])}; observed=${JSON.stringify(snapshot.reading.conditions[key])}`,
            evidence: ["scene.json", "snapshot.json"],
          });
          if (!pass)
            issues.push({
              code: "CONDITION_MISMATCH",
              message: key,
              scope: "conditions",
            });
        }
      const takeFrame = async () => {
        assertActive();
        const start = clock.now();
        const screenshot =
          await cdp.send<Protocol.Page.CaptureScreenshotResponse>(
            "Page.captureScreenshot",
            { format: "png", fromSurface: true, captureBeyondViewport: false },
          );
        const end = clock.now();
        assertActive();
        const data = Buffer.from(screenshot.data, "base64");
        const image = PNG.sync.read(data);
        const path = `frames/renderer-${String(frames.filter((f) => f.channel === "renderer").length).padStart(5, "0")}.png`;
        await writer.bytes(path, data);
        frames.push({
          path,
          channel: "renderer",
          mimeType: "image/png",
          width: image.width,
          height: image.height,
          scope,
          time: { hostMs: end, requestStartMs: start, requestEndMs: end },
        });
        return data;
      };
      const baseline = await takeFrame();
      channels.push("renderer");
      const mapping = coordinateMapping(snapshot.reading, baseline);
      await writer.write("mapping.json", mapping);
      facts.push({
        id: "calculated:mapping",
        element: "$scene",
        property: "mapping.cssToImage",
        value: mapping.cssToImage,
        unit: "image px / CSS px",
        scope,
        time: { hostMs: clock.now() },
        provenance: {
          kind: "calculated",
          method:
            "image dimensions / measured visual viewport, with viewport offset",
          evidence: [
            "mapping.json",
            "snapshot.json",
            frames.find((f) => f.channel === "renderer")!.path,
          ],
        },
      });
      validation.push({
        id: "coordinate-calibration",
        status: "unknown",
        reason: "No independent pixel anchors were provided for this scene",
        evidence: ["mapping.json"],
      });
      // Begin recording only after subscription registration, baseline capture,
      // clock mapping, and the renderer observer's ready acknowledgement.
      timeline = await startTimeline(
        cdp,
        scene.elements,
        scope,
        writer,
        clock,
        scene.maxRecords,
        () => !boundary,
        (element) => {
          boundary = {
            code: "SEGMENT_ENDED",
            message: `Semantic target ${element} was replaced; start a new capture to resolve its identity`,
            scope: "timeline",
          };
        },
      );
      const start = clock.now();
      let lastFrameStart = start;
      let midpointCalibrated = false;
      for (const action of scene.actions) {
        assertActive();
        await executeAction(
          action,
          cdp,
          connection.desktop,
          clock,
          (d) =>
            writer.record("actions", { phase: "recording", ...(d as object) }),
          options.signal,
        );
      }
      while (clock.now() - start < scene.durationMs) {
        assertActive();
        await clock.sleep(
          Math.max(0, scene.frameIntervalMs - (clock.now() - lastFrameStart)),
          options.signal,
        );
        if (clock.now() - start >= scene.durationMs) break;
        lastFrameStart = clock.now();
        await takeFrame();
        if (
          !midpointCalibrated &&
          clock.now() - start >= scene.durationMs / 2
        ) {
          clocks.push(await calibrateClock(cdp, clock));
          midpointCalibrated = true;
        }
      }
      assertActive();
      timelineStats = await timeline.stop();
      timeline = undefined;
      clocks.push(await calibrateClock(cdp, clock));
      await writer.write(
        "end-state.json",
        await cdp.evaluate<RendererReading>(
          `(${readRenderer.toString()})(${JSON.stringify(scene.elements)})`,
        ),
      );
      // Hash loaded relevant JS/CSS via the debugger APIs. Never re-fetch URLs
      // (which could have changed or mutate authenticated application state).
      for (const asset of assets) {
        try {
          const response =
            asset.kind === "script"
              ? await cdp.send<Protocol.Debugger.GetScriptSourceResponse>(
                  "Debugger.getScriptSource",
                  { scriptId: asset.id },
                )
              : await cdp.send<Protocol.CSS.GetStyleSheetTextResponse>(
                  "CSS.getStyleSheetText",
                  { styleSheetId: asset.id },
                );
          const value =
            "scriptSource" in response ? response.scriptSource : response.text;
          if (Buffer.byteLength(value) > 8 * 1024 * 1024) {
            asset.error = "Asset exceeds 8 MiB capture limit";
            continue;
          }
          asset.sha256 = hash(value);
          asset.path = `assets/${asset.sha256}.${asset.kind === "script" ? "js" : "css"}`;
          if (
            !assets.some(
              (a) => a !== asset && a.path === asset.path && a.sha256,
            )
          )
            await writer.bytes(asset.path, Buffer.from(value));
        } catch (e) {
          asset.error = String(e);
          issues.push(issue(e, "asset"));
        }
      }
    } else {
      issues.push({
        code: "RENDERER_UNAVAILABLE",
        message:
          "DOM, styles, renderer frames and motion remain unknown; only OS/AX observations are available",
        scope: "renderer",
      });
      validation.push({
        id: "renderer",
        status: "unknown",
        reason: "No CDP channel",
        evidence: ["target.json"],
      });
    }
  } catch (error) {
    issues.push(issue(error));
    outcome = options.signal?.aborted
      ? "cancelled"
      : channels.length
        ? "partial"
        : "failed";
  } finally {
    if (timeline) {
      try {
        timelineStats = await timeline.stop();
      } catch (e) {
        issues.push(issue(e, "timeline-stop"));
      }
    }
    removeEvents?.();
    issues.push(...(await close(connection)));
  }
  if (timelineStats) {
    const precise =
      timelineStats.complete &&
      timelineStats.intervals.maxGapMs !== null &&
      timelineStats.intervals.maxGapMs <= scene.maxSampleGapMs;
    validation.push({
      id: "timeline-continuity",
      status: precise ? "pass" : "unknown",
      reason: `complete=${timelineStats.complete}; max gap=${timelineStats.intervals.maxGapMs}ms; allowed=${scene.maxSampleGapMs}ms`,
      evidence: ["timeline.json", "samples.jsonl", "clock.json"],
    });
    if (!timelineStats.complete)
      issues.push({
        code: "TIMELINE_INCOMPLETE",
        message:
          "Origin and receiver sequences or buffer limits do not establish complete recording",
        scope: "timeline",
      });
  }
  if (boundary && !issues.some((i) => i.code === boundary!.code))
    issues.push(boundary);
  await writer.write("timeline.json", {
    ...timelineStats,
    requestedFrameIntervalMs: scene.frameIntervalMs,
    frames: intervals(
      frames
        .filter((f) => f.channel === "renderer")
        .map((f) => f.time.requestStartMs!),
    ),
    clockInterpretation:
      "Host receipts, renderer occurrences and capture request intervals are distinct",
  });
  await writer.write("facts.json", facts);
  await writer.write("frames.json", frames);
  await writer.write("clock.json", clocks);
  await writer.write("assets.json", {
    assets,
    scope:
      "up to 500 loaded scripts/styles in the bound session; source hashes do not prove an external source checkout matches",
    limitReached: assets.length >= 500,
  });
  validation.push({
    id: "source-correspondence",
    status: "unknown",
    reason: "No confirmed source mapping has been attached to this run",
    evidence: ["assets.json"],
  });
  if (outcome === "completed" && issues.length) outcome = "partial";
  return await writer.finish({ outcome, channels, issues, validation });
}
