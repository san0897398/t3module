import type { Protocol } from "devtools-protocol";
import {
  type CdpAdapter,
  type ElementSpec,
  type Fact,
  type Issue,
  type Scope,
  type Time,
} from "../contracts.js";

export interface ElementReading {
  key: string;
  selector: string;
  relation: string;
  tag: string;
  rect: { x: number; y: number; width: number; height: number } | null;
  styles: Record<string, string>;
  attributes: Record<string, string | null>;
  text: string;
  svg: Record<string, unknown> | null;
}
export interface RendererReading {
  rendererMs: number;
  rendererTimeOriginMs: number;
  url: string;
  conditions: {
    viewport: { width: number; height: number };
    dpr: number;
    theme: string;
    reducedMotion: boolean;
    scroll: { x: number; y: number };
    zoom: number;
    fonts: string[];
  };
  visualViewport: {
    width: number;
    height: number;
    offsetLeft: number;
    offsetTop: number;
    scale: number;
  };
  elements: ElementReading[];
  missing: { key: string; count: number }[];
}

// Executed inside the explicitly bound renderer context. This function must
// remain self-contained: both snapshot and rAF sampling use exactly this reader.
export function readRenderer(
  specs: ElementSpec[],
  temporal = false,
): RendererReading {
  const elements: ElementReading[] = [];
  const missing: { key: string; count: number }[] = [];
  function read(
    el: Element,
    spec: ElementSpec,
    key: string,
    relation: string,
    pseudo?: string,
  ) {
    const style = getComputedStyle(el, pseudo);
    const rect = el.getBoundingClientRect();
    const styles = Object.fromEntries(
      spec.properties.map((p) => [p, style.getPropertyValue(p)]),
    );
    let svg: Record<string, unknown> | null = null;
    if (!pseudo && el instanceof SVGElement) {
      svg = {
        d: el.getAttribute("d"),
        ...(temporal ? {} : { markup: el.outerHTML }),
      };
      if (el instanceof SVGGeometryElement) {
        try {
          const length = el.getTotalLength();
          const a = el.getPointAtLength(0);
          const b = el.getPointAtLength(length);
          svg.length = length;
          svg.startLocal = { x: a.x, y: a.y };
          svg.endLocal = { x: b.x, y: b.y };
          const m = el.getScreenCTM();
          svg.screenCTM = m
            ? { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f }
            : null;
        } catch {
          /* unrendered SVG remains without geometry */
        }
      }
    }
    elements.push({
      key,
      selector: spec.selector,
      relation,
      tag: el.tagName,
      rect: pseudo
        ? null
        : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles,
      attributes: pseudo
        ? {}
        : Object.fromEntries(
            spec.attributes.map((a) => [a, el.getAttribute(a)]),
          ),
      text: pseudo || temporal ? "" : (el.textContent ?? "").slice(0, 4096),
      svg,
    });
  }
  for (const spec of specs) {
    const matches = document.querySelectorAll(spec.selector);
    if (matches.length !== 1) {
      missing.push({ key: spec.key, count: matches.length });
      continue;
    }
    const element = matches[0]!;
    read(element, spec, spec.key, "self");
    for (const pseudo of spec.pseudos)
      read(element, spec, `${spec.key}${pseudo}`, pseudo, pseudo);
    let ancestor = element.parentElement;
    for (
      let i = 1;
      ancestor && i <= spec.ancestors;
      i++, ancestor = ancestor.parentElement
    )
      read(ancestor, spec, `${spec.key}/ancestor/${i}`, `ancestor:${i}`);
  }
  return {
    rendererMs: performance.now(),
    rendererTimeOriginMs: performance.timeOrigin,
    url: location.href,
    visualViewport: {
      width: visualViewport?.width ?? innerWidth,
      height: visualViewport?.height ?? innerHeight,
      offsetLeft: visualViewport?.offsetLeft ?? 0,
      offsetTop: visualViewport?.offsetTop ?? 0,
      scale: visualViewport?.scale ?? 1,
    },
    conditions: {
      viewport: { width: innerWidth, height: innerHeight },
      dpr: devicePixelRatio,
      theme: matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      scroll: { x: scrollX, y: scrollY },
      zoom: visualViewport?.scale ?? 1,
      fonts: [...document.fonts].map((f) => `${f.family}:${f.status}`).sort(),
    },
    elements,
    missing,
  };
}

