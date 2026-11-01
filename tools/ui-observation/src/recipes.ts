import {
  ObservationError,
  SceneSchema,
  type Action,
  type CdpAdapter,
  type Clock,
  type Condition,
  type DesktopAdapter,
} from "./contracts.js";
export const parseScene = (input: unknown) => SceneSchema.parse(input);
export async function waitCondition(
  cdp: CdpAdapter,
  condition: Condition,
  clock: Clock,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = clock.now() + condition.timeoutMs;
  do {
    signal?.throwIfAborted();
    const ok = await cdp.evaluate<boolean>(
      `(() => { const c=${JSON.stringify(condition)}; const all=document.querySelectorAll(c.selector); if(all.length!==1)return false; const e=all[0]; return (!c.attribute || e.getAttribute(c.attribute)===c.equals) && (!c.textIncludes || (e.textContent||'').includes(c.textIncludes)); })()`,
    );
    if (ok) return;
    await clock.sleep(50, signal);
  } while (clock.now() < deadline);
  throw new ObservationError(
    "POSTCONDITION_TIMEOUT",
    `Not observed: ${condition.selector}`,
    "action",
  );
}
export async function executeAction(
  action: Action,
  cdp: CdpAdapter | undefined,
  desktop: DesktopAdapter | undefined,
  clock: Clock,
  log: (entry: unknown) => void,
  signal?: AbortSignal,
) {
  if (!cdp)
    throw new ObservationError(
      "POSTCONDITION_UNSUPPORTED",
      "This release requires a CDP postcondition; OS-only inputs are not sent without an independent verifier",
    );
  signal?.throwIfAborted();
  const started = clock.now();
  let inputError: string | undefined;
  let receipt:
    | { delivery: "acknowledged" | "unknown" | "refused"; raw: unknown }
    | undefined;
  try {
    if (action.kind === "desktop-click")
      receipt = await desktop!.click(action.selector, action.delivery!);
    else {
      const point = await cdp.evaluate<{ x: number; y: number }>(
        `(() => {const a=document.querySelectorAll(${JSON.stringify(action.selector)}); if(a.length!==1)throw Error('Ambiguous action target');const r=a[0].getBoundingClientRect();if(!r.width||!r.height)throw Error('Invisible action target');return{x:r.x+r.width/2,y:r.y+r.height/2};})()`,
      );
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "left",
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        clickCount: 1,
      });
    }
  } catch (error) {
    inputError = String(error);
  }
  // Observe after an uncertain delivery, without retransmitting it.
  try {
    await waitCondition(cdp, action.after, clock, signal);
    log({
      action,
      started,
      completed: clock.now(),
      delivery: inputError ? "unknown" : (receipt?.delivery ?? "acknowledged"),
      receipt: receipt?.raw,
      inputError,
      postcondition: "observed",
    });
  } catch (error) {
    log({
      action,
      started,
      completed: clock.now(),
      delivery: inputError ? "unknown" : (receipt?.delivery ?? "acknowledged"),
      receipt: receipt?.raw,
      inputError,
      postcondition: "unknown",
      error: String(error),
    });
    throw error;
  }
}
