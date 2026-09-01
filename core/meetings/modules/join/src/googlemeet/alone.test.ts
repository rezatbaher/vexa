/**
 * Regression guard for the Google Meet "everyone left" detector.
 *
 * THE INCIDENT (production, 2026-09-01): a bot was admitted to a 3-person call, recorded 34 chunks,
 * and at 12:36 the last human left. Every speaker stream went silent (`max=0.0000`), Meet navigated
 * the page to its post-call screen, and the bot re-injected its browser utils and kept running for
 * another 80 minutes at 37% of a CPU core — never emitting a final chunk — until a human deleted the
 * container. `automaticLeave.everyoneLeftTimeout` was validated by the API, defaulted to 15 min and
 * serialized into the invocation, but the bot only ever read it as a floor input to the 4h
 * `maxActiveMs` backstop; `left_alone` was declared in contracts.ts and unreachable from bot code.
 *
 * The tests below pin BOTH directions, because the dangerous failure is the opposite one: a detector
 * that leaves a LIVE meeting is far worse than one that leaves a dead one late. In particular a
 * failed DOM read must never be mistaken for an empty room — `countRealParticipantTiles` collapses
 * "read failed" and "0 tiles" into 0, which is right for an admission check and catastrophic for a
 * leave decision, so this path uses the strict reader and treats `null` as no evidence at all.
 *
 * No browser, no live meeting, no Google: a fabricated page + an injected clock.
 *
 * Run: npx tsx src/googlemeet/alone.test.ts
 */

import { startGoogleAlonenessMonitor } from './alone';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Page stand-in exposing only what the strict tile reader touches. `tiles` is read fresh on every
 *  poll so a test can change presence mid-window; `throws` makes evaluateAll reject (the failed-read
 *  case). */
function mockPage(state: { tiles: string[]; throws?: boolean }): any {
  return {
    locator: () => ({
      evaluateAll: async () => {
        if (state.throws) throw new Error('Execution context was destroyed');
        return state.tiles;
      },
    }),
  };
}

let passed = 0, failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name} (expected ${expected}, got ${actual})`); failed++; }
}

/** Drive the monitor over a scripted timeline. Each step may mutate the page state and/or advance
 *  the INJECTED clock; real time only ever has to cover a few 1ms polls. */
async function run(
  state: { tiles: string[]; throws?: boolean },
  steps: Array<{ advanceMs?: number; tiles?: string[]; throws?: boolean }>,
  timeoutMs = 1000,
): Promise<number> {
  let fires = 0;
  let fakeNow = 0;
  const stop = startGoogleAlonenessMonitor(
    mockPage(state),
    () => { fires++; },
    { timeoutMs, pollMs: 1, now: () => fakeNow },
  );
  await sleep(30); // let the first polls land
  for (const s of steps) {
    if (s.tiles !== undefined) state.tiles = s.tiles;
    if (s.throws !== undefined) state.throws = s.throws;
    if (s.advanceMs) fakeNow += s.advanceMs;
    await sleep(30);
  }
  stop();
  return fires;
}

(async () => {
  console.log('\n=== Google Meet empty-room detector (everyoneLeftTimeout) ===');

  // 1. THE INCIDENT. Only the bot's own tile remains for longer than the window → leave.
  check(
    'alone (self tile only) past the window → fires left_alone',
    await run({ tiles: ['Vexa Bot'] }, [{ advanceMs: 1500 }]),
    1,
  );

  // 2. Post-call screen: the tiles are gone entirely. Same verdict — nobody is there.
  check(
    'no tiles at all (post-call screen) past the window → fires',
    await run({ tiles: [] }, [{ advanceMs: 1500 }]),
    1,
  );

  // 3. Not yet elapsed → patience. The window is the whole safety margin.
  check(
    'alone but inside the window → does NOT fire',
    await run({ tiles: ['Vexa Bot'] }, [{ advanceMs: 500 }]),
    0,
  );

  // 4. CONTROL — a populated meeting is never left, however long it runs.
  check(
    'two participants present → never fires (a live meeting is never left)',
    await run({ tiles: ['Vexa Bot', 'Reza Baher'] }, [{ advanceMs: 10_000 }]),
    0,
  );

  // 5. CONTINUOUS window: someone rejoining CLEARS the clock, so the original deadline passing
  //    afterwards means nothing. Without this a brief view/layout change could accumulate.
  check(
    'alone, then someone rejoins → clock resets → does NOT fire past the original deadline',
    await run({ tiles: ['Vexa Bot'] }, [
      { advanceMs: 900 },                          // nearly elapsed while alone
      { tiles: ['Vexa Bot', 'Reza Baher'] },       // …but someone is back
      { advanceMs: 900 },                          // past the ORIGINAL deadline
    ]),
    0,
  );

  // 6. 🔴 THE FAIL-SAFE. A DOM read that THROWS is not evidence of an empty room. If this regressed
  //    to the lenient reader (errors → 0 tiles), a broken selector or a navigation race would drop
  //    the bot out of a live call.
  check(
    'read failures only → never fires (a failed read is not an empty room)',
    await run({ tiles: ['Vexa Bot', 'Reza Baher'], throws: true }, [{ advanceMs: 10_000 }]),
    0,
  );

  // 7. …and a failed read mid-window neither arms nor clears: the window survives the blip, so a
  //    genuinely empty room is still left (late, never early).
  check(
    'alone → read fails → alone again: window survives the blip and still fires',
    await run({ tiles: ['Vexa Bot'] }, [
      { advanceMs: 400 },
      { throws: true, advanceMs: 400 },
      { throws: false, advanceMs: 400 },
    ]),
    1,
  );

  // 8. One meeting, one leave: the callback must not be re-entered on later polls.
  check(
    'fires at most once',
    await run({ tiles: [] }, [{ advanceMs: 2000 }, { advanceMs: 2000 }, { advanceMs: 2000 }]),
    1,
  );

  // 9. Disabled explicitly → the monitor never starts (0 keeps the pre-fix 4h-backstop behaviour).
  check(
    'timeoutMs <= 0 → disabled, never fires',
    await run({ tiles: [] }, [{ advanceMs: 10_000 }], 0),
    0,
  );

  console.log(`\n=== summary: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
