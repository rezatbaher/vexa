import { Page } from "playwright";
import { log } from "../_host";
import { countRealParticipantTilesStrict } from "./admission";

/** Leave only after a continuous interval of positively established aloneness.
 * Unknown DOM observations break continuity; audio silence is never presence evidence.
 */

/** Poll cadence. 15s against a window measured in minutes — the removal monitor's 1.5s buys
 *  nothing here and this runs for the whole life of the meeting. */
export const ALONE_POLL_MS = 15_000;

/** Matches the API's own `_AUTOMATIC_LEAVE_DEFAULTS["everyoneLeftTimeout"]` (900_000). Deliberately
 *  NOT the 120_000 in `deriveMaxActiveMs` — that value is a floor input to the 4h backstop, never a
 *  real leave timeout, and inheriting it here would make the bot leave far sooner than any
 *  deployment has configured. */
export const DEFAULT_EVERYONE_LEFT_MS = 900_000;

export interface AlonenessOptions {
  /** Continuous alone time before leaving. `<= 0` disables the monitor entirely. */
  timeoutMs?: number;
  pollMs?: number;
  /** Injectable clock — tests drive the window without sleeping. */
  now?: () => number;
  readPresence?: () => Promise<"alone" | "occupied" | "unknown">;
}

/**
 * Watch for the meeting emptying out. Fires `onAlone` at most once, then stops polling.
 * Returns a stop fn. Observation failure breaks the confirmed-empty interval.
 */
export function startGoogleAlonenessMonitor(
  page: Page,
  onAlone?: () => void | Promise<void>,
  opts: AlonenessOptions = {},
): () => void {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EVERYONE_LEFT_MS;
  const pollMs = opts.pollMs ?? ALONE_POLL_MS;
  const now = opts.now ?? (() => Date.now());

  if (!(timeoutMs > 0)) {
    log(`[alone] everyoneLeftTimeout disabled (${timeoutMs}) — not monitoring for an empty room`);
    return () => { /* nothing started */ };
  }

  log(`[alone] watching for an empty room (leave after ${Math.round(timeoutMs / 1000)}s alone, poll ${pollMs}ms)`);
  let aloneSince: number | null = null;
  let fired = false;

  const tick = async (): Promise<void> => {
    if (fired) return;
    const presence = await (opts.readPresence ? opts.readPresence() :
      countRealParticipantTilesStrict(page).then(count => count !== null && count >= 2 ? "occupied" : "unknown"))
      .catch(() => "unknown" as const);
    if (presence === "unknown") { aloneSince = null; return; }

    if (presence === "occupied") {
      if (aloneSince !== null) {
        log("[alone] another participant is present again — clearing the empty-room timer");
        aloneSince = null;
      }
      return;
    }

    if (aloneSince === null) {
      aloneSince = now();
      log("[alone] confirmed self-only room — starting the empty-room timer");
      return;
    }

    const elapsed = now() - aloneSince;
    if (elapsed < timeoutMs) return;

    fired = true;
    stop();
    log(`🚪 [alone] alone for ${Math.round(elapsed / 1000)}s — leaving (left_alone)`);
    await onAlone?.();
  };

  const interval = setInterval(() => {
    // setInterval does not await: an unhandled rejection here would be invisible AND would leave the
    // timer running with no further effect. Swallow to "no evidence" and try again next poll.
    void tick().catch((e: any) => { aloneSince = null; log(`[alone] observation unavailable: ${e?.message ?? e}`); });
  }, pollMs);

  const stop = (): void => { clearInterval(interval); };
  return stop;
}
