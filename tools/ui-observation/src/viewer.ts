import { writeFile } from "node:fs/promises";
import { BundleReader } from "./storage/reader.js";
import type { Fact } from "./contracts.js";

export async function createViewer(
  path: string,
  outputFile: string,
  comparisonPath?: string,
) {
  const load = async (path: string) => {
    const reader = await BundleReader.open(path);
    const facts: Fact[] = [];
    for await (const fact of reader.facts()) facts.push(fact);
    const frames = await Promise.all(
      (await reader.frames()).map(async (frame) => ({
        ...frame,
        data: `data:${frame.mimeType};base64,${(await reader.bytes(frame.path)).toString("base64")}`,
      })),
    );
    return {
      runId: reader.manifest.runId,
      hash: reader.manifestHash,
      frames,
      facts,
      issues: reader.manifest.issues,
      validation: reader.manifest.validation,
    };
  };
  const data = JSON.stringify(
    await Promise.all(
      [path, ...(comparisonPath ? [comparisonPath] : [])].map(load),
    ),
  ).replaceAll("<", "\\u003c");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>UI observation replay</title>
  <style>body{margin:24px;background:#101418;color:#e7ecf0;font:14px system-ui}h1{font-size:22px}main{display:flex;gap:24px;align-items:start}section{min-width:0;flex:1}img{max-width:100%;height:auto;background:#fff}input{width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#192129;padding:12px;max-height:440px;overflow:auto}small{color:#a8bccd}button,select{font:inherit;padding:6px;margin:8px 8px 8px 0}summary{cursor:pointer}code{overflow-wrap:anywhere}@media(max-width:900px){main{display:block}}</style>
  <h1>UI observation replay</h1><p>Original retained frames. The slider selects saved frames; no image or motion interpolation. Frame request intervals and fact receipt times are separate observations.</p><main id="panes"></main>
  <script type="application/json" id="data">${data}</script><script>
  const runs=JSON.parse(document.getElementById('data').textContent);
  for(const run of runs){const section=document.createElement('section');document.getElementById('panes').append(section);
    const title=document.createElement('h2');title.textContent=run.runId;section.append(title);
    const hash=document.createElement('small');hash.textContent='Manifest SHA-256 '+run.hash;section.append(hash);
    const slider=document.createElement('input');slider.type='range';slider.min='0';slider.max=String(Math.max(0,run.frames.length-1));slider.value='0';slider.setAttribute('aria-label','Saved frame');section.append(slider);
    const stamp=document.createElement('p'),image=document.createElement('img'),values=document.createElement('pre');image.alt='Original observed frame';section.append(stamp,image);
    const select=document.createElement('select');select.setAttribute('aria-label','Semantic element');for(const name of [...new Set(run.facts.map(f=>f.element))]){const o=document.createElement('option');o.value=name;o.textContent=name;select.append(o)}section.append(select,values);
    const detail=document.createElement('details'),summary=document.createElement('summary'),validation=document.createElement('pre');summary.textContent='Coverage and validation';validation.textContent=JSON.stringify({issues:run.issues,validation:run.validation},null,2);detail.append(summary,validation);section.append(detail);
    function draw(){const frame=run.frames[Number(slider.value)];if(!frame){stamp.textContent='No retained frames';image.hidden=true;return}image.src=frame.data;stamp.textContent=frame.channel+' | request ['+frame.time.requestStartMs?.toFixed(2)+', '+frame.time.requestEndMs?.toFixed(2)+'] host ms | '+frame.path;
      const candidates=run.facts.filter(f=>f.element===select.value);const nearest=candidates.reduce((a,f)=>Math.abs(f.time.hostMs-frame.time.hostMs)<Math.abs(a-frame.time.hostMs)?f.time.hostMs:a,Infinity);
      values.textContent=JSON.stringify({selection:'nearest fact receipt, not a simultaneous measurement',distanceMs:Math.abs(nearest-frame.time.hostMs),facts:candidates.filter(f=>f.time.hostMs===nearest)},null,2);}
    slider.oninput=draw;select.onchange=draw;draw();
  }</script></html>`;
  await writeFile(outputFile, html, { flag: "wx" });
  return { path: outputFile, runs: comparisonPath ? 2 : 1 };
}
