import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { z } from "zod";
import { BundleReader } from "./storage/reader.js";
import {
  TRANSFORMER,
  IntentSchema,
  SourceFactSchema,
  QuerySchema,
  ObservationError,
  type Fact,
  type Query,
  type Intent,
  type SourceFact,
} from "./contracts.js";
import { hash, json } from "./util.js";

export async function queryBundle(path: string, input: unknown = {}) {
  const query = QuerySchema.parse(input);
  const reader = await BundleReader.open(path);
  const { cursor, ...selection } = query;
  const queryHash = hash(json(selection));
  let offset = 0;
  if (cursor) {
    let data: { bundle: string; query: string; offset: number };
    try {
      data = JSON.parse(Buffer.from(cursor, "base64url").toString());
    } catch {
      throw new ObservationError("INVALID_CURSOR", "Malformed continuation");
    }
    if (
      data.bundle !== reader.manifestHash ||
      data.query !== queryHash ||
      !Number.isSafeInteger(data.offset) ||
      data.offset < 0
    )
      throw new ObservationError(
        "INVALID_CURSOR",
        "Cursor belongs to another bundle, selection or version",
      );
    offset = data.offset;
  }
  const facts: Fact[] = [];
  const oversized: string[] = [];
  let bytes = 0,
    matched = 0,
    total = 0,
    consumed = 0;
  let stopped = false;
  for await (const fact of reader.facts()) {
    total++;
    if (
      (query.elements && !query.elements.includes(fact.element)) ||
      (query.properties && !query.properties.includes(fact.property)) ||
      (query.kinds && !query.kinds.includes(fact.provenance.kind)) ||
      (query.fromMs !== undefined && fact.time.hostMs < query.fromMs) ||
      (query.toMs !== undefined && fact.time.hostMs > query.toMs)
    )
      continue;
    if (matched++ < offset || stopped) continue;
    const size = Buffer.byteLength(JSON.stringify(fact));
    if (facts.length >= query.limit || bytes + size > query.maxBytes) {
      if (!facts.length && size > query.maxBytes) {
        oversized.push(fact.id);
        consumed++;
      }
      stopped = true;
      continue;
    }
    facts.push(fact);
    bytes += size;
    consumed++;
  }
  const nextOffset = offset + consumed;
  if (offset > matched)
    throw new ObservationError(
      "INVALID_CURSOR",
      "Offset exceeds matching facts",
    );
  const frames = (await reader.frames()).filter(
    (f) =>
      (query.fromMs === undefined || f.time.hostMs >= query.fromMs) &&
      (query.toMs === undefined || f.time.hostMs <= query.toMs),
  );
  return {
    transformer: TRANSFORMER,
    runId: reader.manifest.runId,
    manifestHash: reader.manifestHash,
    selection,
    facts,
    frames: frames.slice(0, 10),
    range: {
      offset,
      returned: facts.length,
      matchingTotal: matched,
      remaining: Math.max(0, matched - nextOffset),
      filteredOut: total - matched,
      factBytes: bytes,
    },
    omissions: {
      oversized,
      frames: Math.max(0, frames.length - 10),
      frameRead:
        "frames.json is the complete timestamped index; original images are addressed by path",
      issues: reader.manifest.issues,
    },
    nextCursor:
      nextOffset < matched
        ? Buffer.from(
            JSON.stringify({
              bundle: reader.manifestHash,
              query: queryHash,
              offset: nextOffset,
            }),
          ).toString("base64url")
        : null,
  };
}

