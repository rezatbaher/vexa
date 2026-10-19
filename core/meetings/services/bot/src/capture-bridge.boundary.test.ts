/**
 * L3 boundary — Teams speaker hints cross the page→Node boundary (#498 C4).
 *
 * Launches the REAL bridge wiring end-to-end, no meeting and no display:
 *   1. asserts the built browser bundle (dist/browser-utils.global.js) exposes
 *      createTeamsSpeakers (the regression that shipped seg_N: the brick missing
 *      from the bundle);
 *   2. headless Chromium (the same launchPersistentBrowser the bot uses) loads a
 *      static fixture page with a Teams-shaped DOM — a participant tile carrying
 *      the voice-level-stream-outline signal — plus a 1:1-layout tile WITHOUT the
 *      outline (the #481 two-party class: no signal ⇒ no hint, never a wrong one);
 *   3. startCaptureBridge (the real function) wires the page; the fixture toggles
 *      the vdi-frame-occlusion speaking signal; the test asserts the hints arrive
 *      Node-side with the participant's NAME, epoch tMs, and start/end order.
 *
 * Where headless Chromium cannot launch (no playwright browser in the env) the test
 * SKIPS LOUDLY with exit 0 — the same green-or-skip shape as gate:stack.
 * Run: npx tsx src/capture-bridge.boundary.test.ts
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPersistentBrowser, type BrowserContext } from '@vexa/remote-browser';
import { startCaptureBridge } from './capture-bridge.js';
import { ensureMeetingMicUnmuted } from './meeting-dom.js';
import type { BotPipeline, HintCounters } from './pipeline.js';
import type { Invocation } from './config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = join(HERE, '..');
const BUNDLE = join(BOT_DIR, 'dist', 'browser-utils.global.js');

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FIXTURE = `<!doctype html><html><body>
  <div data-tid="participant-tile" id="alice-tile">
    <span title="Alice Fixture">Alice Fixture</span>
    <div data-tid="voice-level-stream-outline" id="alice-outline"></div>
  </div>
  <!-- #481 two-party (1:1) layout class: the outline indicator never renders.
       The watcher must emit NO hint for this tile (no signal ⇒ silence, not a guess). -->
  <div data-tid="participant-tile" id="bob-tile">
    <span title="Bob OneToOne">Bob OneToOne</span>
  </div>
</body></html>`;

async function main(): Promise<void> {
  // ── 1) the bundle carries the Teams brick (the shipped regression) ──
  if (!existsSync(BUNDLE)) execSync('node build-browser-utils.mjs', { cwd: BOT_DIR, stdio: 'inherit' });
  const bundleHasTeams = execSync(`grep -c createTeamsSpeakers ${JSON.stringify(BUNDLE)} || true`).toString().trim() !== '0';
  check('browser bundle exposes createTeamsSpeakers', bundleHasTeams);

  // ── 2) headless browser (green-or-skip where chromium is absent) ──
  const dataDir = mkdtempSync(join(tmpdir(), 'vexa-boundary-'));
  let context: BrowserContext;
  let page;
  try {
    ({ context, page } = await launchPersistentBrowser({ dataDir, args: ['--no-sandbox', '--mute-audio'], headless: true }));
  } catch (e) {
    console.log(`  ⚠️ SKIP — headless Chromium unavailable in this environment: ${(e as Error).message?.split('\n')[0]}`);
    process.exit(0);
  }
  try {
    await context.addInitScript({ path: BUNDLE });
    const pageLogs: string[] = [];
    await context.exposeFunction('logBot', (m: string) => pageLogs.push(String(m)));

    // The REAL bridge over a stub pipeline capturing what crosses the boundary.
    const hints: { name: string; tMs: number; isEnd?: boolean }[] = [];
    const hintCounters: HintCounters = { received: 0, matched: 0, missed: 0 };
    const pipeline: BotPipeline = {
      async start() { /* stub */ }, async stop() { /* stub */ },
      feedAudio() { /* stub */ }, feedMixedAudio() { /* stub */ },
      recordHint(name, tMs, isEnd) { hintCounters.received++; hints.push({ name, tMs, isEnd }); },
      hintCounters,
    };
    const inv: Invocation = {
      platform: 'teams', meetingUrl: 'https://teams.fixture.test/m', botName: 'Vexa',
      redisUrl: 'redis://localhost:6379', transcribeEnabled: false,
    };
    await page.setContent(FIXTURE);
    // setContent does not re-run context init scripts in this launch shape, so load the
    // SAME prebuilt bundle into the fixture document directly (identical bytes to what
    // addInitScript injects on a real navigation).
    await page.addScriptTag({ path: BUNDLE });
    // tsx transpiles this test with esbuild keepNames, whose `__name` helper leaks into
    // page.evaluate-serialized functions; shim it page-side so the REAL bridge code
    // (which ships helper-free via tsc) runs unmodified under the test runner.
    await page.evaluate('globalThis.__name = globalThis.__name || ((t, v) => t);');
    const stop = await startCaptureBridge(page, inv, pipeline);

    // Fixture drives the speaking signal: occlusion class ON (start) → OFF (end).
    await sleep(600);   // observer attach + initial silent state past the 200ms hysteresis
    await page.evaluate(`document.getElementById('alice-outline').classList.add('vdi-frame-occlusion')`);
    await sleep(900);   // 200ms hysteresis + 300ms debounce + margin
    await page.evaluate(`document.getElementById('alice-outline').classList.remove('vdi-frame-occlusion')`);
    await sleep(900);
    await stop();

    // ── 3) the assertions: hints crossed with name, epoch clock, order ──
    check('page-side watcher started (hop 1 visible in page logs)', pageLogs.some((l) => l.includes('[TeamsSpeakers]')), JSON.stringify(pageLogs.slice(0, 3)));
    const alice = hints.filter((h) => h.name === 'Alice Fixture');
    check('speaker hints crossed the boundary for the outlined tile', alice.length >= 2, JSON.stringify(hints));
    // The watcher reports the tile's initial silent state first (an END-shaped hint),
    // then the scripted transitions: START on occlusion, END on its removal — in order.
    const firstStart = alice.findIndex((h) => h.isEnd === false);
    check('a START hint (isEnd=false) crossed for the speaking transition', firstStart >= 0, JSON.stringify(alice));
    check('an END hint follows the START (transition order intact)', firstStart >= 0 && alice.slice(firstStart + 1).some((h) => h.isEnd === true), JSON.stringify(alice));
    check('hint tMs is epoch ms (same clock domain as audio)', alice.every((h) => Math.abs(h.tMs - Date.now()) < 60_000), JSON.stringify(alice.map((h) => h.tMs)));
    check('bot self-name and the signal-less 1:1 tile emit NO hints',
      !hints.some((h) => h.name.includes('Vexa') || h.name === 'Bob OneToOne'), JSON.stringify(hints));
    check('pipeline-received counter moved with the arrivals', hintCounters.received === hints.length && hintCounters.received > 0, JSON.stringify(hintCounters));

    // Real Google-shaped controls: settings is NOT the toggle; React updates later.
    await page.setContent(`<button aria-label="Microphone settings" onclick="window.settingsClicked=true">settings</button>
      <button id="mic" aria-label="Turn on microphone" onclick="window.micClicks=(window.micClicks||0)+1;setTimeout(()=>this.setAttribute('aria-label','Turn off microphone'),350)">mic</button>`);
    await page.evaluate('globalThis.__name = (t, v) => t;');
    const started = Date.now();
    check('Google microphone awaits delayed unmute', await ensureMeetingMicUnmuted(page, 'google_meet') && Date.now() - started >= 300);
    check('microphone control clicked once; settings untouched', await page.evaluate('window.micClicks===1 && !window.settingsClicked'));
    check('already unmuted microphone stays unmuted', await ensureMeetingMicUnmuted(page, 'google_meet') && await page.evaluate('window.micClicks===1'));
    await page.evaluate(`document.getElementById('mic').setAttribute('aria-label','Turn on microphone');document.getElementById('mic').onclick=()=>{window.micClicks++}`);
    check('unconfirmed microphone fails closed without toggling twice', !await ensureMeetingMicUnmuted(page, 'google_meet') && await page.evaluate('window.micClicks===2'));

    // Real Google bridge and speaker scan with the count outside the button.
    await page.setContent(`<div data-participant-id="self" data-self-name="VOXAI"><span class="notranslate">VOXAI</span></div>
      <div data-participant-id="human"><span class="notranslate">Alice</span></div>
      <div><button aria-label="Show everyone">people</button><span id="count">2</span></div><p>1234</p>`);
    await page.addScriptTag({ path: BUNDLE });
    await page.evaluate('globalThis.__name = (t, v) => t;');
    const googleStop = await startCaptureBridge(page, { ...inv, platform: 'google_meet' }, pipeline);
    try {
      check('sibling count badge proves complete Google roster', await page.evaluate('window.__vexaRoomSnapshot().complete'));
      check('structural self excluded; human kept', await page.evaluate('JSON.stringify(window.__vexaRoomSnapshot().ids)===JSON.stringify(["human"])'));
      await page.evaluate('document.getElementById("count").textContent="3"');
      check('missing participant keeps roster incomplete', !await page.evaluate('window.__vexaRoomSnapshot().complete'));
      // The one-shot provider-drift probe must never publish participant content.
      for (let attempt = 0; attempt < 60 && !pageLogs.some(line => line.startsWith('[RoomPresence]')); attempt++) await sleep(100);
      const probe = pageLogs.find(line => line.startsWith('[RoomPresence]')) || '';
      check('presence probe contains control structure only', !!probe && !/1234|Alice|VOXAI|\"human\"|\"self\"/.test(probe));
      await page.evaluate('document.getElementById("count").remove()');
      check('no count cannot infer completeness from visible tiles', !await page.evaluate('window.__vexaRoomSnapshot().complete'));
      await page.evaluate('document.querySelector("button").setAttribute("aria-label","Show everyone 2");document.querySelector("button").parentElement.insertAdjacentHTML("beforeend","<span>3</span>")');
      check('ambiguous count keeps roster incomplete', !await page.evaluate('window.__vexaRoomSnapshot().complete'));
    } finally { await googleStop(); }

  } finally {
    await context.close().catch(() => { /* best-effort */ });
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(failed === 0 ? '\n✅ capture-bridge boundary: all green' : `\n❌ capture-bridge boundary: ${failed} failure(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('❌ FAIL —', e?.stack || e); process.exit(1); });
