import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import type { Clock } from "./contracts.js";
export function json(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n"
  );
}
export function hash(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
export async function collectorIdentity() {
  const root = fileURLToPath(new URL("./", import.meta.url));
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const files = [];
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (
      entry.isFile() &&
      /\.(js|ts)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      const path = join(entry.parentPath, entry.name);
      files.push({
        path: relative(root, path),
        sha256: hash(await readFile(path)),
      });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    name: pkg.name,
    version: pkg.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    implementationSha256: hash(json(files)),
    files,
  };
}
export const systemClock: Clock = {
  now: () => performance.now(),
  date: () => new Date().toISOString(),
  sleep: async (ms, signal) => {
    await setTimeout(Math.max(0, ms), undefined, { signal });
  },
};
export function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export async function deadline<T>(
  operation: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = globalThis.setTimeout(
          () =>
            reject(
              new Error(`${label} timed out after ${ms}ms; effect unknown`),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
