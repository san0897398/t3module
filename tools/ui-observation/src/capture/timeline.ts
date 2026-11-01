import { randomUUID } from "node:crypto";
import type {
  CdpAdapter,
  Clock,
  ElementSpec,
  Scope,
  BundleWriterPort,
} from "../contracts.js";
import {
  readRenderer,
  readingFacts,
  type RendererReading,
} from "./snapshot.js";
import { intervals } from "./clock.js";

export async function startTimeline(
  cdp: CdpAdapter,
  specs: ElementSpec[],
  scope: Scope,
  writer: BundleWriterPort,
  clock: Clock,
  maxRecords: number,
  active: () => boolean = () => true,
  onReplacement: (element: string) => void = () => undefined,
) {
  const name = `__radix_observation_${randomUUID().replaceAll("-", "")}`;
  const times: number[] = [];
  let received = 0;
  let lastSequence = 0;
  let gaps = 0;
  let rejected = 0;
  const off = cdp.onEvent((event) => {
    if (
      !active() ||
      event.method !== "Runtime.bindingCalled" ||
      event.params.name !== name
    )
      return;
    try {
      const data = JSON.parse(String(event.params.payload)) as {
        sequence: number;
        kind: string;
        reading?: RendererReading;
        [key: string]: unknown;
      };
      received++;
      if (data.sequence !== lastSequence + 1) gaps++;
      lastSequence = data.sequence;
      if (data.kind === "target-replaced") onReplacement(String(data.element));
      if (data.kind === "sample" && data.reading) {
        times.push(data.reading.rendererMs);
        const facts = readingFacts(
          data.reading,
          scope,
          { hostMs: clock.now() },
          `samples.jsonl#source-sequence=${data.sequence}`,
          `sample:${data.sequence}`,
        );
        if (!writer.record("samples", { ...data, facts, scope })) rejected++;
      } else if (
        !writer.record("events", {
          ...data,
          scope,
          originalClock: "renderer-performance",
        })
      )
        rejected++;
    } catch (error) {
      writer.record("events", {
        kind: "observer-error",
        error: String(error),
        scope,
      });
    }
  });
  await cdp.send("Runtime.addBinding", { name });
  const expression = `(() => {
    const name=${JSON.stringify(name)}, specs=${JSON.stringify(specs)}, read=${readRenderer.toString()};
    let sequence=0, stopped=false, raf=0, capped=0; const costs=[];
    const identities=specs.map(s=>({key:s.key,selector:s.selector,node:document.querySelector(s.selector)}));
    const emit=(data)=>{if(sequence>=${maxRecords}){capped++;return;} globalThis[name](JSON.stringify({...data,sequence:++sequence}));};
    const sample=()=>{if(stopped)return; const start=performance.now(); for(const identity of identities){if(document.querySelector(identity.selector)!==identity.node){emit({kind:'target-replaced',element:identity.key,rendererMs:performance.now()});stopped=true;return;}} try { emit({kind:'sample',reading:read(specs,true)}); } catch(e) {emit({kind:'observer-error',error:String(e),rendererMs:performance.now()});} costs.push(performance.now()-start); if(costs.length>10000)costs.shift(); raf=requestAnimationFrame(sample);};
    const relevant=n=>specs.some(s=>{const e=document.querySelector(s.selector);return e&&(e===n||e.contains(n)||n instanceof Element&&n.contains(e));});
    const observer=new MutationObserver(records=>{const selected=records.filter(r=>relevant(r.target));if(selected.length)emit({kind:'mutation',rendererMs:performance.now(),records:selected.slice(0,50).map(r=>({type:r.type,attributeName:r.attributeName,targetTag:r.target.nodeName})),omitted:Math.max(0,selected.length-50)});});
    for(const spec of specs){const el=document.querySelector(spec.selector);if(el){observer.observe(el,{attributes:true,childList:true,subtree:true,characterData:true}); let p=el.parentElement;for(let i=0;p&&i<spec.ancestors;i++,p=p.parentElement)observer.observe(p,{attributes:true});}}
    const animation=e=>{if(relevant(e.target))emit({kind:e.type,rendererMs:performance.now(),eventTimeStamp:e.timeStamp,animationName:e.animationName??null,elapsedTimeSeconds:e.elapsedTime??null});};
    const types=['animationstart','animationiteration','animationend','animationcancel','transitionrun','transitionend','transitioncancel'];types.forEach(t=>document.addEventListener(t,animation,true));
    globalThis[name+'_stop']=()=>{stopped=true;cancelAnimationFrame(raf);observer.disconnect();types.forEach(t=>document.removeEventListener(t,animation,true));delete globalThis[name+'_stop'];return{lastSequence:sequence,capped,costsMs:costs,rendererMs:performance.now()};};
    const startedAt=performance.now(); sample(); return {ready:true,rendererMs:startedAt,timeOrigin:performance.timeOrigin};
  })()`;
  let startedAt = 0;
  try {
    const ready = await cdp.evaluate<{ ready: boolean; rendererMs: number }>(
      expression,
    );
    if (!ready.ready)
      throw new Error("Renderer observer did not acknowledge readiness");
    startedAt = ready.rendererMs;
  } catch (e) {
    off();
    await cdp.send("Runtime.removeBinding", { name }).catch(() => undefined);
    throw e;
  }
  return {
    async stop() {
      let stats: {
        lastSequence: number;
        capped: number;
        costsMs: number[];
        rendererMs: number;
      } | null = null;
      let error: string | null = null;
      try {
        stats = await cdp.evaluate(
          `globalThis[${JSON.stringify(name + "_stop")}]?.() ?? null`,
        );
      } catch (e) {
        error = String(e);
      }
      // The evaluate response is ordered after prior binding notifications on
      // this socket. No process-wide occurrence ordering is inferred.
      off();
      await cdp.send("Runtime.removeBinding", { name }).catch((e) => {
        error ??= String(e);
      });
      await cdp
        .evaluate(`delete globalThis[${JSON.stringify(name)}]`)
        .catch((e) => {
          error ??= String(e);
        });
      const sampling = intervals(times);
      const coverage = {
        startMs: startedAt,
        endMs: stats?.rendererMs ?? null,
        leadingGapMs: times.length ? times[0]! - startedAt : null,
        trailingGapMs:
          times.length && stats ? stats.rendererMs - times.at(-1)! : null,
      };
      const coverageGaps = [
        sampling.maxGapMs,
        coverage.leadingGapMs,
        coverage.trailingGapMs,
      ].filter((n): n is number => n !== null);
      return {
        source: stats,
        received,
        lastReceivedSequence: lastSequence,
        sequenceGaps: gaps,
        writerRejected: rejected,
        intervals: {
          ...sampling,
          maxGapMs: coverageGaps.length ? Math.max(...coverageGaps) : null,
        },
        coverage,
        error,
        complete:
          !!stats &&
          stats.lastSequence === lastSequence &&
          !stats.capped &&
          !gaps &&
          !rejected &&
          !error,
      };
    },
  };
}
