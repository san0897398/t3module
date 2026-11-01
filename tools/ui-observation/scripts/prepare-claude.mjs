import { CuaDriver } from "@trycua/cua-driver";
import { readFile, writeFile } from "node:fs/promises";
import { inspectElectron } from "../dist/index.js";

const output = process.argv[2];
if (!output)
  throw Error(
    "Usage: node scripts/prepare-claude.mjs NEW_SCENE_JSON [--enable-inspector]",
  );
const enable = process.argv.includes("--enable-inspector");
const d = CuaDriver.connect();
const session = `ui-observation-prepare-${Date.now()}`;
let prior;
let activationAttempted = false;
const receipt = {
  at: new Date().toISOString(),
  enabledInspector: false,
  steps: [],
};
const discovery = async () =>
  fetch("http://127.0.0.1:9229/json/list", { signal: AbortSignal.timeout(750) })
    .then((r) => r.json())
    .catch(() => null);
try {
  const host = await d.metadata();
  await d.startSession({ session });
  const apps = await d.listApps({});
  prior = apps.apps.find((a) => a.active);
  const matches = apps.apps.filter(
    (a) => a.running && a.bundleId === "com.anthropic.claudefordesktop",
  );
  if (matches.length !== 1)
    throw Error("Start exactly one Claude instance normally");
  const app = matches[0],
    windows = (await d.listWindows({ pid: app.pid })).windows.filter(
      (w) => w.title === "Claude",
    );
  if (windows.length !== 1) throw Error("Claude window title is ambiguous");
  const window = windows[0];
  let targets = await discovery();
  if (!targets && enable) {
    // Only the app's observed, built-in menu is used. No startup flag or patch.
    const first = await d.invokeMenu({
      pid: app.pid,
      windowId: window.windowId,
      path: ["개발자", "Enable Main Process Debugger"],
      session,
    });
    receipt.steps.push({
      action: "invoke-inspector-menu",
      isError: first.isError,
      text: first.text,
    });
    targets = await discovery();
    if (
      !targets &&
      first.isError &&
      first.text.includes("target accessibility window is unavailable")
    ) {
      activationAttempted = true;
      const activation = await d.callTool(
        "bring_to_front",
        JSON.stringify({
          pid: app.pid,
          window_id: Number(window.windowId),
          session,
        }),
      );
      receipt.steps.push({
        action: "activate-exact-window",
        isError: activation.isError,
        result: activation.structuredJson
          ? JSON.parse(activation.structuredJson)
          : activation.text,
      });
      const snapshot = await d.callTool(
        "get_window_state",
        JSON.stringify({
          pid: app.pid,
          window_id: Number(window.windowId),
          session,
          query: "Enable Main Process Debugger",
          include_accessibility_tree: true,
          include_screenshot: false,
          max_elements: 2000,
        }),
      );
      const raw = JSON.parse(snapshot.structuredJson ?? "null");
      if (
        snapshot.isError ||
        raw?.pid !== app.pid ||
        String(raw.window_id) !== String(window.windowId) ||
        !raw.elements?.some(
          (e) => e.label === "Enable Main Process Debugger" && e.enabled,
        )
      )
        throw Error(
          "Inspector menu/target could not be independently verified",
        );
      const retry = await d.invokeMenu({
        pid: app.pid,
        windowId: window.windowId,
        path: ["개발자", "Enable Main Process Debugger"],
        session,
      });
      receipt.steps.push({
        action: "invoke-inspector-after-readback",
        isError: retry.isError,
        text: retry.text,
      });
    }
    for (let n = 0; n < 30 && !targets; n++) {
      targets = await discovery();
      if (!targets) await new Promise((r) => setTimeout(r, 100));
    }
    receipt.enabledInspector = !!targets;
  }
  if (
    !Array.isArray(targets) ||
    targets.length !== 1 ||
    targets[0].type !== "node"
  )
    throw Error(
      "No unique Node Inspector. Enable the built-in Developer Mode, then use --enable-inspector.",
    );
  const endpoint = targets[0].webSocketDebuggerUrl;
  const inventory = await inspectElectron({ endpoint, expectedPid: app.pid });
  const owners = inventory.windows.filter(
    (w) =>
      w.title === window.title &&
      ["x", "y", "width", "height"].every(
        (k) => Math.abs(w.bounds[k] - window.bounds[k]) <= 2,
      ),
  );
  if (owners.length !== 1)
    throw Error("OS/Electron window association is ambiguous");
  const renderers = inventory.webContents.filter(
    (w) => w.owner === owners[0].id && w.url === "https://claude.ai/new",
  );
  if (renderers.length !== 1)
    throw Error(
      "Open the new Chat scene; do not substitute a shell or another conversation",
    );
  const scene = JSON.parse(
    await readFile(
      new URL("../recipes/claude-chat.json", import.meta.url),
      "utf8",
    ),
  );
  scene.desktopHost = {
    mode: "daemon",
    socketPath: d.socketPath(),
    expectedPid: host.pid,
    expectedVersion: host.driverVersion,
  };
  scene.target.desktop = {
    bundleId: app.bundleId,
    pid: app.pid,
    windowId: String(window.windowId),
    title: window.title,
  };
  scene.target.cdp = {
    transport: "electron-inspector",
    endpoint,
    expectedPid: app.pid,
    browserWindowId: owners[0].id,
    webContentsId: renderers[0].id,
    expectedUrl: renderers[0].url,
    expectedTitle: renderers[0].title,
  };
  await writeFile(output, JSON.stringify(scene, null, 2) + "\n", {
    flag: "wx",
  });
  Object.assign(receipt, {
    host,
    endpoint,
    applicationPid: app.pid,
    windowId: String(window.windowId),
    renderer: scene.target.cdp,
  });
  console.log(
    JSON.stringify(
      {
        scene: output,
        enabledInspector: receipt.enabledInspector,
        target: scene.target.cdp,
      },
      null,
      2,
    ),
  );
} finally {
  if (activationAttempted && prior) {
    const restored = await d.callTool(
      "bring_to_front",
      JSON.stringify({ pid: prior.pid, session }),
    );
    receipt.steps.push({
      action: "restore-previous-app",
      pid: prior.pid,
      isError: restored.isError,
    });
  }
  await d.endSession({ session }).catch(() => {});
  await d.shutdown();
  d.uniffiDestroy();
  await writeFile(
    output + ".preparation.json",
    JSON.stringify(
      receipt,
      (_, v) => (typeof v === "bigint" ? String(v) : v),
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
