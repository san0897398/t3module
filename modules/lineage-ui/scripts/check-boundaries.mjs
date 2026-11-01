import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const provenance = JSON.parse(await readFile(path.join(root, "source.json"), "utf8"));
const allowedPackages = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exportedPaths = [];
function visitExports(value) {
  if (typeof value === "string") exportedPaths.push(value);
  else for (const child of Object.values(value)) visitExports(child);
}
visitExports(manifest.exports);
for (const target of new Set(exportedPaths)) {
  if (target.includes("*")) continue;
  assert.ok((await stat(path.join(root, target))).isFile(), `Missing export: ${target}`);
}

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : [target];
  }));
  return files.flat();
}
const files = await sourceFiles(path.join(root, "src"));
const externalImports = new Set();
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier.startsWith(".")) {
      const target = path.resolve(path.dirname(file), specifier);
      assert.ok(target.startsWith(path.join(root, "src") + path.sep), `Escaping source import: ${specifier}`);
      assert.ok((await stat(target)).isFile(), `Missing local import: ${specifier}`);
      continue;
    }
    const name = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    assert.ok(allowedPackages.has(name), `Undeclared or application import: ${specifier}`);
    externalImports.add(name);
  }
}
assert.ok(!manifest.dependencies.react && !manifest.dependencies["react-dom"], "React must be a host peer");
assert.ok(manifest.peerDependencies.react && manifest.peerDependencies["react-dom"]);
for (const entry of provenance.files) {
  const actual = digest(await readFile(path.join(root, entry.modulePath)));
  assert.equal(actual, entry.extractedSha256, `Extraction changed: ${entry.modulePath}`);
}
let verifiedOriginals = 0;
const sourceArgument = process.argv.indexOf("--source-root");
if (sourceArgument !== -1) {
  const sourceRoot = process.argv[sourceArgument + 1];
  assert.ok(sourceRoot, "--source-root requires a directory");
  for (const entry of provenance.files) {
    const actual = digest(await readFile(path.join(sourceRoot, entry.sourcePath)));
    assert.equal(actual, entry.sourceSha256, `Original changed: ${entry.sourcePath}`);
    verifiedOriginals++;
  }
}
console.log(JSON.stringify({
  status: "passed",
  publicExportFiles: new Set(exportedPaths.filter((x) => !x.includes("*"))).size,
  isolatedSourceFiles: files.length,
  externalPackages: [...externalImports].sort(),
  extractionHashesVerified: provenance.files.length,
  originalHashesVerified: verifiedOriginals,
  scope: "Static extraction and import boundaries; not UI typechecking, installed dependency resolution, or rendering.",
}, null, 2));
