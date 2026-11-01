import { mkdir, open, rename, stat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  FORMAT,
  ObservationError,
  type BundleWriterPort,
  type Clock,
  type Manifest,
  type RecordEntry,
  type Scene,
} from "../contracts.js";
import { hash, json } from "../util.js";

export function safeRelative(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new ObservationError("UNSAFE_PATH", `Invalid bundle path: ${path}`);
}
export class BundleWriter implements BundleWriterPort {
  path: string;
  private files = new Map<string, Manifest["files"][number]>();
  private streamFiles = new Set<string>();
  private sequence = 0;
  private accepted = 0;
  private written = 0;
  private dropped = 0;
  private pending = 0;
  private pendingBytes = 0;
  private queue: Promise<void> = Promise.resolve();
  private failure?: Error;
  private sealed = false;
  private finishing = false;
  private startedAt: string;
  private constructor(
    private root: string,
    public runId: string,
    private scene: Scene,
    private clock: Clock,
  ) {
    this.path = join(root, `${runId}.partial`);
    this.startedAt = clock.date();
  }
  static async create(
    root: string,
    runId: string,
    scene: Scene,
    clock: Clock,
  ): Promise<BundleWriter> {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId))
      throw new ObservationError(
        "INVALID_RUN_ID",
        "Run IDs may contain letters, numbers, underscore and hyphen",
      );
    root = resolve(root);
    await mkdir(root, { recursive: true });
    const writer = new BundleWriter(root, runId, scene, clock);
    try {
      await stat(join(root, runId));
      throw new ObservationError("RUN_EXISTS", runId);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await mkdir(writer.path); // Exclusive ownership; a partial run is never reused.
    await writer.write("run.json", {
      format: FORMAT,
      runId,
      sceneId: scene.id,
      startedAt: writer.startedAt,
      state: "writing",
    });
    await writer.write("scene.json", scene);
    for (const name of ["actions", "events", "samples"]) {
      const file = await open(join(writer.path, `${name}.jsonl`), "wx", 0o600);
      await file.close();
      writer.streamFiles.add(`${name}.jsonl`);
    }
    return writer;
  }
  async bytes(path: string, data: Uint8Array): Promise<void> {
    if (this.sealed || this.finishing)
      throw new ObservationError("SEALED", "Cannot mutate a finalized run");
    safeRelative(path);
    await mkdir(dirname(join(this.path, path)), { recursive: true });
    const file = await open(join(this.path, path), "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    this.files.set(path, { path, bytes: data.byteLength, sha256: hash(data) });
  }
  async write(path: string, value: unknown): Promise<void> {
    await this.bytes(path, Buffer.from(json(value)));
  }
  record(channel: RecordEntry["channel"], data: unknown): boolean {
    if (this.sealed || this.finishing)
      throw new ObservationError("SEALED", "Record submitted after seal");
    const entry: RecordEntry = {
      sequence: ++this.sequence,
      receivedHostMs: this.clock.now(),
      channel,
      data,
    };
    const encoded = JSON.stringify(entry) + "\n";
    const size = Buffer.byteLength(encoded);
    if (
      this.failure ||
      this.pending >= this.scene.maxRecords ||
      this.pendingBytes + size > 16 * 1024 * 1024
    ) {
      this.dropped++;
      return false;
    }
    this.accepted++;
    this.pending++;
    this.pendingBytes += size;
    this.queue = this.queue
      .then(async () => {
        if (this.failure) {
          this.dropped++;
          return;
        }
        const file = await open(
          join(this.path, `${channel}.jsonl`),
          "a",
          0o600,
        );
        try {
          await file.writeFile(encoded);
        } finally {
          await file.close();
        }
        this.written++;
      })
      .catch((error) => {
        this.failure =
          error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        this.pending--;
        this.pendingBytes -= size;
      });
    return true;
  }
  async drain(): Promise<void> {
    await this.queue;
  }
  async finish(
    result: Pick<Manifest, "outcome" | "channels" | "issues" | "validation">,
  ): Promise<{ path: string; manifest: Manifest }> {
    if (this.sealed || this.finishing)
      throw new ObservationError("SEALED", "Already finalized");
    this.finishing = true;
    await this.drain();
    this.sealed = true;
    // Stream files are fsynced and hashed only after the queue has drained.
    const { readFile } = await import("node:fs/promises");
    for (const path of this.streamFiles) {
      const file = await open(join(this.path, path), "r+");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      const data = await readFile(join(this.path, path));
      this.files.set(path, { path, bytes: data.length, sha256: hash(data) });
    }
    if (this.failure)
      result.issues.push({
        code: "WRITER_FAILED",
        message: this.failure.message,
        scope: "storage",
      });
    if (this.dropped)
      result.issues.push({
        code: "QUEUE_OVERFLOW",
        message: `${this.dropped} records were not retained`,
        scope: "storage",
      });
    if (this.failure || this.dropped)
      result.outcome = result.outcome === "cancelled" ? "cancelled" : "partial";
    result.validation.push({
      id: "writer-sequence",
      status: this.accepted === this.written && !this.dropped ? "pass" : "fail",
      reason: `accepted=${this.accepted}; written=${this.written}; dropped=${this.dropped}; last=${this.sequence}`,
      evidence: ["actions.jsonl", "events.jsonl", "samples.jsonl"],
    });
    const validationBytes = Buffer.from(json(result.validation));
    const validationFile = await open(
      join(this.path, "validation.json"),
      "wx",
      0o600,
    );
    try {
      await validationFile.writeFile(validationBytes);
      await validationFile.sync();
    } finally {
      await validationFile.close();
    }
    this.files.set("validation.json", {
      path: "validation.json",
      bytes: validationBytes.length,
      sha256: hash(validationBytes),
    });
    const manifest: Manifest = {
      format: FORMAT,
      runId: this.runId,
      sceneId: this.scene.id,
      sceneHash: hash(json(this.scene)),
      startedAt: this.startedAt,
      finishedAt: this.clock.date(),
      ...result,
      files: [...this.files.values()].sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
      records: {
        accepted: this.accepted,
        written: this.written,
        dropped: this.dropped,
        lastSequence: this.sequence,
      },
    };
    const file = await open(join(this.path, "manifest.json"), "wx", 0o600);
    try {
      await file.writeFile(json(manifest));
      await file.sync();
    } finally {
      await file.close();
    }
    const destination = join(this.root, this.runId);
    await rename(this.path, destination);
    this.path = destination;
    const directory = await open(this.root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return { path: this.path, manifest };
  }
}
export async function listPartialFiles(path: string): Promise<string[]> {
  return (await readdir(path, { recursive: true, withFileTypes: true }))
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name).slice(resolve(path).length + 1))
    .sort();
}
