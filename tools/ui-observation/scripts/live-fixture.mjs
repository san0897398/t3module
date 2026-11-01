import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { startFixture } from "./fixture-host.mjs";
import {
  captureScene,
  checkConnection,
  BundleReader,
  queryBundle,
  exportReference,
  compareBundles,
  createViewer,
} from "../dist/index.js";
import { validateMapping } from "../dist/capture/mapping.js";
const digest = (data) => createHash("sha256").update(data).digest("hex");
const output = resolve(process.argv[2] ?? `captures/live-${Date.now()}`);
await mkdir(output, { recursive: true });
const host = await startFixture();
let closed = false;
const results = { at: new Date().toISOString(), output, checks: [] };
const recipe = JSON.parse(
  await readFile(new URL("../recipes/fixture.json", import.meta.url), "utf8"),
);
recipe.target.cdp = host.selection;
const expected = JSON.parse(
  await readFile(
    new URL("../tests/fixtures/lineage/expected.json", import.meta.url),
    "utf8",
  ),
);
const report = (name, value) => {
  results.checks.push({ name, ...value });
  console.log(JSON.stringify({ name, ...value }));
};
async function capture(id, overrides = {}) {
  const result = await captureScene(
    { ...recipe, ...overrides },
    { outputDir: output, runId: id },
  );
  assert.equal(
    result.manifest.outcome,
    "completed",
    JSON.stringify(result.manifest.issues),
  );
  return result.path;
}
function pixelCenters(image) {
  const seen = new Set(),
    centers = [];
  const hit = (x, y) => {
    const i = (y * image.width + x) * 4;
    return (
      image.data[i] === 255 &&
      image.data[i + 1] === 0 &&
      image.data[i + 2] === 255
    );
  };
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const key = y * image.width + x;
      if (seen.has(key) || !hit(x, y)) continue;
      const queue = [[x, y]];
      seen.add(key);
      let sx = 0,
        sy = 0,
        n = 0;
      for (let j = 0; j < queue.length; j++) {
        const [a, b] = queue[j];
        sx += a + 0.5;
        sy += b + 0.5;
        n++;
        for (const [c, d] of [
          [a - 1, b],
          [a + 1, b],
          [a, b - 1],
          [a, b + 1],
        ])
          if (
            c >= 0 &&
            c < image.width &&
            d >= 0 &&
            d < image.height &&
            !seen.has(d * image.width + c) &&
            hit(c, d)
          ) {
            seen.add(d * image.width + c);
            queue.push([c, d]);
          }
      }
      centers.push({ x: sx / n, y: sy / n });
    }
  return centers.sort((a, b) =>
    Math.abs(a.y - b.y) > 1 ? a.y - b.y : a.x - b.x,
  );
}
async function geometry(path, scroll = 0) {
  const r = await BundleReader.open(path);
  const f = (await r.frames()).find((f) => f.channel === "renderer");
  const pixels = pixelCenters(PNG.sync.read(await r.bytes(f.path)));
  assert.equal(pixels.length, 20);
  const mapping = await r.json("mapping.json");
  const anchors = expected.anchorCssCenters.map(([x, y], i) => ({
    css: { x, y: y - scroll },
    pixel: pixels[i],
    evidence: `${f.path}:magenta-component-${i}`,
  }));
  const result = validateMapping(mapping.cssToImage, anchors, 2);
  assert.equal(result.status, "pass");
  return result;
}
try {
  const connection = await checkConnection(recipe);
  assert.equal(connection.issues.length, 0);
  assert.equal(connection.shutdown.length, 0);
  report("exact-cdp-target", {
    status: "pass",
    target: connection.cdp.targetId,
  });
  const wrong = await checkConnection({
    ...recipe,
    target: { cdp: { ...host.selection, expectedUrl: host.url + "wrong" } },
  });
  assert.ok(wrong.issues.some((i) => i.code === "TARGET_MISMATCH"));
  report("wrong-target-rejected", { status: "pass" });
  const baselineCosts = await host.adapter.evaluate(
    "new Promise(resolve=>{const t=[];let previous=performance.now();function f(now){t.push(now-previous);previous=now;if(t.length<60)requestAnimationFrame(f);else resolve(t)}requestAnimationFrame(f)})",
  );
  const first = await capture("reference");
  report("geometry-dpr2", await geometry(first));
  const reader = await BundleReader.open(first);
  const snapshots = await reader.json("facts.json");
  const value = (e, p) =>
    snapshots.find((f) => f.element === e && f.property === p)?.value;
  assert.equal(value("beam", "attribute.stroke-opacity"), expected.beamOpacity);
  assert.equal(value("pseudo::after", "style.opacity"), expected.pseudoOpacity);
  assert.equal(value("pseudo", "style.opacity"), expected.wrapperOpacity);
  assert.equal(value("child", "attribute.data-parent-id"), expected.parentId);
  const motion = await queryBundle(first, {
    elements: ["motion"],
    properties: ["style.opacity"],
    limit: 1000,
    maxBytes: 1048576,
  });
  assert.ok(new Set(motion.facts.map((f) => f.value)).size > 10);
  report("styles-relations-css-motion", {
    status: "pass",
    distinctOpacityValues: new Set(motion.facts.map((f) => f.value)).size,
  });
  const timeline = await reader.json("timeline.json");
  assert.equal(timeline.complete, true);
  report("time-and-sequence", {
    status: "pass",
    samples: timeline.intervals.count,
    maxSampleGapMs: timeline.intervals.maxGapMs,
    maxFrameGapMs: timeline.frames.maxGapMs,
    requestedFrameIntervalMs: timeline.requestedFrameIntervalMs,
    baselineRafMeanMs:
      baselineCosts.reduce((a, b) => a + b, 0) / baselineCosts.length,
    observerMeanCostMs:
      timeline.source.costsMs.reduce((a, b) => a + b, 0) /
      timeline.source.costsMs.length,
  });
  const intent = {
    task: "Preserve fixture row geometry, native parent attribute and original opacity",
    owner: "ui-observation fixture",
    conditions: [
      "viewport",
      "dpr",
      "theme",
      "reducedMotion",
      "density",
      "dataState",
      "fontState",
      "scroll",
      "zoom",
    ],
    checks: [
      {
        id: "parent",
        intent: "maintain",
        referenceElement: "child",
        implementationElement: "child",
        property: "attribute.data-parent-id",
        tolerance: 0,
        reason: "Actual fixed parent data",
      },
      {
        id: "opacity",
        intent: "maintain",
        referenceElement: "beam",
        implementationElement: "beam",
        property: "attribute.stroke-opacity",
        tolerance: 0,
        reason: "Original opacity is retained",
      },
      {
        id: "geometry",
        intent: "maintain",
        referenceElement: "child",
        implementationElement: "child",
        property: "rect.width",
        tolerance: 2,
        reason: "Same viewport and fixed props",
      },
    ],
    humanReview:
      "Fixture diagnostics only; no claim of real application acceptance",
  };
  const sourcePath = resolve("tests/fixtures/lineage/style.css"),
    sourceBytes = await readFile(sourcePath);
  const exported = await exportReference(first, {
    outputDir: join(output, "reference-export"),
    intent,
    query: {
      elements: ["child", "beam", "pseudo::after"],
      limit: 1000,
      maxBytes: 1048576,
    },
    sources: [
      {
        element: "pseudo::after",
        property: "style.opacity",
        value: "0.4",
        unit: "CSS serialized value",
        path: sourcePath,
        startLine: 1,
        endLine: sourceBytes.toString().split("\n").length,
        sha256: digest(sourceBytes),
        revision: "fixture-1",
        actor: "live-fixture verifier",
        method: "read pinned CSS declaration",
        conditions: "fixture theme",
        loadedAssetSha256: digest(host.css),
      },
    ],
  });
  const second = await capture("implementation");
  const comparison = await compareBundles(exported.path, second);
  assert.equal(comparison.outcome, "automated-checks-pass");
  assert.ok(comparison.checks.every((c) => c.status === "pass"));
  report("frozen-reference-and-repeat", {
    status: "pass",
    referenceHash: exported.sha256,
    comparison: comparison.outcome,
  });
  await writeFile(
    join(output, "comparison.json"),
    JSON.stringify(comparison, null, 2),
  );
  const action = await capture("collapse", {
    durationMs: 400,
    actions: [
      {
        kind: "cdp-click",
        selector: "#family button",
        after: {
          selector: "#family button",
          attribute: "aria-expanded",
          equals: "false",
          timeoutMs: 2000,
        },
      },
    ],
  });
  const actionReader = await BundleReader.open(action);
  const actions = [];
  for await (const a of actionReader.records("actions.jsonl")) actions.push(a);
  assert.equal(actions[0].data.postcondition, "observed");
  report("prepared-input-and-postcondition", { status: "pass" });
  await host.adapter.evaluate(
    'document.querySelector("#family button").click()',
  );
  await host.adapter.evaluate(
    'for(const animation of document.querySelector("#css-motion").getAnimations()){animation.pause();animation.currentTime=500}',
  );
  const controlled = await capture("controlled-clock", {
    durationMs: 200,
    conditions: {
      ...recipe.conditions,
      dataState: "fixture-only paused CSS clock at 500ms",
    },
  });
  const controlledFacts = await (
    await BundleReader.open(controlled)
  ).json("facts.json");
  const controlledOpacity = Number(
    controlledFacts.find(
      (f) => f.element === "motion" && f.property === "style.opacity",
    ).value,
  );
  assert.ok(Math.abs(controlledOpacity - 0.35) < 0.001);
  report("independent-controlled-fixture-clock", {
    status: "pass",
    clockMs: 500,
    expectedOpacity: 0.35,
    observedOpacity: controlledOpacity,
  });
  await host.adapter.evaluate(
    'for(const animation of document.querySelector("#css-motion").getAnimations())animation.play()',
  );
  await host.adapter.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "light" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
  const reduced = await capture("reduced-motion", {
    durationMs: 200,
    conditions: { ...recipe.conditions, reducedMotion: true },
  });
  const reducedFacts = await (
    await BundleReader.open(reduced)
  ).json("facts.json");
  assert.equal(
    reducedFacts.find(
      (f) => f.element === "motion" && f.property === "style.opacity",
    ).value,
    "1",
  );
  report("reduced-motion", { status: "pass" });
  await host.adapter.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "light" },
      { name: "prefers-reduced-motion", value: "no-preference" },
    ],
  });
  await host.adapter.send("Emulation.setDeviceMetricsOverride", {
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await host.adapter.evaluate(
    'document.body.style.minHeight="1000px";scrollTo(0,100)',
  );
  const scrolled = await capture("scrolled", {
    durationMs: 300,
    conditions: { ...recipe.conditions, dpr: 1 },
  });
  report("geometry-dpr1-scroll100", await geometry(scrolled, 100));
  await host.adapter.send("Emulation.setPageScaleFactor", {
    pageScaleFactor: 1.25,
  });
  const zoomed = await capture("zoomed", {
    durationMs: 300,
    conditions: { ...recipe.conditions, dpr: 1 },
  });
  report("geometry-zoom125", await geometry(zoomed, 100));
  await host.adapter.send("Emulation.setPageScaleFactor", {
    pageScaleFactor: 1,
  });
  await host.adapter.evaluate("scrollTo(0,0)");
  await host.adapter.send("Emulation.setDeviceMetricsOverride", {
    width: 800,
    height: 600,
    deviceScaleFactor: 2,
    mobile: false,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 450);
  const cancelled = await captureScene(
    { ...recipe, durationMs: 10000 },
    { outputDir: output, runId: "cancelled", signal: controller.signal },
  );
  clearTimeout(timer);
  assert.equal(cancelled.manifest.outcome, "cancelled");
  await BundleReader.open(cancelled.path);
  report("cancellation-and-reopen", { status: "pass" });
  const navigation = setTimeout(
    () =>
      host.adapter
        .send("Page.navigate", { url: host.url + "?new-document" })
        .catch(() => {}),
    450,
  );
  const interrupted = await captureScene(
    { ...recipe, durationMs: 10000 },
    { outputDir: output, runId: "navigation" },
  );
  clearTimeout(navigation);
  assert.equal(interrupted.manifest.outcome, "partial");
  assert.ok(
    interrupted.manifest.issues.some((i) => i.code === "SEGMENT_ENDED"),
  );
  report("document-boundary", { status: "pass" });
  await host.close();
  closed = true;
  await createViewer(first, join(output, "viewer.html"), second);
  await queryBundle(first, { elements: ["beam"], limit: 3 });
  await compareBundles(exported.path, second);
  report("offline-reopen-viewer-compare", {
    status: "pass",
    browserClosed: true,
  });
  results.status = "pass";
  results.runs = { first, second };
} catch (error) {
  results.status = "fail";
  results.error = String(error);
  throw error;
} finally {
  if (!closed) await host.close();
  await writeFile(
    join(output, "verification.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
}
