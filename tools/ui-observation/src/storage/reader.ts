import { lstat, readFile, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import {
  FactSchema,
  FORMAT,
  FrameSchema,
  ManifestSchema,
  ObservationError,
  type Fact,
  type Frame,
  type Manifest,
  type RecordEntry,
} from "../contracts.js";
import { hash } from "../util.js";
import { listPartialFiles, safeRelative } from "./writer.js";

export class BundleReader {
  private constructor(
    public path: string,
    public manifest: Manifest,
    public manifestHash: string,
  ) {}
  static async open(path: string): Promise<BundleReader> {
    const root = await realpath(path);
    let bytes: Buffer;
    try {
      if ((await lstat(resolve(root, "manifest.json"))).isSymbolicLink())
        throw new ObservationError(
          "UNSAFE_PATH",
          "Manifest cannot be a symlink",
        );
      bytes = await readFile(resolve(root, "manifest.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ObservationError(
          "INCOMPLETE_RUN",
          "No final manifest; use inspectBundle to recover the available file inventory",
          "storage",
        );
      throw error;
    }
    const raw = JSON.parse(bytes.toString());
    if (raw.format !== FORMAT)
      throw new ObservationError(
        "UNKNOWN_FORMAT",
        `Unsupported format ${raw.format}`,
        "storage",
      );
    const manifest = ManifestSchema.parse(raw);
    if (
      new Set(manifest.files.map((f) => f.path)).size !== manifest.files.length
    )
      throw new ObservationError("DUPLICATE_FILE", "Duplicate manifest file");
    for (const file of [
      "run.json",
      "scene.json",
      "actions.jsonl",
      "events.jsonl",
      "samples.jsonl",
    ])
      if (!manifest.files.some((f) => f.path === file))
        throw new ObservationError("MISSING_FILE", file);
    const reader = new BundleReader(root, manifest, hash(bytes));
    // Verify the complete bundle, including frames that a bounded query omits.
    for (const file of manifest.files) {
      const full = await reader.filePath(file.path);
      const info = await lstat(full);
      if (info.size !== file.bytes)
        throw new ObservationError("INTEGRITY", `Size mismatch: ${file.path}`);
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(full)) digest.update(chunk);
      if (digest.digest("hex") !== file.sha256)
        throw new ObservationError("INTEGRITY", `Hash mismatch: ${file.path}`);
    }
    if (
      manifest.files.find((f) => f.path === "scene.json")!.sha256 !==
      manifest.sceneHash
    )
      throw new ObservationError("INTEGRITY", "Scene hash mismatch");
    return reader;
  }
  async filePath(path: string): Promise<string> {
    safeRelative(path);
    if (!this.manifest.files.some((f) => f.path === path))
      throw new ObservationError("UNLISTED_FILE", path);
    const lexical = resolve(this.path, path);
    const actual = await realpath(lexical);
    if (
      actual !== lexical ||
      !actual.startsWith(this.path + sep) ||
      !(await lstat(actual)).isFile()
    )
      throw new ObservationError(
        "UNSAFE_PATH",
        `Symlink/non-file path: ${path}`,
      );
    return actual;
  }
  has(path: string): boolean {
    return this.manifest.files.some((f) => f.path === path);
  }
  async bytes(path: string): Promise<Buffer> {
    const buffer = await readFile(await this.filePath(path));
    if (
      hash(buffer) !== this.manifest.files.find((f) => f.path === path)!.sha256
    )
      throw new ObservationError("INTEGRITY", `Changed after opening: ${path}`);
    return buffer;
  }
  async json<T = unknown>(path: string): Promise<T> {
    return JSON.parse((await this.bytes(path)).toString()) as T;
  }
  async *records(
    path: "samples.jsonl" | "events.jsonl" | "actions.jsonl",
  ): AsyncGenerator<RecordEntry> {
    const input = createReadStream(await this.filePath(path));
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as RecordEntry;
        if (
          !Number.isSafeInteger(record.sequence) ||
          !Number.isFinite(record.receivedHostMs) ||
          `${record.channel}.jsonl` !== path
        )
          throw new ObservationError("INVALID_RECORD", path);
        yield record;
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }
  async *facts(): AsyncGenerator<Fact> {
    if (this.has("facts.json"))
      for (const fact of await this.json<unknown[]>("facts.json"))
        yield FactSchema.parse(fact);
    for await (const record of this.records("samples.jsonl")) {
      const data = record.data as { facts?: unknown[] };
      for (const fact of data.facts ?? []) yield FactSchema.parse(fact);
    }
  }
  async frames(): Promise<Frame[]> {
    return this.has("frames.json")
      ? FrameSchema.array().parse(await this.json("frames.json"))
      : [];
  }
}
export async function inspectBundle(path: string): Promise<unknown> {
  try {
    const reader = await BundleReader.open(path);
    return {
      state: "sealed",
      path: reader.path,
      manifestHash: reader.manifestHash,
      manifest: reader.manifest,
    };
  } catch (error) {
    if (!(error instanceof ObservationError) || error.code !== "INCOMPLETE_RUN")
      throw error;
    return {
      state: "incomplete",
      path: resolve(path),
      reason: error.message,
      files: await listPartialFiles(resolve(path)),
      integrity: "unverified; no final manifest",
    };
  }
}
