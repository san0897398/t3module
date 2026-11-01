import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "../util.js";
const require = createRequire(import.meta.url);
export async function cdpVersions() {
  const pkg = JSON.parse(
    await readFile(
      require.resolve("chrome-remote-interface/package.json"),
      "utf8",
    ),
  );
  return { name: pkg.name, version: pkg.version };
}
export async function desktopVersions() {
  const root = dirname(
    dirname(fileURLToPath(import.meta.resolve("@trycua/cua-driver"))),
  );
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const suffix =
    process.platform === "darwin"
      ? `darwin-${process.arch}`
      : process.platform === "win32"
        ? `win32-${process.arch}-msvc`
        : `linux-${process.arch}-gnu`;
  const nativeName = `@trycua/cua-driver-${suffix}`;
  const nativeRoot = dirname(require.resolve(`${nativeName}/package.json`));
  const native = JSON.parse(
    await readFile(join(nativeRoot, "package.json"), "utf8"),
  );
  if (native.version !== pkg.version)
    throw new Error(
      `Bindings/native version mismatch: ${pkg.version} / ${native.version}`,
    );
  const library =
    process.platform === "darwin"
      ? "libcua_driver_sdk.dylib"
      : process.platform === "win32"
        ? "cua_driver_sdk.dll"
        : "libcua_driver_sdk.so";
  return {
    name: pkg.name,
    version: pkg.version,
    nativePackage: nativeName,
    nativeVersion: native.version,
    librarySha256: hash(await readFile(join(nativeRoot, library))),
    mode: "embedded",
    inputSerialization: "process-local",
  };
}
