import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CuaDriver, currentMacOsPermissionStatus } from "@trycua/cua-driver";
import { checkConnection } from "../dist/index.js";
const output = process.argv[2] ?? `captures/desktop-probe-${Date.now()}`;
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const lifecycle = [];
for (let iteration = 0; iteration < 2; iteration++) {
  const driver = CuaDriver.create({
    embedded: true,
    claudeCodeCompatibility: false,
  });
  try {
    lifecycle.push({
      iteration,
      phase: "initialized",
      permissions: currentMacOsPermissionStatus(),
    });
    const apps = await driver.listApps({});
    lifecycle.push({
      iteration,
      phase: "listed",
      claude: apps.apps.filter(
        (a) => a.bundleId === "com.anthropic.claudefordesktop",
      ),
    });
  } finally {
    await driver.shutdown();
    driver.uniffiDestroy();
    lifecycle.push({ iteration, phase: "shutdown-and-destroyed" });
  }
}
const scene = JSON.parse(
  await readFile(new URL("../recipes/claude.json", import.meta.url), "utf8"),
);
const connection = await checkConnection(scene);
const result = {
  at: new Date().toISOString(),
  node: process.version,
  lifecycle,
  connection,
};
await writeFile(
  `${output}/result.json`,
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
