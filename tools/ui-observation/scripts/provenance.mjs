import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const packages = [];
for (const name of [
  "@trycua/cua-driver",
  "@trycua/cua-driver-darwin-arm64",
  "@ubjs/core",
  "@ubjs/node",
  "chrome-remote-interface",
  "devtools-protocol",
]) {
  const path = `node_modules/${name}`;
  const pkg = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  packages.push({
    name,
    version: pkg.version,
    license: pkg.license,
    repository: pkg.repository,
    integrity: lock.packages[path].integrity,
    resolved: lock.packages[path].resolved,
  });
}
const native = [];
for (const path of [
  "node_modules/@trycua/cua-driver-darwin-arm64/libcua_driver_sdk.dylib",
  "node_modules/@trycua/cua-driver-darwin-arm64/cua_driver_node_runtime.node",
  "node_modules/@trycua/cua-driver/dist/native/cua_driver_sdk.js",
  "node_modules/@trycua/cua-driver/dist/native/cua_driver_contract.js",
]) {
  const bytes = await readFile(path);
  native.push({ path, bytes: bytes.length, sha256: hash(bytes) });
}
await mkdir("licenses", { recursive: true });
await copyFile(
  "node_modules/@trycua/cua-driver-darwin-arm64/node-runtime-NOTICE.md",
  "licenses/cua-node-runtime-NOTICE.md",
);
await copyFile(
  "node_modules/chrome-remote-interface/LICENSE",
  "licenses/chrome-remote-interface-LICENSE",
);
await writeFile(
  "SOURCES.json",
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      packages,
      native,
      sdkDocumentation: [
        "https://cua.ai/docs/cua-driver/guides/use-the-sdk",
        "https://github.com/cyrus-and/chrome-remote-interface#client-send-method-params-sessionid-callback",
      ],
      fixtureBasis: "tests/fixtures/lineage/basis.json",
      note: "Native optional package and bindings are pinned to the same release; package-lock.json owns resolution and registry integrity. No native binary is vendored. Runtime notice retained verbatim.",
    },
    null,
    2,
  ) + "\n",
);