const ExportSchema = z.object({
  format: z.literal(TRANSFORMER),
  createdAt: z.string().datetime(),
  bundlePath: z.string(),
  manifestHash: z.string(),
  intent: IntentSchema,
  selection: QuerySchema,
  actualRange: z.object({
    pages: z.number(),
    facts: z.number(),
    complete: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
  facts: z.array(z.unknown()),
  frames: z.array(
    z
      .object({ path: z.string(), sha256: z.string(), bytes: z.number() })
      .passthrough(),
  ),
  sources: z.array(
    z.object({
      source: SourceFactSchema,
      codePath: z.string(),
      codeSha256: z.string(),
      correspondence: z.enum(["loaded-asset-hash", "unverified"]),
    }),
  ),
  omissions: z.array(z.string()),
});
export type Reference = z.infer<typeof ExportSchema>;

export async function exportReference(
  path: string,
  options: {
    outputDir: string;
    intent: Intent;
    query?: Partial<Query>;
    sources?: SourceFact[];
    maxPages?: number;
  },
) {
  const intent = IntentSchema.parse(options.intent);
  const selection = QuerySchema.parse(options.query ?? {});
  const sources = SourceFactSchema.array().parse(options.sources ?? []);
  const maxPages = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.maxPages ?? 10);
  const reader = await BundleReader.open(path);
  let outputDir = resolve(options.outputDir);
  await mkdir(outputDir); // Immutable export: never reuse a supplied directory.
  outputDir = await realpath(outputDir);
  const facts: Fact[] = [];
  let cursor = selection.cursor;
  let pages = 0;
  let nextCursor: string | null = null;
  const omissions: string[] = [];
  do {
    const result = await queryBundle(path, {
      ...selection,
      ...(cursor ? { cursor } : {}),
    });
    facts.push(...result.facts);
    omissions.push(
      ...result.omissions.oversized.map(
        (id) => `Fact ${id} exceeded the byte budget`,
      ),
    );
    pages++;
    nextCursor = result.nextCursor;
    cursor = nextCursor ?? undefined;
  } while (nextCursor && pages < maxPages);
  if (nextCursor)
    omissions.push(
      "Fact selection exceeds the export page budget; continuation is preserved",
    );
  const frames = [];
  for (const frame of await reader.frames()) {
    if (
      (selection.fromMs !== undefined &&
        frame.time.hostMs < selection.fromMs) ||
      (selection.toMs !== undefined && frame.time.hostMs > selection.toMs)
    )
      continue;
    await mkdir(join(outputDir, "frames"), { recursive: true });
    const bytes = await reader.bytes(frame.path);
    await writeFile(join(outputDir, frame.path), bytes, { flag: "wx" });
    frames.push({ ...frame, sha256: hash(bytes), bytes: bytes.length });
  }
  const imported: Reference["sources"] = [];
  const assets = reader.has("assets.json")
    ? await reader.json<{ assets: { sha256?: string }[] }>("assets.json")
    : { assets: [] };
  for (const source of sources) {
    const data = await readFile(source.path);
    if (hash(data) !== source.sha256)
      throw new ObservationError("SOURCE_HASH_MISMATCH", source.path, "source");
    const lines = data.toString().split(/\r?\n/);
    if (source.endLine > lines.length)
      throw new ObservationError("SOURCE_RANGE", source.path);
    const code = lines.slice(source.startLine - 1, source.endLine).join("\n");
    const codeSha256 = hash(code);
    const codePath = `code/${codeSha256}.txt`;
    await mkdir(join(outputDir, "code"), { recursive: true });
    if (!imported.some((s) => s.codePath === codePath))
      await writeFile(join(outputDir, codePath), code, { flag: "wx" });
    const correspondence =
      source.loadedAssetSha256 &&
      assets.assets.some((a) => a.sha256 === source.loadedAssetSha256)
        ? "loaded-asset-hash"
        : "unverified";
    imported.push({ source, codePath, codeSha256, correspondence });
    const sample = facts.find((f) => f.element === source.element);
    if (sample)
      facts.push({
        id: `source:${imported.length}`,
        element: source.element,
        property: source.property,
        value: source.value,
        unit: source.unit,
        scope: sample.scope,
        time: sample.time,
        provenance: {
          kind: "source",
          method: `${source.actor}: ${source.method}; revision ${source.revision}; applies when ${source.conditions}`,
          evidence: [codePath, source.path],
          reason: `Source declaration; runtime correspondence ${correspondence}; time locates the associated observation, not source execution`,
        },
      });
    else
      omissions.push(
        `Source fact for ${source.element} has no observed element in the selected range`,
      );
  }
  if (!sources.length)
    omissions.push("No operator-verified source facts were supplied");
  for (const source of imported.filter(
    (s) => s.correspondence === "unverified",
  ))
    omissions.push(
      `Source/runtime correspondence unverified: ${source.source.path}`,
    );
  if (!frames.length)
    omissions.push("No original frames in selected time range");
  const reference: Reference = {
    format: TRANSFORMER,
    createdAt: new Date().toISOString(),
    bundlePath: relative(outputDir, reader.path),
    manifestHash: reader.manifestHash,
    intent,
    selection,
    actualRange: {
      pages,
      facts: facts.length,
      complete:
        !nextCursor &&
        !omissions.some((message) =>
          message.includes("exceeded the byte budget"),
        ),
      nextCursor,
    },
    facts,
    frames,
    sources: imported,
    omissions,
  };
  const content = json(reference);
  await writeFile(join(outputDir, "reference.json"), content, { flag: "wx" });
  await writeFile(join(outputDir, "reference.sha256"), hash(content) + "\n", {
    flag: "wx",
  });
  return {
    path: outputDir,
    sha256: hash(content),
    range: reference.actualRange,
    omissions,
  };
}
export async function readReference(path: string): Promise<Reference> {
  const data = await readFile(join(path, "reference.json"));
  const expected = (
    await readFile(join(path, "reference.sha256"), "utf8")
  ).trim();
  if (hash(data) !== expected)
    throw new ObservationError("INTEGRITY", "Reference JSON changed");
  const reference = ExportSchema.parse(JSON.parse(data.toString()));
  const { safeRelative } = await import("./storage/writer.js");
  for (const file of [
    ...reference.frames.map((f) => ({ path: f.path, sha256: f.sha256 })),
    ...reference.sources.map((s) => ({
      path: s.codePath,
      sha256: s.codeSha256,
    })),
  ]) {
    safeRelative(file.path);
    if (hash(await readFile(join(path, file.path))) !== file.sha256)
      throw new ObservationError("INTEGRITY", file.path);
  }
  return reference;
}
