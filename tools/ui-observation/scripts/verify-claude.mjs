import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import CDP from "chrome-remote-interface";
import {
  captureScene,
  checkConnection,
  BundleReader,
  queryBundle,
  exportReference,
  createViewer,
  inspectElectron,
  parseScene,
} from "@radix/ui-observation";
import { ElectronCdpAdapter } from "../dist/adapters/index.js";

const scene = parseScene(JSON.parse(await readFile(process.argv[2], "utf8"))),
  root = resolve(process.argv[3]);
await mkdir(root);
const checks = [];
const record = (name, details = {}) => {
  checks.push({ name, status: "pass", ...details });
  console.log(JSON.stringify(checks.at(-1)));
};
const main = async (expression) => {
  const client = await CDP({ target: scene.target.cdp.endpoint, local: true });
  try {
    const r = await client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.text);
    return r.result.value;
  } finally {
    await client.close();
  }
};
let owned;
try {
  const wrongPid = await checkConnection({
    ...scene,
    target: {
      cdp: {
        ...scene.target.cdp,
        expectedPid: scene.target.cdp.expectedPid + 1,
      },
    },
  });
  assert.ok(wrongPid.issues.some((i) => i.code === "ENDPOINT_OWNER_MISMATCH"));
  record("wrong-inspector-process-rejected");
  const inventory = await inspectElectron(
    scene.target.cdp.transport === "electron-inspector"
      ? {
          endpoint: scene.target.cdp.endpoint,
          expectedPid: scene.target.cdp.expectedPid,
        }
      : {},
  );
  const shell = inventory.webContents.find(
    (w) =>
      w.owner === scene.target.cdp.browserWindowId &&
      w.url.startsWith("file://"),
  );
  assert.ok(shell);
  const wrongRenderer = await checkConnection({
    ...scene,
    target: { cdp: { ...scene.target.cdp, webContentsId: shell.id } },
  });
  assert.ok(
    wrongRenderer.issues.some((i) => i.message.includes("Exact renderer URL")),
  );
  record("local-shell-rejected-for-hosted-scene");
  const globalNames = await main(
    'Object.getOwnPropertyNames(globalThis).filter(k=>k.startsWith("__radix_"))',
  );
  owned = new ElectronCdpAdapter();
  await owned.connect(scene.target.cdp);
  const busy = await checkConnection({
    ...scene,
    target: { cdp: scene.target.cdp },
  });
  assert.ok(busy.issues.some((i) => i.message.includes("already attached")));
  assert.equal(await owned.evaluate("document.readyState"), "complete");
  await owned.close();
  owned = undefined;
  record("existing-debugger-preserved");
  owned = new ElectronCdpAdapter();
  await owned.connect(scene.target.cdp);
  const replacement = `process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json')('electron').webContents.fromId(${scene.target.cdp.webContentsId})`;
  try {
    await main(
      `(()=>{const w=${replacement};w.debugger.detach();w.debugger.attach('1.3');return w.debugger.isAttached()})()`,
    );
    await assert.rejects(
      () => owned.evaluate("document.readyState"),
      /Renderer binding ended/,
    );
    await owned.close();
    owned = undefined;
    assert.equal(await main(`${replacement}.debugger.isAttached()`), true);
  } finally {
    await main(
      `(()=>{const w=${replacement};if(w.debugger.isAttached())w.debugger.detach();return true})()`,
    );
  }
  record("replacement-debugger-not-detached-by-old-owner");
  const run = await captureScene(scene, { outputDir: root, runId: "chat-10s" });
  assert.equal(
    run.manifest.outcome,
    "completed",
    JSON.stringify(run.manifest.issues),
  );
  assert.deepEqual(
    new Set(run.manifest.channels),
    new Set(["renderer", "os", "ax"]),
  );
  const reader = await BundleReader.open(run.path),
    frames = await reader.frames(),
    timeline = await reader.json("timeline.json"),
    target = await reader.json("target.json");
  assert.equal(target.association.status, "pass");
  assert.equal(target.cdp.owner.webContentsId, scene.target.cdp.webContentsId);
  assert.ok(timeline.intervals.count > 1);
  assert.equal(timeline.complete, true);
  record("public-api-capture-completed", {
    path: run.path,
    manifestHash: reader.manifestHash,
    rendererFrames: frames.filter((f) => f.channel === "renderer").length,
    osFrames: frames.filter((f) => f.channel === "os").length,
    samples: timeline.intervals.count,
    maxSampleGapMs: timeline.intervals.maxGapMs,
    maxFrameGapMs: timeline.frames.maxGapMs,
  });
  const q = await queryBundle(run.path, {
    elements: ["composer"],
    properties: [
      "rect.width",
      "rect.height",
      "style.font-size",
      "style.opacity",
    ],
    limit: 4,
  });
  assert.equal(q.facts.length, 4);
  record("stored-observation-query", {
    facts: q.facts.map((f) => ({
      property: f.property,
      value: f.value,
      kind: f.provenance.kind,
    })),
  });
  const after = await inspectElectron({
    endpoint: scene.target.cdp.endpoint,
    expectedPid: scene.target.cdp.expectedPid,
  });
  assert.equal(
    after.webContents.find((w) => w.id === scene.target.cdp.webContentsId)
      .debuggerAttached,
    false,
  );
  const afterGlobals = await main(
    'Object.getOwnPropertyNames(globalThis).filter(k=>k.startsWith("__radix_"))',
  );
  assert.deepEqual(afterGlobals, globalNames);
  record("owned-renderer-debugger-and-bridge-cleaned");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  const cancelled = await captureScene(scene, {
    outputDir: root,
    runId: "cancelled",
    signal: controller.signal,
  });
  clearTimeout(timer);
  assert.equal(cancelled.manifest.outcome, "cancelled");
  await BundleReader.open(cancelled.path);
  record("cancelled-real-capture-remains-readable");
  const exported = await exportReference(run.path, {
    outputDir: join(root, "reference"),
    query: {
      elements: ["composer"],
      properties: [
        "rect.width",
        "rect.height",
        "style.font-size",
        "style.opacity",
      ],
      limit: 100,
      maxBytes: 100000,
    },
    maxPages: 1,
    intent: {
      task: "Preserve the observed composer geometry and typography in a later implementation",
      owner: "ui-observation developer tooling",
      conditions: ["viewport", "dpr", "theme", "reducedMotion"],
      checks: [
        {
          id: "composer-width",
          intent: "maintain",
          referenceElement: "composer",
          implementationElement: "composer",
          property: "rect.width",
          tolerance: 2,
          reason: "Original observed composer width",
        },
      ],
      humanReview:
        "Application feature semantics and visual hierarchy require a separate implementation task",
    },
  });
  await createViewer(run.path, join(root, "viewer.html"));
  record("reference-export-and-offline-viewer", {
    referenceHash: exported.sha256,
    omissions: exported.omissions,
  });
  await writeFile(
    join(root, "verification.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        status: "pass",
        call: "captureScene(scene, {outputDir, runId})",
        mcpClientUsed: false,
        checks,
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  await writeFile(
    join(root, "verification.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        status: "fail",
        error: String(error),
        checks,
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await owned?.close();
}
