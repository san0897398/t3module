import { PNG } from "pngjs";
import type { RendererReading } from "./snapshot.js";
export function coordinateMapping(
  reading: RendererReading,
  pngBytes: Uint8Array,
) {
  const image = PNG.sync.read(Buffer.from(pngBytes));
  const viewport = reading.visualViewport;
  const xScale = image.width / viewport.width,
    yScale = image.height / viewport.height;
  return {
    cssViewport: reading.conditions.viewport,
    visualViewport: viewport,
    scrollCss: reading.conditions.scroll,
    devicePixelRatio: reading.conditions.dpr,
    visualViewportScale: reading.conditions.zoom,
    image: {
      width: image.width,
      height: image.height,
      coordinateSpace: "renderer viewport PNG pixels",
    },
    cssToImage: {
      xScale,
      yScale,
      xOffset: -viewport.offsetLeft * xScale,
      yOffset: -viewport.offsetTop * yScale,
      provenance:
        "calculated from image dimensions and measured visual viewport; not an independent validation",
    },
    validation: {
      status: "unknown",
      independentPixelSamples: 0,
      reason:
        "Requires independent identifiable pixel anchors; DOM coordinates cannot validate themselves",
    },
    osToRenderer: {
      status: "unknown",
      reason:
        "Window bounds alone do not establish renderer content origin or display scale",
    },
  };
}
export interface PixelAnchor {
  css: { x: number; y: number };
  pixel: { x: number; y: number };
  evidence: string;
}
export function validateMapping(
  transform: {
    xScale: number;
    yScale: number;
    xOffset: number;
    yOffset: number;
  },
  anchors: PixelAnchor[],
  tolerance = 2,
) {
  const errors = anchors.map((a) => ({
    evidence: a.evidence,
    errorPx: Math.hypot(
      a.css.x * transform.xScale + transform.xOffset - a.pixel.x,
      a.css.y * transform.yScale + transform.yOffset - a.pixel.y,
    ),
  }));
  return {
    status:
      anchors.length < 20
        ? "unknown"
        : errors.every((e) => e.errorPx <= tolerance)
          ? "pass"
          : "fail",
    samples: anchors.length,
    tolerancePx: tolerance,
    maxErrorPx: errors.length
      ? Math.max(...errors.map((e) => e.errorPx))
      : null,
    errors,
  };
}
