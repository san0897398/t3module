import { readFile, writeFile } from "node:fs/promises";
import CDP from "chrome-remote-interface";
import { inspectElectron } from "@radix/ui-observation";
const path = process.argv[2];
if (!path)
  throw Error(
    "Usage: node scripts/close-claude-inspector.mjs SCENE_JSON.preparation.json",
  );
const receipt = JSON.parse(await readFile(path, "utf8"));
if (!receipt.enabledInspector)
  throw Error(
    "This preparation did not start the Inspector; it must not close an existing listener",
  );
const inventory = await inspectElectron({
  endpoint: receipt.endpoint,
  expectedPid: receipt.applicationPid,
});
if (
  inventory.app !== "Claude" ||
  inventory.webContents.some((w) => w.debuggerAttached)
)
  throw Error("Wrong app or an active renderer debugger remains");
const client = await CDP({ target: receipt.endpoint, local: true });
try {
  const expression = `(()=>{const inspector=process.getBuiltinModule('inspector');if(process.pid!==${JSON.stringify(receipt.applicationPid)}||inspector.url()!==${JSON.stringify(receipt.endpoint)})throw Error('Inspector identity changed');setTimeout(()=>inspector.close(),100);return true})()`;
  const result = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
} finally {
  await client.close();
}
const discovery = new URL("/json/list", receipt.endpoint);
discovery.protocol = "http:";
let closed = false;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 100));
  try {
    await fetch(discovery, { signal: AbortSignal.timeout(500) });
  } catch {
    closed = true;
    break;
  }
}
if (!closed) throw Error("Inspector closure was not verified");
const result = {
  at: new Date().toISOString(),
  pid: receipt.applicationPid,
  endpoint: receipt.endpoint,
  inspectorClosed: true,
};
await writeFile(path + ".closed.json", JSON.stringify(result, null, 2) + "\n", {
  flag: "wx",
});
console.log(JSON.stringify(result));
