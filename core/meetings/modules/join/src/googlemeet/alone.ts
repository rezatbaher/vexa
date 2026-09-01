import { Page } from "playwright";
import { log } from "../_host";
import { countRealParticipantTilesStrict } from "./admission";

/**
 * "Everyone left" detection for Google Meet — the timer `automaticLeave.everyoneLeftTimeout` has
 * always described and never armed.
 *
 * The gap this closes (production, 2026-09-01): a bot was admitted, recorded 34 chunks, and at
 * 12:36 the last human left. Every speaker stream went to `max=0.0000`, Meet navigated the page to
 * its post-call screen, the bot re-injected its browser utils onto the new page and carried on —
 * for another 80 minutes at 37% of a CPU core, never emitting a final chunk, until a human killed
 * the container. Nothing in the bot was watching for the room emptying: `everyoneLeftTimeout` is
 * validated by the API, defaulted to 15 min, serialized into invocation.v1 and then read in exactly
 * one place — as a *floor input* to the 4h `maxActiveMs` backstop. `left_alone` is declared in
 * contracts.ts and was unreachable from bot code. So the only exits were an operator stop, the
 * platform rendering an end screen the removal poller happened to match, or 4 hours.
 *
 * ── Why PRESENCE and not silence ──────────────────────────────────────────────────────────────
 * Audio silence is NOT evidence a meeting is over — people mute and listen, and the control plane
 * pins the opposite invariant explicitly (`test_lifecycle_seam.py`: "a quiet-but-LIVE bot must NOT
 * be reaped on silence alone"). The per-speaker RMS gates already in the pipeline are transcription
 * concerns and deliberately have no lifecycle effect. This monitor therefore reads participant
 * TILES and never looks at audio.
 *
 * ── Why it can only ever be late, never early ─────────────────────────────────────────────────
 *  * A read that FAILS returns `null` and is treated as no evidence — it neither starts nor clears
 *    the clock. Fail-safe is "stay in the meeting"; a broken selector degrades to today's 4h cap
 *    rather than dropping the bot out of a live call.
 *  * The window is CONTINUOUS: one sighting of another participant clears it outright, so a
 *    transient layout/view change cannot accumulate toward a leave.
 *  * `<= 1` is the alone test because a seated bot renders its OWN tile — 1 means "just me", and 0
 *    means the tiles are gone entirely (the post-call screen the incident bot was sitting on).
 *
 * Meet only. Jitsi already ends reliably (`APP.conference.isJoined()` flips) and Zoom watches
 * navigation; Teams shares this gap but its DOM is not verified here, so it is left uncovered
 * rather than guessed at.
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
}

/**
 * Watch for the meeting emptying out. Fires `onAlone` at most once, then stops polling.
 * Returns a stop fn. Never throws; a poll that throws is swallowed as "no evidence".
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
    const tiles = await countRealParticipantTilesStrict(page);

    // No evidence either way — hold the clock exactly where it is. Neither arming nor clearing on a
    // failed read is what keeps a selector break from BOTH leaving a live meeting and silently
    // disabling the timer.
    if (tiles === null) return;

    if (tiles >= 2) {
      if (aloneSince !== null) {
        log("[alone] another participant is present again — clearing the empty-room timer");
        aloneSince = null;
      }
      return;
    }

    if (aloneSince === null) {
      aloneSince = now();
      log(`[alone] no other participants (${tiles} tile(s)) — starting the empty-room timer`);
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
    void tick().catch((e: any) => log(`[alone] poll error (ignored): ${e?.message ?? e}`));
  }, pollMs);

  const stop = (): void => { clearInterval(interval); };
  return stop;
}
