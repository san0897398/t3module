import { PNG } from "pngjs";
import { resolve } from "node:path";
import { BundleReader } from "./storage/reader.js";
import { readReference } from "./reference.js";
import {
  FactSchema,
  ObservationError,
  type Fact,
  type Validation,
} from "./contracts.js";

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export async function compareBundles(
  referencePath: string,
  implementationPath: string,
) {
  const reference = await readReference(referencePath);
  const before = await BundleReader.open(
    resolve(referencePath, reference.bundlePath),
  );
  const after = await BundleReader.open(implementationPath);
  if (before.manifestHash !== reference.manifestHash)
    throw new ObservationError(
      "INTEGRITY",
      "Reference bundle no longer matches frozen export",
    );
  const chronology =
    Date.parse(reference.createdAt) <= Date.parse(after.manifest.startedAt);
  const a = before.has("conditions.json")
    ? await before.json<Record<string, unknown>>("conditions.json")
    : {};
  const b = after.has("conditions.json")
    ? await after.json<Record<string, unknown>>("conditions.json")
    : {};
  const conditionKeys = [
    ...new Set([
      "viewport",
      "dpr",
      "theme",
      "reducedMotion",
      "density",
      "dataState",
      "fontState",
      "fonts",
      "scroll",
      "zoom",
      ...reference.intent.conditions,
    ]),
  ];
  const conditions: Validation[] = conditionKeys.map((key) => ({
    id: key,
    status:
      a[key] === undefined || b[key] === undefined
        ? "unknown"
        : equal(a[key], b[key])
          ? "pass"
          : "fail",
    reason: JSON.stringify({
      reference: a[key],
      implementation: b[key],
      basis: ["density", "dataState", "fontState"].includes(key)
        ? "operator-declared"
        : "observed",
    }),
    evidence: ["conditions.json"],
  }));
  const conditionsMatch = conditions.every((c) => c.status === "pass");
  const left = reference.facts.map((f) => FactSchema.parse(f));
  const right: Fact[] = [];
  for await (const f of after.facts()) right.push(f);
  const checks = reference.intent.checks.map((check) => {
    // Snapshot-to-snapshot only. Motion is not established by picking convenient
    // samples or a minimum pixel difference from an unaligned timeline.
    const l = left.filter(
      (f) =>
        f.id.startsWith("snapshot:") &&
        f.element === check.referenceElement &&
        f.property === check.property &&
        f.provenance.kind === "observed",
    );
    const r = right.filter(
      (f) =>
        f.id.startsWith("snapshot:") &&
        f.element === check.implementationElement &&
        f.property === check.property &&
        f.provenance.kind === "observed",
    );
    const base = {
      ...check,
      referenceFacts: l.map((f) => f.id),
      implementationFacts: r.map((f) => f.id),
    };
    if (!chronology)
      return {
        ...base,
        status: "unknown",
        reason:
          "The intent/export was not fixed before the implementation observation",
      };
    if (!conditionsMatch)
      return {
        ...base,
        status: "unknown",
        reason: "Comparison conditions differ or are unknown",
      };
    if (l.length !== 1 || r.length !== 1)
      return {
        ...base,
        status: "unknown",
        reason: "Missing or ambiguous observed semantic correspondence",
      };
    if (l[0]!.unit !== r[0]!.unit)
      return { ...base, status: "unknown", reason: "Units differ" };
    const expected = check.intent === "change" ? check.expected : l[0]!.value;
    const actual = r[0]!.value;
    const error =
      typeof expected === "number" && typeof actual === "number"
        ? Math.abs(expected - actual)
        : null;
    const pass =
      error === null ? equal(expected, actual) : error <= check.tolerance;
    return {
      ...base,
      status: pass ? "pass" : "fail",
      expected,
      actual,
      error,
      unit: r[0]!.unit,
    };
  });
  let pixels: unknown = {
    status: "unknown",
    reason: "No matching renderer frame dimensions",
  };
  const lf = (await before.frames()).find((f) => f.channel === "renderer");
  const rf = (await after.frames()).find((f) => f.channel === "renderer");
  if (lf && rf && lf.width === rf.width && lf.height === rf.height) {
    const p = PNG.sync.read(await before.bytes(lf.path));
    const q = PNG.sync.read(await after.bytes(rf.path));
    let changed = 0,
      total = 0;
    for (let i = 0; i < p.data.length; i += 4) {
      let d = 0;
      for (let j = 0; j < 4; j++)
        d += Math.abs(p.data[i + j]! - q.data[i + j]!);
      if (d) changed++;
      total += d;
    }
    pixels = {
      status: "diagnostic",
      changedPixels: changed,
      totalPixels: p.width * p.height,
      meanAbsoluteChannelError: total / p.data.length,
      frames: { reference: lf, implementation: rf },
      exclusions: [],
      reason:
        "Raw pixel diagnostic; not an intent, relationship, accessibility or motion verdict",
    };
  }
  return {
    format: "radix-ui-comparison/1",
    referenceHash: reference.manifestHash,
    implementationHash: after.manifestHash,
    chronology,
    conditions,
    checks,
    pixels,
    motion: {
      status: "unknown",
      reason:
        "Period/phase fitting and correspondence across action-aligned intervals are not implemented; retained samples and clock intervals remain available",
    },
    humanReview: { status: "pending", criteria: reference.intent.humanReview },
    outcome: checks.some((c) => c.status === "fail")
      ? "fail"
      : checks.every((c) => c.status === "pass")
        ? "automated-checks-pass"
        : "unknown",
  };
}
