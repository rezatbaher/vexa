/**
 * browser-patching.test — the BOT_BROWSER_PATCHING switch, offline (no browser is launched).
 *
 * The launcher is injected, so the REAL launchPersistentBrowser runs end to end and the assertions read what it actually asked of
 * the launcher and the context:
 *
 *  1. OFF  → the plain launcher is used, the stealth (patched) launcher is NEVER built, and no init script is added.
 *  2. ON / unset / unknown → the stealth launcher is used and the fingerprint-spoof init script is added (the pre-existing behaviour).
 *  3. the launch options are identical in both modes (only the patching differs).
 *  4. the spoof script, when it runs, reports the spoofed GPU; and importing the module registers nothing globally.
 *
 * Same shape as session-store.test.ts (tsx + exit code, no assert lib).
 */
import { browserPatchingEnabled, fingerprintSpoofInitScript, launchPersistentBrowser, BROWSER_PATCHING_ENV, type LaunchDeps } from './browser';

const fails: string[] = [];
const check = (cond: boolean, msg: string) => { if (!cond) fails.push(msg); };

/** A fake launcher + context that records everything the real code does to them. */
function harness() {
  const log: { launches: { via: string; dir: string; options: any }[]; initScripts: unknown[]; patchedBuilt: number; plainUsed: number } =
    { launches: [], initScripts: [], patchedBuilt: 0, plainUsed: 0 };
  const context: any = {
    pages: () => [{ fake: 'page' }],
    newPage: async () => ({ fake: 'new-page' }),
    addInitScript: async (script: unknown) => { log.initScripts.push(script); },
  };
  const launcher = (via: string) => ({
    launchPersistentContext: async (dir: string, options: any) => { log.launches.push({ via, dir, options }); return context; },
  });
  const deps: LaunchDeps = {
    plain: () => { log.plainUsed++; return launcher('plain'); },
    patched: async () => { log.patchedBuilt++; return launcher('patched'); },
  };
  return { log, deps };
}

const opts = { dataDir: '/tmp/profile', args: ['--no-sandbox'], headless: false };
const quiet = console.log; // the launcher announces the mode; keep the test output clean
console.log = () => {};

async function run(): Promise<void> {
  // --- parsing -----------------------------------------------------------------------------------------------------------------
  for (const off of ['off', 'OFF', ' Off ', 'false', '0', 'no', 'disabled']) {
    check(browserPatchingEnabled({ [BROWSER_PATCHING_ENV]: off }) === false, `"${off}" must turn patching off`);
  }
  for (const on of [undefined, '', 'on', 'true', '1', 'yes', 'maybe', 'of']) {
    check(browserPatchingEnabled(on === undefined ? {} : { [BROWSER_PATCHING_ENV]: on }) === true, `"${on}" must leave patching on (default behaviour)`);
  }

  // --- OFF ---------------------------------------------------------------------------------------------------------------------
  {
    const { log, deps } = harness();
    const result = await launchPersistentBrowser(opts, deps, { [BROWSER_PATCHING_ENV]: 'off' });
    check(log.patchedBuilt === 0, 'OFF: the stealth launcher must never be built');
    check(log.plainUsed === 1 && log.launches.length === 1 && log.launches[0].via === 'plain', 'OFF: must launch through plain Chromium');
    check(log.initScripts.length === 0, 'OFF: no init script may be added');
    check((result.page as any).fake === 'page', 'OFF: still returns the context page');
  }

  // --- ON (explicit, unset, unknown) -------------------------------------------------------------------------------------------
  for (const env of [{ [BROWSER_PATCHING_ENV]: 'on' }, {}, { [BROWSER_PATCHING_ENV]: 'banana' }]) {
    const { log, deps } = harness();
    await launchPersistentBrowser(opts, deps, env);
    check(log.patchedBuilt === 1 && log.plainUsed === 0 && log.launches[0].via === 'patched', `ON (${JSON.stringify(env)}): must launch through the stealth launcher`);
    check(log.initScripts.length === 1 && log.initScripts[0] === fingerprintSpoofInitScript, `ON (${JSON.stringify(env)}): must add exactly the fingerprint-spoof init script`);
  }

  // --- the launch options do not depend on the mode ----------------------------------------------------------------------------
  {
    const off = harness(), on = harness();
    await launchPersistentBrowser(opts, off.deps, { [BROWSER_PATCHING_ENV]: 'off' });
    await launchPersistentBrowser(opts, on.deps, {});
    check(JSON.stringify(off.log.launches[0].options) === JSON.stringify(on.log.launches[0].options), 'launch options must be identical in both modes');
    const o = off.log.launches[0].options;
    check(o.headless === false && o.viewport === null && o.locale === 'en-US' && JSON.stringify(o.ignoreDefaultArgs) === '["--enable-automation"]' && JSON.stringify(o.args) === '["--no-sandbox"]',
      'launch options must be the persistent-context options the bot always used');
    check(off.log.launches[0].dir === '/tmp/profile', 'the profile dir must be passed through');
    const pinned = harness();
    await launchPersistentBrowser(opts, pinned.deps, { [BROWSER_PATCHING_ENV]: 'off', BOT_UI_LOCALE: 'en-GB' });
    check(pinned.log.launches[0].options.locale === 'en-GB', 'BOT_UI_LOCALE must still pin the locale');
  }

  // --- the spoof script itself (runs in a page; here against a fake global) ---------------------------------------------------
  {
    const g: any = globalThis;
    const saved = { gl: g.WebGLRenderingContext, gl2: g.WebGL2RenderingContext, chrome: g.chrome };
    g.WebGLRenderingContext = class { getParameter(p: number) { return `real:${p}`; } };
    g.WebGL2RenderingContext = class { getParameter(p: number) { return `real2:${p}`; } };
    g.chrome = {};
    try {
      fingerprintSpoofInitScript();
      const gl = new g.WebGLRenderingContext();
      check(gl.getParameter(37446).includes('Intel'), 'spoof script must report the spoofed GPU renderer');
      check(gl.getParameter(1) === 'real:1', 'spoof script must leave other parameters alone');
      check(typeof g.chrome.runtime === 'object', 'spoof script must add chrome.runtime');
    } finally {
      g.WebGLRenderingContext = saved.gl; g.WebGL2RenderingContext = saved.gl2; g.chrome = saved.chrome;
    }
  }

  // --- importing the module registers nothing global ---------------------------------------------------------------------------
  const extra: any = require('playwright-extra');
  check(!(extra.chromium.plugins && extra.chromium.plugins.length), 'importing @vexa/remote-browser must not register plugins on the global playwright-extra chromium');
}

run().then(() => {
  console.log = quiet;
  if (fails.length) { console.error('FAIL browser-patching.test:\n - ' + fails.join('\n - ')); process.exit(1); }
  console.log('PASS browser-patching.test');
}).catch((e) => { console.log = quiet; console.error('ERROR', e); process.exit(1); });
