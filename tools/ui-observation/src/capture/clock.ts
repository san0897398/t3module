import type { CdpAdapter, Clock } from "../contracts.js";
export interface ClockMapping {
  hostStartMs: number;
  hostEndMs: number;
  rendererMs: number;
  rendererTimeOriginMs: number;
  hostMinusRendererMs: number;
  uncertaintyMs: number;
  method: string;
}
export async function calibrateClock(
  cdp: CdpAdapter,
  clock: Clock,
): Promise<ClockMapping> {
  const hostStartMs = clock.now();
  const time = await cdp.evaluate<{ now: number; origin: number }>(
    "({now:performance.now(),origin:performance.timeOrigin})",
  );
  const hostEndMs = clock.now();
  return {
    hostStartMs,
    hostEndMs,
    rendererMs: time.now,
    rendererTimeOriginMs: time.origin,
    hostMinusRendererMs: (hostStartMs + hostEndMs) / 2 - time.now,
    uncertaintyMs: (hostEndMs - hostStartMs) / 2,
    method:
      "round-trip midpoint; interval bound, not a shared occurrence clock",
  };
}
export function intervals(times: number[]) {
  const gaps = times.slice(1).map((t, i) => t - times[i]!);
  return {
    count: times.length,
    gapsMs: gaps,
    maxGapMs: gaps.length ? Math.max(...gaps) : null,
    meanGapMs: gaps.length
      ? gaps.reduce((a, b) => a + b, 0) / gaps.length
      : null,
  };
}
