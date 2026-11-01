import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  cp,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  BundleWriter,
  BundleReader,
  inspectBundle,
  queryBundle,
  exportReference,
  readReference,
  compareBundles,
  parseScene,
  checkConnection,
  captureScene,
  ObservationError,
  IntentSchema,
} from "../dist/index.js";
import { executeAction } from "../dist/recipes.js";
import { localEndpoint } from "../dist/adapters/cdp.js";
import { systemClock } from "../dist/util.js";
import { startTimeline } from "../dist/capture/timeline.js";
import { desktopVersions } from "../dist/adapters/versions.js";
const hash = (b) => createHash("sha256").update(b).digest("hex");
test(
  "ESM-only native SDK resolves its actual paired binary version",
  { skip: process.platform !== "darwin" || process.arch !== "arm64" },
  async () => {
    const inventory = await desktopVersions();
    assert.equal(inventory.version, inventory.nativeVersion);
    assert.match(inventory.librarySha256, /^[a-f0-9]{64}$/);
    assert.equal(inventory.mode, "embedded");
  },
);
test("time coverage includes a stalled final rAF interval", async () => {
  let callback,
    name,
    started = false;
  const cdp = {
    onEvent: (fn) => {
      callback = fn;
      return () => {};
    },
    send: async (method, params) => {
      if (method === "Runtime.addBinding") name = params.name;
    },
    evaluate: async () => {
      if (!started) {
        started = true;
        callback({
          method: "Runtime.bindingCalled",
          params: {
            name,
            payload: JSON.stringify({
              sequence: 1,
              kind: "sample",
              reading: {
                rendererMs: 1,
                rendererTimeOriginMs: 0,
                elements: [],
                missing: [],
              },
            }),
          },
        });
        return { ready: true, rendererMs: 0 };
      }
      return { lastSequence: 1, capped: 0, costsMs: [], rendererMs: 500 };
    },
  };
  const timeline = await startTimeline(
    cdp,
    [],
    { runId: "r", targetId: "t", frameId: "f", documentId: "d", segment: 0 },
    { record: () => true },
    systemClock,
    10,
  );
  const stats = await timeline.stop();
  assert.equal(stats.intervals.maxGapMs, 499);
  assert.equal(stats.coverage.trailingGapMs, 499);
});
const scene = parseScene({
  version: 1,
  id: "known-answer",
  revision: "1",
  target: {
    cdp: {
      endpoint: "ws://127.0.0.1:9222/devtools/browser/known",
      targetId: "known",
      expectedUrl: "http://localhost/",
    },
  },
  elements: [{ key: "row", selector: "#row", properties: ["opacity"] }],
  conditions: { density: "fixed", dataState: "fixed", fontState: "fixed" },
  durationMs: 0,
});
const conditions = {
  ...scene.conditions,
  viewport: { width: 800, height: 600 },
  dpr: 1,
  theme: "light",
  reducedMotion: false,
  fonts: [],
  scroll: { x: 0, y: 0 },
  zoom: 1,
};
const intent = {
  task: "Maintain actual parent and opacity",
  owner: "fixture",
  conditions: ["viewport"],
  checks: [
    {
      id: "opacity",
      intent: "maintain",
      referenceElement: "row",
      implementationElement: "row",
      property: "style.opacity",
      reason: "original opacity",
      tolerance: 0,
    },
  ],
  humanReview: "not performed",
};
function fact(run, id, value, kind = "observed") {
  return {
    id: `snapshot:${id}`,
    element: "row",
    property: "style.opacity",
    value,
    unit: "ratio",
    scope: {
      runId: run,
      targetId: "known",
      frameId: "frame",
      documentId: "doc",
      segment: 0,
    },
    time: { hostMs: 10, rendererMs: 5 },
    provenance: {
      kind,
      method: "independent test input",
      evidence: ["snapshot.json"],
    },
  };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ui-observation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function run(root, id = "a", value = 0.4, opts = {}) {
  const writer = await BundleWriter.create(root, id, scene, systemClock);
  await writer.write("snapshot.json", { value });
  await writer.write("facts.json", [fact(id, 0, value)]);
  await writer.write("conditions.json", { ...conditions, ...opts.conditions });
  await writer.write("frames.json", []);
  await writer.write("assets.json", { assets: [] });
  return await writer.finish({
    outcome: "completed",
    channels: ["renderer"],
    issues: [],
    validation: [],
  });
}
test("recipe rejects ambiguous keys, unknown fields and missing explicit target", () => {
  assert.throws(() =>
    parseScene({ ...scene, elements: [scene.elements[0], scene.elements[0]] }),
  );
  assert.throws(() => parseScene({ ...scene, target: {} }));
  assert.throws(() => parseScene({ ...scene, guessedDuration: 2 }));
  assert.throws(() => localEndpoint("ws://example.com/devtools/browser/a"));
  assert.throws(() => localEndpoint("ws://127.0.0.1/devtools/page/a"));
  assert.throws(() =>
    IntentSchema.parse({
      ...intent,
      checks: [{ ...intent.checks[0], intent: "change" }],
    }),
  );
});
test("preserved v1 fixture retains all five provenance categories without SDK access", async () => {
  const path = new URL("./fixtures/bundle-v1/", import.meta.url).pathname;
  const result = await queryBundle(path);
  assert.deepEqual(
    result.facts.map((f) => f.provenance.kind),
    ["observed", "source", "calculated", "estimated", "unknown"],
  );
  assert.deepEqual(
    result.facts.map((f) => f.value),
    [0.4, 0.7, 0.3, 0.5, null],
  );
});
test("immutable writer, full integrity, mutation after open and unknown version", async (t) => {
  const root = await fixture(t);
  const bundle = await run(root);
  const reader = await BundleReader.open(bundle.path);
  assert.equal(reader.manifest.runId, "a");
  await assert.rejects(() => run(root), /a/);
  await writeFile(join(bundle.path, "facts.json"), "[]");
  await assert.rejects(() => reader.json("facts.json"), /Changed/);
  await assert.rejects(() => BundleReader.open(bundle.path), /mismatch/);
  const other = await run(root, "b");
  const file = join(other.path, "manifest.json");
  const m = JSON.parse(await readFile(file));
  m.format = "future/9";
  await writeFile(file, JSON.stringify(m));
  await assert.rejects(
    () => BundleReader.open(other.path),
    (e) => e.code === "UNKNOWN_FORMAT",
  );
});
test("reject traversal, symlink and duplicate manifest entries", async (t) => {
  const root = await fixture(t);
  const bundle = await run(root);
  const reader = await BundleReader.open(bundle.path);
  await assert.rejects(
    () => reader.bytes("../a/manifest.json"),
    (e) => e.code === "UNSAFE_PATH",
  );
  const original = join(bundle.path, "snapshot.json"),
    saved = join(root, "outside.json");
  await writeFile(saved, await readFile(original));
  await rm(original);
  await symlink(saved, original);
  await assert.rejects(
    () => BundleReader.open(bundle.path),
    (e) => e.code === "UNSAFE_PATH",
  );
  const other = await run(root, "b");
  const path = join(other.path, "manifest.json"),
    m = JSON.parse(await readFile(path));
  m.files.push(m.files[0]);
  await writeFile(path, JSON.stringify(m));
  await assert.rejects(
    () => BundleReader.open(other.path),
    (e) => e.code === "DUPLICATE_FILE",
  );
});
test("bounded queue reports loss, stops admission at seal and drains accepted records", async (t) => {
  const root = await fixture(t);
  const writer = await BundleWriter.create(
    root,
    "queue",
    { ...scene, maxRecords: 10 },
    systemClock,
  );
  for (let i = 0; i < 30; i++) writer.record("events", { i });
  const seal = writer.finish({
    outcome: "completed",
    channels: [],
    issues: [],
    validation: [],
  });
  assert.throws(() => writer.record("events", {}), /seal/i);
  const result = await seal;
  assert.equal(result.manifest.outcome, "partial");
  assert.equal(result.manifest.records.written, 10);
  assert.equal(result.manifest.records.dropped, 20);
  const r = await BundleReader.open(result.path);
  const events = [];
  for await (const e of r.records("events.jsonl")) events.push(e);
  assert.deepEqual(
    events.map((e) => e.sequence),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
});
test("forced process termination leaves recoverable, explicitly unsealed records", async (t) => {
  const root = await fixture(t);
  const code = `import {BundleWriter} from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};import {systemClock} from ${JSON.stringify(new URL("../dist/util.js", import.meta.url).href)};const w=await BundleWriter.create(${JSON.stringify(root)},'killed',${JSON.stringify(scene)},systemClock);w.record('events',{known:42});await w.drain();process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code]);
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
  const result = await inspectBundle(join(root, "killed.partial"));
  assert.equal(result.state, "incomplete");
  assert.ok(result.files.includes("events.jsonl"));
  assert.match(
    await readFile(join(root, "killed.partial/events.jsonl"), "utf8"),
    /42/,
  );
  await assert.rejects(
    () => BundleReader.open(join(root, "killed.partial")),
    (e) => e.code === "INCOMPLETE_RUN",
  );
});
test("bounded query continuation is bound to hash and filters; oversize is explicit", async (t) => {
  const root = await fixture(t);
  const w = await BundleWriter.create(root, "query", scene, systemClock);
  await w.write(
    "facts.json",
    Array.from({ length: 5 }, (_, i) => fact("query", i, i)),
  );
  const r = await w.finish({
    outcome: "completed",
    channels: [],
    issues: [],
    validation: [],
  });
  const first = await queryBundle(r.path, { limit: 2 });
  assert.equal(first.facts.length, 2);
  assert.equal(first.range.remaining, 3);
  const second = await queryBundle(r.path, {
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    second.facts.map((f) => f.value),
    [2, 3],
  );
  await assert.rejects(
    () => queryBundle(r.path, { limit: 3, cursor: first.nextCursor }),
    (e) => e.code === "INVALID_CURSOR",
  );
  const oversized = await queryBundle(r.path, { maxBytes: 256 });
  assert.equal(oversized.facts.length, 0);
  assert.equal(oversized.omissions.oversized.length, 1);
  assert.ok(oversized.nextCursor);
});
test("source declarations remain distinct, content mismatch rejects and exported code is independent", async (t) => {
  const root = await fixture(t);
  const a = await run(root);
  const source = join(root, "source.css");
  await writeFile(source, "opacity: 0.7;\n");
  const sourceFact = {
    element: "row",
    property: "style.opacity",
    value: 0.7,
    unit: "ratio",
    path: source,
    startLine: 1,
    endLine: 1,
    sha256: hash(await readFile(source)),
    revision: "1",
    actor: "test author",
    method: "read declaration",
    conditions: "fixture",
  };
  const exported = await exportReference(a.path, {
    outputDir: join(root, "export"),
    intent,
    sources: [sourceFact],
  });
  const ref = await readReference(exported.path);
  assert.deepEqual(
    ref.facts.map((f) => [f.provenance.kind, f.value]),
    [
      ["observed", 0.4],
      ["source", 0.7],
    ],
  );
  assert.equal(ref.sources[0].correspondence, "unverified");
  await rm(source);
  await readReference(exported.path);
  await assert.rejects(
    () =>
      exportReference(a.path, {
        outputDir: join(root, "bad"),
        intent,
        sources: [{ ...sourceFact, path: join(a.path, "facts.json") }],
      }),
    (e) => e.code === "SOURCE_HASH_MISMATCH",
  );
  const absent = await exportReference(a.path, {
    outputDir: join(root, "no-source"),
    intent,
  });
  assert.ok(absent.omissions.some((s) => s.includes("No operator")));
});
test("comparison honors frozen intent, declared changes, full conditions, missing facts and portability", async (t) => {
  const root = await fixture(t);
  const a = await run(root, "a");
  const exported = await exportReference(a.path, {
    outputDir: join(root, "export"),
    intent,
  });
  const b = await run(root, "b");
  assert.equal(
    (await compareBundles(exported.path, b.path)).outcome,
    "automated-checks-pass",
  );
  const c = await run(root, "c", 0.7);
  assert.equal((await compareBundles(exported.path, c.path)).outcome, "fail");
  const d = await run(root, "d", 0.4, { conditions: { dpr: 2 } });
  assert.equal(
    (await compareBundles(exported.path, d.path)).outcome,
    "unknown",
  );
  const change = await exportReference(a.path, {
    outputDir: join(root, "change"),
    intent: {
      ...intent,
      checks: [{ ...intent.checks[0], intent: "change", expected: 0.7 }],
    },
  });
  const e = await run(root, "e", 0.7);
  assert.equal(
    (await compareBundles(change.path, e.path)).outcome,
    "automated-checks-pass",
  );
  const moved = join(root, "moved");
  await mkdir(moved);
  for (const name of ["a", "export", "b"])
    await cp(join(root, name), join(moved, name), { recursive: true });
  assert.equal(
    (await compareBundles(join(moved, "export"), join(moved, "b"))).outcome,
    "automated-checks-pass",
  );
  const late = await exportReference(a.path, {
    outputDir: join(root, "late"),
    intent,
  });
  assert.equal(
    (await compareBundles(late.path, b.path)).checks[0].status,
    "unknown",
  );
});
test("runtime closes failed adapters and cancellation finalizes available diagnostics", async (t) => {
  const root = await fixture(t);
  let closed = 0;
  const deps = {
    cdp: () => ({
      connect: async () => {
        throw new ObservationError("TARGET_MISMATCH", "wrong renderer");
      },
      close: async () => {
        closed++;
      },
    }),
  };
  const result = await checkConnection(scene, deps);
  assert.equal(result.issues[0].code, "TARGET_MISMATCH");
  assert.equal(closed, 1);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await captureScene(
    scene,
    { outputDir: root, signal: controller.signal },
    deps,
  );
  assert.equal(cancelled.manifest.outcome, "cancelled");
  await BundleReader.open(cancelled.path);
  assert.equal(closed, 1);
});
test("structured native SDK errors survive failed-run storage and reopening", async (t) => {
  const root = await fixture(t);
  const error = Object.assign(new Error(""), {
    inner: {
      tool: "get_window_state",
      message: "SDK host permission denied",
      errorCode: "permission_required",
    },
  });
  const result = await captureScene(
    scene,
    { outputDir: root },
    {
      cdp: () => ({
        connect: async () => {
          throw error;
        },
        close: async () => {},
      }),
    },
  );
  const reader = await BundleReader.open(result.path);
  assert.equal(reader.manifest.outcome, "failed");
  assert.ok(
    reader.manifest.issues.some(
      (i) => i.message === "SDK host permission denied",
    ),
  );
});
test("input response timeout is followed by observation without a second input", async () => {
  let inputs = 0,
    reads = 0;
  const log = [];
  const cdp = {
    evaluate: async (expression) => {
      if (expression.includes("getBoundingClientRect")) return { x: 1, y: 2 };
      reads++;
      return true;
    },
    send: async () => {
      inputs++;
      throw Error("input timed out; may have happened");
    },
  };
  await executeAction(
    {
      kind: "cdp-click",
      selector: "#button",
      after: { selector: "#done", timeoutMs: 500 },
    },
    cdp,
    undefined,
    systemClock,
    (x) => log.push(x),
  );
  assert.equal(inputs, 1);
  assert.equal(reads, 1);
  assert.equal(log[0].delivery, "unknown");
  assert.equal(log[0].postcondition, "observed");
});