export function readingFacts(
  reading: RendererReading,
  scope: Scope,
  time: Time,
  evidence: string,
  prefix: string,
): Fact[] {
  const facts: Fact[] = [];
  const stamp = {
    ...time,
    rendererMs: reading.rendererMs,
    rendererTimeOriginMs: reading.rendererTimeOriginMs,
  };
  const add = (
    element: string,
    property: string,
    value: unknown,
    unit: string,
    method: string,
    kind: Fact["provenance"]["kind"] = "observed",
    reason?: string,
  ) => {
    facts.push({
      id: `${prefix}:${facts.length}`,
      element,
      property,
      value: value as Fact["value"],
      unit,
      scope,
      time: stamp,
      provenance: {
        kind,
        method,
        evidence: [evidence],
        ...(reason ? { reason } : {}),
      },
    });
  };
  for (const e of reading.elements) {
    if (e.rect)
      for (const [key, value] of Object.entries(e.rect))
        add(e.key, `rect.${key}`, value, "CSS px", "getBoundingClientRect");
    else
      add(
        e.key,
        "rect",
        null,
        "CSS px",
        "pseudo-element geometry",
        "unknown",
        "CSS pseudo-elements do not expose getBoundingClientRect; no host rectangle substitution",
      );
    for (const [property, value] of Object.entries(e.styles))
      add(
        e.key,
        `style.${property}`,
        value,
        "CSS serialized value",
        "getComputedStyle",
      );
    for (const [property, value] of Object.entries(e.attributes))
      add(e.key, `attribute.${property}`, value, "attribute", "getAttribute");
    add(
      e.key,
      "dom.relation",
      e.relation,
      "DOM relation",
      "parentElement traversal",
    );
    if (e.svg)
      for (const [property, value] of Object.entries(e.svg))
        add(
          e.key,
          `svg.${property}`,
          value,
          "SVG user units or markup",
          "SVG DOM API",
        );
  }
  for (const m of reading.missing)
    add(
      m.key,
      "presence",
      null,
      "element",
      "querySelectorAll",
      "unknown",
      `Expected exactly one match, found ${m.count}`,
    );
  return facts;
}

export async function captureSnapshot(
  cdp: CdpAdapter,
  specs: ElementSpec[],
  fullDocument: boolean,
) {
  const reading = await cdp.evaluate<RendererReading>(
    `(${readRenderer.toString()})(${JSON.stringify(specs)})`,
  );
  const dom: unknown[] = [];
  const styles: unknown[] = [];
  const issues: Issue[] = [];
  // DOMSnapshot is inherently document-wide. Only collect its raw response if
  // the recipe explicitly opts in; the default DOM/CSS path stays scoped.
  let documentSnapshot: unknown;
  if (fullDocument)
    documentSnapshot = await cdp.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [...new Set(specs.flatMap((s) => s.properties))],
      includePaintOrder: true,
      includeDOMRects: true,
    });
  await cdp.send("DOM.getDocument", { depth: 1, pierce: false });
  for (const spec of specs) {
    let objectId: string | undefined;
    try {
      if (reading.missing.some((m) => m.key === spec.key)) continue;
      const resolved = await cdp.send<Protocol.Runtime.EvaluateResponse>(
        "Runtime.evaluate",
        {
          expression: `document.querySelector(${JSON.stringify(spec.selector)})`,
          returnByValue: false,
        },
      );
      objectId = resolved.result.objectId;
      if (!objectId) throw new Error("No element object in bound frame");
      const { nodeId } = await cdp.send<Protocol.DOM.RequestNodeResponse>(
        "DOM.requestNode",
        { objectId },
      );
      dom.push({
        key: spec.key,
        ...((await cdp.send("DOM.describeNode", {
          nodeId,
          depth: 1,
          pierce: false,
        })) as object),
      });
      styles.push({
        key: spec.key,
        nodeId,
        matched: await cdp.send("CSS.getMatchedStylesForNode", { nodeId }),
        computed: await cdp.send("CSS.getComputedStyleForNode", { nodeId }),
      });
    } catch (error) {
      issues.push({
        code: "STYLE_OR_DOM_UNAVAILABLE",
        message: String(error),
        scope: spec.key,
      });
    } finally {
      if (objectId)
        await cdp
          .send("Runtime.releaseObject", { objectId })
          .catch(() => undefined);
    }
  }
  return {
    reading,
    dom: {
      scope: fullDocument ? "full-document" : "selected-elements-depth-1",
      nodes: dom,
      documentSnapshot,
    },
    styles,
    issues,
  };
}
