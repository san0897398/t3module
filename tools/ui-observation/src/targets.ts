import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  ObservationError,
  type CdpBinding,
  type DesktopBinding,
} from "./contracts.js";
const exec = promisify(execFile);
export async function assertEndpointOwner(
  endpoint: string,
  expectedPid: number,
) {
  const url = new URL(endpoint);
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password
  )
    throw new ObservationError(
      "ENDPOINT_NOT_LOCAL",
      "Expected an explicit loopback WebSocket endpoint",
    );
  const { stdout } = await exec(
    "/usr/sbin/lsof",
    ["-nP", "-a", `-iTCP:${url.port}`, "-sTCP:LISTEN", "-Fp"],
    { timeout: 5000 },
  );
  const pids = [
    ...new Set(
      stdout
        .split("\n")
        .filter((l) => /^p\d+$/.test(l))
        .map((l) => Number(l.slice(1))),
    ),
  ];
  if (pids.length !== 1 || pids[0] !== expectedPid)
    throw new ObservationError(
      "ENDPOINT_OWNER_MISMATCH",
      `Endpoint PID ${pids.join(",")} does not match ${expectedPid}`,
    );
  return pids[0]!;
}
export async function bindDesktopRenderer(
  desktop: DesktopBinding,
  cdp: CdpBinding,
) {
  const port = new URL(cdp.endpoint).port;
  if (!port || !cdp.window)
    throw new ObservationError(
      "ASSOCIATION_UNKNOWN",
      "No endpoint port or CDP window geometry for OS/renderer association",
      "binding",
    );
  const endpointPid = await assertEndpointOwner(cdp.endpoint, desktop.app.pid);
  if (
    cdp.owner &&
    (cdp.owner.pid !== desktop.app.pid ||
      cdp.owner.browserWindowId !== cdp.window.id)
  )
    throw new ObservationError(
      "WINDOW_RENDERER_MISMATCH",
      "Electron ownership changed",
    );
  const a = desktop.window.bounds,
    b = cdp.window.bounds;
  const errors = ["x", "y", "width", "height"].map((k) =>
    Math.abs(a[k as keyof typeof a] - b[k as keyof typeof b]),
  );
  if (
    Math.max(...errors) > 2 ||
    desktop.window.title !== (cdp.window.title ?? cdp.title)
  )
    throw new ObservationError(
      "WINDOW_RENDERER_MISMATCH",
      "OS/CDP title or window geometry differs; no guessed pairing",
      "binding",
    );
  return {
    status: "pass",
    method:
      "exact endpoint owner PID + selected target title + OS/CDP window bounds",
    endpointPid,
    geometryErrorMaxCssOrOsUnits: Math.max(...errors),
    osWindowId: desktop.window.id,
    cdpWindowId: cdp.window.id,
    targetId: cdp.targetId,
    frameId: cdp.frameId,
    electronOwner: cdp.owner,
  };
}
