import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { startFixture } from "./fixture-host.mjs";
import { ChromeCdpAdapter } from "../dist/adapters/index.js";
const directory = resolve(process.argv[2]);
const host = await startFixture();
let viewer;
try {
  const url = pathToFileURL(join(directory, "viewer.html")).href;
  await host.adapter.send("Page.navigate", { url });
  viewer = new ChromeCdpAdapter();
  await viewer.connect({ ...host.selection, expectedUrl: url });
  await viewer.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const result = await viewer.evaluate(
    `new Promise(resolve=>{const check=()=>{const images=[...document.images];if(images.length===2&&images.every(i=>i.complete&&i.naturalWidth>0))resolve({panels:document.querySelectorAll('section').length,images:images.map(i=>({width:i.naturalWidth,height:i.naturalHeight})),facts:document.querySelector('section pre').textContent.includes('provenance')});else setTimeout(check,50)};check()})`,
  );
  assert.equal(result.panels, 2);
  assert.equal(result.facts, true);
  const change = await viewer.evaluate(
    `(()=>{const input=document.querySelector('input');input.value='1';input.dispatchEvent(new Event('input'));return document.querySelector('section p').textContent})()`,
  );
  assert.match(change, /00001/);
  const screenshot = await viewer.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(
    join(directory, "viewer-screen.png"),
    Buffer.from(screenshot.data, "base64"),
  );
  await writeFile(
    join(directory, "viewer-verification.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        status: "pass",
        ...result,
        frameSlider: change,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ status: "pass", ...result }));
} finally {
  await viewer?.close();
  await host.close();
}
