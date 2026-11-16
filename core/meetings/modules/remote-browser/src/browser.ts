/**
 * browser — the one true persistent-context launch.
 *
 * A *persistent* context (vs a fresh newContext) is what makes authentication work:
 * cookies / localStorage / Login Data written into `dataDir` survive across launches.
 * Carved from the two byte-identical call sites in vexa-bot (browser-session.ts and
 * the index.ts authenticated branch) — same options, single source of truth.
 */
import { chromium as playwrightChromium } from 'playwright';
import { addExtra } from 'playwright-extra';
import type { BrowserContext, Page } from 'playwright';
import { BROWSER_DATA_DIR } from './session-store';

// Browser patching — the anti-detection layer — is ONE deployment switch: BOT_BROWSER_PATCHING.
//
//   on  (default, and any value other than the "off" spellings) — the puppeteer-extra stealth plugin AND the init-script fingerprint
//       spoof below are applied. This is the behaviour every earlier release had.
//   off ("off" | "false" | "0" | "no" | "disabled") — NEITHER is applied: the browser launches as plain Playwright Chromium with the
//       same launch options and no page scripts, so it presents its honest software-GPU fingerprint.
//
// Why it is a switch: Google Meet's anti-abuse reads the browser fingerprint, and a spoof that does not match the real machine (a
// reported Intel GPU over a software renderer, patched getters) can itself be what gets a guest refused. The switch lets a deployment
// compare the two honestly instead of guessing.
//
// The stealth plugin is registered LAZILY, on a private playwright-extra instance, and only when patching is on. (It used to be
// registered on the global `chromium` at module load, a side effect of merely importing this file that nothing could turn off.)
export const BROWSER_PATCHING_ENV = 'BOT_BROWSER_PATCHING';
const PATCHING_OFF = new Set(['off', 'false', '0', 'no', 'disabled']);

export function browserPatchingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !PATCHING_OFF.has((env[BROWSER_PATCHING_ENV] || '').trim().toLowerCase());
}

/** What a launcher must offer; both Playwright's and playwright-extra's chromium satisfy it. */
export interface PersistentLauncher {
  launchPersistentContext(dataDir: string, options: any): Promise<BrowserContext>;
}

export interface LaunchDeps {
  /** Plain Playwright Chromium (patching off). */
  plain: () => PersistentLauncher;
  /** Chromium with the stealth plugin registered (patching on); built once, on first use. */
  patched: () => Promise<PersistentLauncher>;
}

let patchedLauncher: Promise<PersistentLauncher> | undefined;
const defaultDeps: LaunchDeps = {
  plain: () => playwrightChromium as unknown as PersistentLauncher,
  patched: () => {
    patchedLauncher ??= (async () => {
      const { default: StealthPlugin } = await import('puppeteer-extra-plugin-stealth');
      // Anti-detection: the stealth evasions patch the fingerprint surface Google Meet's anti-abuse reads to bucket a bot into
      // "With potential risks" — navigator.plugins/languages, WebGL vendor/renderer, chrome.runtime, permissions,
      // iframe.contentWindow, and more. The two launch flags (--disable-blink-features=AutomationControlled and stripping
      // --enable-automation) only mask navigator.webdriver.
      const extra = addExtra(playwrightChromium as any);
      extra.use(StealthPlugin());
      return extra as unknown as PersistentLauncher;
    })();
    return patchedLauncher;
  },
};

export interface LaunchPersistentOptions {
  /** Chromium profile dir — the durable session lives here. Defaults to BROWSER_DATA_DIR. */
  dataDir?: string;
  /** Launch flags — getBrowserSessionArgs() (VNC) or getAuthenticatedBrowserArgs() (bot). */
  args: string[];
  /** Headed by default (Xvfb under VNC); pass true only for headless contexts. */
  headless?: boolean;
  /** Pinned UI locale (#856) — sets navigator.language / Accept-Language on the
   *  context. Defaults to BOT_UI_LOCALE (env), else en-US. Keeps the page-level
   *  locale byte-identical to the --lang launch flag the caller passes in args. */
  locale?: string;
}

/** The init script that spoofs the fingerprint tells the stealth plugin misses. Runs in every frame, before page scripts. */
export function fingerprintSpoofInitScript(): void {
  const g: any = globalThis;
  // WebGL: the container has NO GPU, so ANGLE falls back to SwiftShader — a strong "server/VM/bot"
  // signal Google Meet's anti-abuse reads (and the reason toggling hardware-acceleration can't help:
  // there is no device to accelerate onto). Report a plausible real Intel/Mesa GPU consistent with
  // the Linux UA for the UNMASKED vendor (37445) / renderer (37446) parameters. Covers WebGL1+2.
  const spoof: Record<number, string> = {
    37445: 'Google Inc. (Intel)',
    37446: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)',
  };
  const patchGL = (proto: any): void => {
    if (!proto || !proto.getParameter) return;
    const orig = proto.getParameter;
    const wrapped = function (this: any, param: number): any {
      return param in spoof ? spoof[param] : orig.call(this, param);
    };
    try { (wrapped as any).toString = orig.toString.bind(orig); } catch { /* keep going */ }
    proto.getParameter = wrapped;
  };
  patchGL(g.WebGLRenderingContext && g.WebGLRenderingContext.prototype);
  patchGL(g.WebGL2RenderingContext && g.WebGL2RenderingContext.prototype);
  // navigator.deviceMemory: real Chrome exposes it; absent on the bot.
  try {
    if (g.navigator && g.navigator.deviceMemory === undefined) {
      Object.defineProperty(g.navigator, 'deviceMemory', { get: () => 8, configurable: true });
    }
  } catch { /* best-effort */ }
  // chrome.runtime: window.chrome is present (stealth) but runtime is missing — a headless tell.
  try {
    if (g.chrome && !g.chrome.runtime) {
      g.chrome.runtime = { id: undefined, connect: () => {}, sendMessage: () => {} };
    }
  } catch { /* best-effort */ }
}

export async function launchPersistentBrowser(
  opts: LaunchPersistentOptions,
  deps: LaunchDeps = defaultDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ context: BrowserContext; page: Page }> {
  const dataDir = opts.dataDir ?? BROWSER_DATA_DIR;
  const locale = opts.locale ?? ((env.BOT_UI_LOCALE || '').trim() || 'en-US');
  const patching = browserPatchingEnabled(env);
  console.log(`[remote-browser] browser patching ${patching ? 'ON (stealth plugin + fingerprint spoof)' : 'OFF (plain Chromium)'} (${BROWSER_PATCHING_ENV}=${env[BROWSER_PATCHING_ENV] ?? '<unset>'})`);
  const launcher = patching ? await deps.patched() : deps.plain();
  const context = await launcher.launchPersistentContext(dataDir, {
    headless: opts.headless ?? false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: opts.args,
    viewport: null,
    locale,
  });
  if (patching) await context.addInitScript(fingerprintSpoofInitScript);

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  return { context: context as BrowserContext, page: page as Page };
}
