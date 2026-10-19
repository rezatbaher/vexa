import { ensureMeetingMicUnmuted, installLocalMediaTracker, ensureMeetingPeoplePanel } from './meeting-dom.js';
/**
 * Capture bridge (2b) — the browser-resident capture → pipeline pump + the speak path.
 *
 * ╔══════════════════════════════════════════════════════════════════════════════════════╗
 * ║ L4 (O6/VM): live-validated against a real meeting.                                      ║
 * ║ This whole file is BROWSER-RESIDENT glue: it injects page-side capture, bridges PCM     ║
 * ║ frames over the Playwright boundary, and drives the meeting-UI mic for speaking. None   ║
 * ║ of it can be proven by a unit test (no DOM, no MediaRecorder, no PulseAudio in CI) — it ║
 * ║ is code-complete + build-clean, and PROVEN only by the O6 VM run. The offline-provable  ║
 * ║ engine it pumps into is pipeline.ts (L2/L3).                                            ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Ported faithfully from the working production bot
 *   services/vexa-bot/core/src/index.ts:
 *     • launch (authenticated, persistent context + S3 restore)  → index.ts:2313–2347
 *     • the per-speaker bridge binding + page-side capture wiring → index.ts:1930, 1947–1957
 *     • the Node-side frame callback shape (speakerIndex, number[]) → index.ts:1598–1605
 *     • the speak path (Redis act → meeting-UI mic unmute → PulseAudio tts_sink) → index.ts:595, 1039–1059
 *
 * Isolation note: the page-side capture module (@vexa/gmeet-capture / @vexa/capture-codec) is
 * NOT a bot dependency (gate:isolation) — it is a BROWSER bundle loaded into the page at runtime
 * (production's `window.VexaBrowserUtils`, installed via addInitScript of the prebuilt
 * browser-utils.global.js). The Node side here imports nothing from those packages; PCM frames
 * cross as plain `(speakerIndex: number, samples: number[])` over `page.exposeFunction`, exactly
 * as production does, so the bot's import surface stays within the gate.
 */
import {
  launchPersistentBrowser,
  syncBrowserDataFromS3,
  syncBrowserDataToS3,
  cleanStaleLocks,
  getAuthenticatedBrowserArgs,
  makeEphemeralProfileDir,
  removeProfileDir,
  type Page,
  type BrowserContext,
} from '@vexa/remote-browser';
import { getJoinBrowserArgs } from '@vexa/join';
import type { RecordingMasterFormat } from '@vexa/recording';
import { isMixedLanePlatform, type Invocation } from './config.js';
import type { BotPipeline } from './pipeline.js';
import type { BotRecordingSink } from './recording.js';
import type { TelemetrySink } from './ports.js';
import { createTtsPlayback, setTtsMute } from './tts-playback.js';
import { createMeetingSpeech, failMeetingSpeech } from './meeting-speech.js';
import { deliverMeetingChat } from './meeting-chat.js';

/** Float32 PCM → base64 of its little-endian bytes — the EXACT codec wire payload, so a stored
 *  captured-signal.v1 frame round-trips through @vexa/capture-codec (encode→decode→same PCM). */
export function pcmToBase64(pcm: Float32Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
}
/** Cheap level read for a captured frame (and the no-signal/silence oracle later). */
export function rmsOf(pcm: Float32Array): number {
  if (!pcm.length) return 0;
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / pcm.length);
}

/**
 * Build the O-TEL-1 raw-signal tap — the EXACT closure the capture bridge tees each frame into,
 * factored out so it is offline-provable WITHOUT a Playwright page (telemetry.test.ts drives this
 * directly). When `telemetry` is unset the returned tap is a single truthiness check — zero
 * overhead, the proven O6 capture path is byte-for-byte unchanged. captureFrame is fire-and-forget;
 * a tap throw is swallowed so it can NEVER reach the pipeline.
 */
export function makeTelemetryTap(lane: 'gmeet' | 'mixed', telemetry?: TelemetrySink) {
  let seq = 0;
  return (speakerIndex: number, pcm: Float32Array, ts: number, speakerName?: string, hint?: string): void => {
    if (!telemetry) return;   // unset ⇒ one branch, nothing computed (never alter the capture path)
    try {
      telemetry.captureFrame({ seq: seq++, ts, speakerIndex, speakerName, hint, pcm: pcmToBase64(pcm), pcm_len: pcm.length, rms: rmsOf(pcm), lane });
    } catch { /* telemetry must not break capture */ }
  };
}

/**
 * Build the mixed-lane speaker-hint sink — the EXACT closure the bridge exposes as
 * `__vexaSpeakerHint`, factored out so it is offline-provable WITHOUT a Playwright page.
 *
 * CLOCK CONTRACT: hint tMs and audio tsMs entering the pipeline share ONE domain —
 * epoch ms. The page-side watchers stamp Date.now() (epoch), so normally the value
 * passes through untouched; a page that emits a non-epoch time (e.g. a relative
 * performance.now()) would make every hint window miss every speech turn, so an
 * implausible skew is re-stamped Node-side and warned LOUDLY, never silently bound
 * to nothing. Also counts arrivals (C1 hop 2: page → Node).
 */
export const HINT_MAX_SKEW_MS = 10 * 60 * 1000;
export function makeSpeakerHintSink(
  pipeline: Pick<BotPipeline, 'recordHint'>,
  warn: (m: string) => void = (m) => console.warn(m),
  /** O-TEL-1: the same sink the audio tap feeds. Mixed-lane hints arrive HERE, not on the audio
   *  frames, so a session recorded without this tee stores audio that can never reproduce
   *  attribution offline. Teed with the post-guard `t`, so the stored hint carries the clock the
   *  pipeline actually saw. */
  telemetry?: TelemetrySink,
): { sink: (name: string, tMs?: number, isEnd?: boolean) => void; crossed: () => number } {
  let crossed = 0;
  return {
    crossed: () => crossed,
    sink: (name: string, tMs?: number, isEnd?: boolean): void => {
      crossed++;
      let t = tMs ?? Date.now();
      const skew = Math.abs(t - Date.now());
      if (skew > HINT_MAX_SKEW_MS) {
        warn(`[bot] hint-clock-skew: hint tMs=${t} is ${Math.round(skew / 1000)}s off the epoch audio clock — page emitted a non-epoch timestamp; re-stamping (name=${name})`);
        t = Date.now();
      }
      if (telemetry?.captureHint) {
        try { telemetry.captureHint({ type: 'hint', t, name, isEnd, lane: 'mixed' }); }
        catch { /* telemetry must not break capture */ }
      }
      pipeline.recordHint(name, t, isEnd);
    },
  };
}

/** Path (in the bot container image) to the prebuilt page-side capture bundle that defines
 *  window.VexaBrowserUtils (createGmeetCapture / createGmeetSpeakers / mixed taps). Mirrors
 *  production's browser-utils.global.js; injected via addInitScript so it is present on every
 *  navigation. Overridable by env for the VM harness. */
const BROWSER_UTILS_PATH = process.env.VEXA_BROWSER_UTILS_PATH ?? '/app/browser-utils.global.js';

/** A handle to the live browser the bot drives. The composition root closes it on teardown. */
export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/**
 * Launch the browser the bot joins through. Authenticated bots restore the persistent profile
 * from S3 first (so they join as a signed-in user); guest bots launch a fresh persistent context.
 * Always uses getJoinBrowserArgs() (the join lane's canonical flag set) merged with the
 * remote-browser auth args, so the page the JoinDriver receives is configured identically to
 * what @vexa/join expects.  // L4 (O6/VM): live-validated against a real meeting.
 */
export async function launchBrowser(inv: Invocation): Promise<BrowserSession> {
  // Every bot gets its OWN profile dir — concurrent bots sharing one dir die on Chromium's
  // SingletonLock (#478: joining → failed <1s, "Opening in existing browser session").
  // Authenticated: restore the S3 userdata into this bot's dir before launch (index.ts:2313–2347).
  const dataDir = makeEphemeralProfileDir();
  const s3Config = {
    userdataS3Path: inv.userdataS3Path,
    s3Endpoint: inv.s3Endpoint,
    s3Bucket: inv.s3Bucket,
    s3AccessKey: inv.s3AccessKey,
    s3SecretKey: inv.s3SecretKey,
  };
  if (inv.authenticated && inv.userdataS3Path) {
    // Fail-loud restore: an unreachable/misconfigured store surfaces as a typed SessionSyncError
    // naming the session-restore step (the composition root drives it to a clean terminal failed)
    // — an authenticated bot never silently proceeds to join signed-out on a failed restore.
    syncBrowserDataFromS3(s3Config, dataDir);
    cleanStaleLocks(dataDir);
  }

  // getAuthenticatedBrowserArgs() is the minimal clean set remote-browser uses for signed-in
  // joins; getJoinBrowserArgs() adds the fake-device / autoplay flags the join lane needs. The
  // join args win on conflict (later wins in Chromium arg parsing).
  const args = [...getAuthenticatedBrowserArgs(), ...getJoinBrowserArgs()];
  const { context, page } = await launchPersistentBrowser({ dataDir, args });

  if (inv.platform === 'google_meet' && inv.voiceAgentEnabled) await installLocalMediaTracker(context);

  // Voice-agent gate the page reads to decide whether to keep the mic hot (production parity).
  await context.addInitScript(`window.__vexa_voice_agent_enabled = ${!!inv.voiceAgentEnabled};`);
  // Inject the page-side capture bundle on every navigation (defines window.VexaBrowserUtils).
  await context.addInitScript({ path: BROWSER_UTILS_PATH }).catch(() => {
    // The bundle may be loaded by other means in some images; capture wiring degrades to the
    // inline fallback below. Never fatal at launch.
  });

  // #593 A1: a page-context global fault logger, installed at document-start on EVERY frame/nav so
  // gmeet + teams + zoom all inherit it. Before this, the only error-shaped line on the bot's stdout
  // for a Teams join was the platform's OWN `Unhandled rejection {isTrusted:true}` — a bare DOM Event
  // that misdirected #593 (it's Teams' VQE worklet, unrelated to our Node throw). This handler names
  // the actual reason (message + stack) AND, for a bare Event, its type/target — so the {isTrusted}
  // line is finally identified rather than mistaken for the cause. Non-fatal at launch (like neighbors).
  await context.addInitScript(`(() => {
    var report = function (m) { try { (window.logBot || console.error)('[page-fault] ' + m); } catch (e) {} };
    window.addEventListener('unhandledrejection', function (ev) {
      var r = ev && ev.reason;
      var msg = (r && (r.message || r.name)) ? ((r.name || 'Error') + ': ' + (r.message || '')) : String(r);
      var stack = (r && r.stack) ? r.stack : '(no stack)';
      report('unhandledrejection: ' + msg + ' :: ' + stack);
    });
    window.addEventListener('error', function (ev) {
      var msg;
      if (ev && ev.error && (ev.error.message || ev.error.stack)) {
        msg = (ev.error.name || 'Error') + ': ' + (ev.error.message || '') + ' :: ' + (ev.error.stack || '(no stack)');
      } else {
        var t = ev && ev.target;
        var tag = t && (t.tagName || t.nodeName);
        var src = t && (t.src || t.href || t.currentSrc);
        msg = 'event type=' + (ev && ev.type) + (tag ? ' target=' + tag : '') + (src ? ' src=' + src : '') + ' isTrusted=' + (ev && ev.isTrusted);
      }
      report('error: ' + msg);
    });
  })();`).catch(() => { /* never fatal at launch */ });

  // Zoom/Teams expose NO per-participant <audio> in the DOM — install the WebRTC hook so each
  // remote audio track is mirrored into a hidden <audio> element (→ __vexaCapturedRemoteAudioStreams)
  // the mixed lane combines. Jitsi rides the same hook: its remote audio also arrives as WebRTC
  // tracks, and hooking RTCPeerConnection is version-proof where its DOM <audio> ids are not.
  // MUST run before the page builds its RTCPeerConnections; addInitScript
  // runs at document-start, after the bundle above has defined window.VexaBrowserUtils. (L4 — Zoom/Teams.)
  if (isMixedLanePlatform(inv.platform)) {
    await context.addInitScript(
      `try { window.VexaBrowserUtils && window.VexaBrowserUtils.installRemoteAudioHook && window.VexaBrowserUtils.installRemoteAudioHook({}); } catch (e) {}`,
    ).catch(() => { /* non-fatal */ });
  }

  // Observability (L4): route the page-side capture's log(m) → container stdout. gmeet-capture
  // calls window.logBot?.(...) ("stream N connected", "capture started with N stream(s)", …); without
  // exposing it those vanish and the capture is invisible. context.exposeFunction persists across the
  // navigation to the meeting URL. Also forward page console errors/capture markers so faults surface.
  await context.exposeFunction('logBot', (m: string) => console.log(`[page] ${m}`)).catch(() => { /* already registered */ });
  page.on('console', (msg) => {
    const t = msg.text();
    if (/perspeaker|capture|stream|vexabrowser|audiocontext|error|fail/i.test(t)) console.log(`[page-console:${msg.type()}] ${t}`);
  });

  return {
    context,
    page,
    async close() {
      await context.close().catch(() => { /* best-effort */ });
      // Write-back on clean teardown (#725): Google rotates session cookies during use, so the
      // durable copy is refreshed from the LIVE profile dir after the context flushes — the next
      // spawn restores the freshest state instead of a decaying snapshot. Clean teardown only:
      // a SIGKILL never reaches close(), so a hard-killed meeting keeps the last durable copy.
      // Failures are attributed warnings, bounded per upload — teardown never hangs on S3.
      if (inv.authenticated && inv.userdataS3Path) {
        try {
          syncBrowserDataToS3(s3Config, dataDir);
        } catch (e) {
          console.error(`[bot] session write-back failed (durable copy stays at last restore): ${String(e)}`);
        }
      }
      removeProfileDir(dataDir);   // per-bot dir — leaking one per bot fills the disk in vexa-lite
    },
  };
}

/**
 * Wire the page-side capture to pipeline.feedAudio. Exposes the Node bridge binding
 * `__vexaPerSpeakerAudioData(speakerIndex, samples[], tsMs?)` and starts the in-page capture
 * (preferring the shared VexaBrowserUtils module, with production's inline fallback). For the
 * mixed lane (Zoom/Teams) it instead pumps the single mixed stream + active-speaker hints.
 * Returns a stop fn that tears the page-side capture down.
 *   // L4 (O6/VM): live-validated against a real meeting.
 *   Ported from services/vexa-bot/core/src/index.ts:1930, 1947–1957, 1598–1605.
 */
export async function startCaptureBridge(
  page: Page,
  inv: Invocation,
  pipeline: BotPipeline,
  telemetry?: TelemetrySink,
  /** In-meeting chat sink (jitsi lane) — each captured chat message crosses here;
   *  the composition root publishes it as a transcript.v1 `source:'chat'` segment. */
  onChat?: (sender: string, text: string) => void,
  onPresence?: (ids: string[], names: Record<string, string>, complete: boolean) => void,
  onActivity?: (name: string, ended: boolean) => void,
): Promise<() => Promise<void>> {
  const mixed = isMixedLanePlatform(inv.platform);
  const jitsi = inv.platform === 'jitsi';
  const lane: 'gmeet' | 'mixed' = mixed ? 'mixed' : 'gmeet';

  // ── O-TEL-1 raw-signal tap (a DUAL-sink) ──────────────────────────────────────────────────
  // When a TelemetrySink is wired, tee each raw frame to it BEFORE the pipeline consumes it, so a
  // live bug's exact signal is stored as captured-signal.v1 and replays offline (O-TEL-2). The tap
  // is OPTIONAL + zero-overhead when unset (makeTelemetryTap short-circuits to a single truthiness
  // check), so the proven O6 capture path is byte-for-byte unchanged. captureFrame is fire-and-forget.
  const tee = makeTelemetryTap(lane, telemetry);

  // ── Node-side frame sink: one capture.v1 frame crossing the Playwright boundary. ──
  // The page serializes PCM as a plain number[] (Array.from(Float32Array)); we restore the
  // Float32Array and stamp the capture time if the page didn't supply one (production stamps
  // Date.now() on the Node side — index.ts:1598–1605).
  const onPerSpeakerAudio = (speakerIndex: number, samples: number[], tsMs?: number): void => {
    const pcm = new Float32Array(samples);
    const ts = tsMs ?? Date.now();
    tee(speakerIndex, pcm, ts);                                 // O-TEL-1: tap BEFORE the pipeline
    if (mixed) pipeline.feedMixedAudio(pcm, ts);
    else pipeline.feedAudio(speakerIndex, undefined, pcm, ts); // glow name is bound page-side in the v1 producer; channel index here
  };
  // gmeet: the v1 producer stamps the glow name page-side; this named variant carries it through.
  const onNamedAudio = (channel: number, glowName: string | undefined, samples: number[], tsMs?: number): void => {
    const pcm = new Float32Array(samples);
    const ts = tsMs ?? Date.now();
    tee(channel, pcm, ts, glowName);                            // O-TEL-1: tap BEFORE the pipeline
    pipeline.feedAudio(channel, glowName, pcm, ts);
  };
  // mixed lane "who is lit" hint (Zoom/Teams active-speaker → the namer's time window).
  // Epoch-clock-guarded + counted; see makeSpeakerHintSink for the clock contract.
  const { sink: onSpeakerHint, crossed: hintsBridgeCrossed } = makeSpeakerHintSink(pipeline, undefined, telemetry);
  // C1: the four hint hops on one periodic, cumulative counter line —
  // page-emitted lives in the page console ([TeamsSpeakers]/[JitsiSpeakers] logs);
  // bridge-crossed / pipeline-received / binder matched|missed are Node-side.
  const countersTimer = mixed ? setInterval(() => {
    const c = pipeline.hintCounters;
    console.log(`[bot] hint-counters bridge-crossed=${hintsBridgeCrossed()} pipeline-received=${c?.received ?? 0} binder-matched=${c?.matched ?? 0} binder-missed=${c?.missed ?? 0}`);
  }, 30_000) : null;
  countersTimer?.unref?.();   // observability only — never holds the process open

  await page.exposeFunction('__vexaPerSpeakerAudioData', onPerSpeakerAudio).catch((e: Error) => {
    if (!String(e.message).includes('already registered')) throw e;
  });
  await page.exposeFunction('__vexaNamedAudioData', onNamedAudio).catch(() => { /* optional */ });
  await page.exposeFunction('__vexaSpeakerHint', onSpeakerHint).catch(() => { /* optional */ });
  await page.exposeFunction('__vexaRoomPresence', (ids: string[], names: Record<string, string>, complete: boolean) => onPresence?.(ids, names, complete)).catch(() => {});
  await page.exposeFunction('__vexaRoomActivity', (name: string, ended: boolean) => onActivity?.(name, ended)).catch(() => {});
  // jitsi/gmeet chat → the embedder's sink (a transcript.v1 `chat` segment at the composition root).
  await page.exposeFunction('__vexaChatMessage', (sender: string, text: string): void => {
    try { onChat?.(sender, text); } catch (e) { console.error(`[bot] chat sink rejected: ${String(e)}`); }
  }).catch(() => { /* optional */ });

  if (inv.platform === 'google_meet' && inv.voiceAgentEnabled) await ensureMeetingPeoplePanel(page);

  // ── Start the page-side capture (VexaBrowserUtils preferred; production inline fallback). ──
  // The body of this callback runs IN THE BROWSER (Playwright serializes it); DOM globals are
  // reached via globalThis (this file type-checks against the Node lib — no DOM types here).
  await page.evaluate(async ({ isMixed, isJitsi, isTeams, isZoom, botName, voiceAgentEnabled }) => {
    const w = (globalThis as any) as Record<string, any>;
    if (isMixed) {
      // Zoom/Teams: installRemoteAudioHook (installed pre-nav) mirrors each remote WebRTC audio
      // track into w.__vexaCapturedRemoteAudioStreams. Combine them into ONE live stream (an
      // AudioContext destination), keep connecting late-arriving tracks via a rescan (a participant
      // who speaks later), and feed that single mix to the mixed lane (pyannote re-separates speakers).
      const setupMix = (): void => {
        const streams = (w.__vexaCapturedRemoteAudioStreams || []) as Array<{ id: string }>;
        if (!streams.length) return;
        if (!w.__vexaMixCtx) {
          w.__vexaMixCtx = new (globalThis as any).AudioContext({ sampleRate: 16000 });
          w.__vexaMixCtx.resume?.();
          w.__vexaMixDest = w.__vexaMixCtx.createMediaStreamDestination();
          w.__vexaMixSeen = new Set();
        }
        for (const s of streams) {
          if (!s || w.__vexaMixSeen.has(s.id)) continue;
          try {
            w.__vexaMixCtx.createMediaStreamSource(s).connect(w.__vexaMixDest);
            w.__vexaMixSeen.add(s.id);
            w.logBot?.('[mixed] connected remote stream ' + w.__vexaMixSeen.size);
          } catch { /* a stream may not be connectable yet */ }
        }
        if (!w.__vexaMixedCapture && w.__vexaMixSeen.size && w.VexaBrowserUtils?.createMixedAudioCapture) {
          w.__vexaMixedCapture = true; // guard re-entry while the async create resolves
          Promise.resolve(w.VexaBrowserUtils.createMixedAudioCapture(w.__vexaMixDest.stream, (pcm: Float32Array) => w.__vexaPerSpeakerAudioData(0, Array.from(pcm))))
            .then((cap: any) => { w.__vexaMixedCapture = cap; return cap?.start?.(); })
            .then(() => w.logBot?.('[mixed] capture started over ' + w.__vexaMixSeen.size + ' stream(s)'))
            .catch((e: any) => { w.__vexaMixedCapture = null; w.logBot?.('[mixed] capture start failed: ' + String(e)); });
        }
      };
      setupMix();
      w.__vexaMixRescan = (globalThis as any).setInterval(setupMix, 2000); // pick up late-arriving tracks
      if (isTeams) {
        // Teams contributes the WHO signal the mixed audio can't carry: the voice-level
        // "blue-square" outline watcher (@vexa/teams-capture — the SAME module the desktop
        // extension runs) emits debounced speaking start/stop per participant; each crosses
        // to the Node side as a speaker hint (epoch tMs) and the pipeline stamps the
        // platform's 'dom-outline' kind at its wiring seam.
        if (w.VexaBrowserUtils?.createTeamsSpeakers && !w.__vexaTeamsSpeakers) {
          w.__vexaTeamsSpeakers = w.VexaBrowserUtils.createTeamsSpeakers({
            selfName: botName,
            log: (m: string) => w.logBot?.('[TeamsSpeakers] ' + m),
            onSpeaking: (name: string, _id: string, isEnd: boolean, tMs: number) =>
              w.__vexaSpeakerHint?.(name, tMs, isEnd),
          });
        }
      }
      if (isJitsi) {
        // Jitsi contributes the WHO + chat signals the mixed audio can't carry:
        // dominant-speaker changes name the pyannote clusters ('dom-active' hints),
        // and chat messages cross to the Node side as transcript `chat` segments.
        if (w.VexaBrowserUtils?.createJitsiSpeakers && !w.__vexaJitsiSpeakers) {
          w.__vexaJitsiSpeakers = w.VexaBrowserUtils.createJitsiSpeakers({
            selfName: botName,
            log: (m: string) => w.logBot?.('[JitsiSpeakers] ' + m),
            onSpeaking: (name: string, _id: string, isEnd: boolean, tMs: number) =>
              w.__vexaSpeakerHint?.(name, tMs, isEnd),
          });
        }
        if (w.VexaBrowserUtils?.createJitsiChat && !w.__vexaJitsiChat) {
          w.__vexaJitsiChat = w.VexaBrowserUtils.createJitsiChat({
            log: (m: string) => w.logBot?.('[JitsiChat] ' + m),
            onMessage: (m: { sender: string; text: string }) => w.__vexaChatMessage?.(m.sender, m.text),
          });
        }
      }
      if (isZoom) {
        // Zoom contributes the WHO signal the mixed audio can't carry: the active-speaker
        // DOM watcher (poll + flicker debounce lives in @vexa/zoom-capture) emits name
        // transitions → __vexaSpeakerHint → pipeline.recordHint, which labels them
        // 'dom-active' (Zoom's true kind — the mixed lane's DOM-active lag model).
        // Timestamps are page Date.now() = epoch ms, the same clock Node stamps with.
        if (w.VexaBrowserUtils?.createZoomSpeakers && !w.__vexaZoomSpeakers) {
          let lastActive: string | null = null;
          w.__vexaZoomSpeakers = w.VexaBrowserUtils.createZoomSpeakers({
            selfName: botName,
            log: (m: string) => w.logBot?.('[ZoomSpeakers] ' + m),
            onSpeakerChange: (name: string | null) => {
              const tMs = Date.now();
              if (name) w.__vexaSpeakerHint?.(name, tMs, false);           // start / heartbeat re-assert
              else if (lastActive) w.__vexaSpeakerHint?.(lastActive, tMs, true); // nobody lit → close the turn
              lastActive = name;
            },
          });
        }
      }
      return;
    }
    // gmeet lane: per-channel capture + glow attribution (the SAME module the extension runs).
    if (w.VexaBrowserUtils?.createGmeetCapture && !w.__vexaGmeetCapture) {
      w.__vexaGmeetSpeakers = w.__vexaGmeetSpeakers
        ?? w.VexaBrowserUtils.createGmeetSpeakers?.({
          selfName: botName, pollMs: 100,
          isLocalTrack: (track: any) => w.__vexaIsLocalMediaTrack?.(track) === true,
          log: (m: string) => w.logBot?.('[PerSpeaker] ' + m),
          onSpeaking: (name: string, ended: boolean) => w.__vexaRoomActivity?.(name, ended),
        });
      const roomProbeAfter = Date.now() + 5000;
      w.__vexaRoomSnapshot = () => {
        const state = w.__vexaGmeetSpeakers?.getState?.();
        if (state) {
          const tiles = state.tiles.filter((t: any) => !t.self);
          const buttons = Array.from(w.document.querySelectorAll('button,[role="button"]')) as any[];
          const counts = new Set<number>();
          for (const button of buttons) {
            const label = String(button.getAttribute('aria-label') || button.getAttribute('data-tooltip') || '');
            if (!button.getClientRects().length || /chat|message|invite|add (?:people|participants)/i.test(label)) continue;
            const icons = Array.from(button.querySelectorAll('.google-symbols,.google-material-icons,.material-icons,.material-symbols-outlined,[data-google-symbols-override]')) as any[];
            const peopleIcon = icons.some(icon => /^(people|people_alt|group|groups|supervisor_account|\uE7EF|\uE7FB|\uF233)$/.test(String(icon.textContent || '').trim())
              || /^(people|people_alt|group|groups|supervisor_account)$/.test(String(icon.getAttribute('data-google-symbols-override') || '').trim()));
            if (!/people|participants|show everyone/i.test(label) && !peopleIcon) continue;
            const numbers = (label + ' ' + String(button.textContent || '')).match(/\d{1,4}/g) || [];
            for (const number of numbers) counts.add(Number(number));
            // Meet can render the count as a sibling badge, outside the actual button.
            // Only inspect a bounded control wrapper containing this one button; never
            // infer completeness from the tiles themselves or from a wider toolbar.
            let wrapper = button.parentElement;
            for (let depth = 0; wrapper && depth < 3; depth++, wrapper = wrapper.parentElement) {
              if (wrapper === w.document.body || wrapper === w.document.documentElement
                || wrapper.querySelector('[data-participant-id],[data-message-id],[data-sender-id],[role="log"],textarea,[contenteditable="true"]')
                || wrapper.querySelectorAll('button,[role="button"]').length !== 1) break;
              for (const badge of Array.from(wrapper.querySelectorAll('*')) as any[]) {
                const text = String(badge.textContent || '').trim();
                if (badge.getClientRects().length && /^\d{1,4}$/.test(text)) counts.add(Number(text));
              }
            }
          }
          const linked = w.__vexaPeoplePanel;
          const panel = linked && w.document.getElementById(linked.target);
          const activeControl = linked && buttons.filter(button => button.getAttribute('aria-controls') === linked.target
            && button.getAttribute('data-panel-id') === linked.panel && button.getAttribute('aria-expanded') === 'true');
          if (panel?.getClientRects().length && activeControl?.length === 1) {
            for (const header of Array.from(panel.querySelectorAll('h1,h2,[role="heading"],[aria-expanded]')) as any[]) {
              if (!header.getClientRects().length || header.closest('[data-participant-id],[data-message-id],[data-sender-id],[role="log"]')) continue;
              const text = String(header.getAttribute('aria-label') || header.textContent || '').replace(/\s+/g, ' ').trim();
              const match = /^(?:in the meeting|in this call|in the call)\s*\(?\s*(\d{1,4})\s*\)?$/i.exec(text);
              if (match) counts.add(Number(match[1]));
            }
          }
          const complete = counts.size === 1 && counts.has(new Set(state.tiles.map((t: any) => t.id)).size);
          if (!complete && Date.now() >= roomProbeAfter && !(w as any).__vexaRoomProbeLogged) {
            (w as any).__vexaRoomProbeLogged = true;
            // Operational structure only: no participant names, IDs, text or credentials.
            w.logBot?.('[RoomPresence] ' + JSON.stringify({ countCandidates: counts.size, expectedCountObserved: counts.has(new Set(state.tiles.map((t: any) => t.id)).size), tiles: state.tiles.length,
              selfMarkers: w.document.querySelectorAll('[data-self-name]').length, localTrackerReady: typeof w.__vexaIsLocalMediaTrack === 'function',
              selfTiles: state.tiles.filter((t: any) => t.self).length, localMediaStats: w.__vexaLocalMediaStats?.(),
              peoplePanelLinked: !!linked, peoplePanelActive: !!panel?.getClientRects().length && activeControl?.length === 1,
              panelHeaderKinds: panel ? (Array.from(panel.querySelectorAll('h1,h2,[role="heading"],[aria-expanded]')) as any[])
                .filter(node => !node.closest('[data-participant-id],[data-message-id],[data-sender-id],[role="log"]'))
                .map(node => String(node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim())
                .map(text => /^(in the meeting|in this call|in the call)\b/i.test(text) ? 'in-call' : /^contributors\b/i.test(text) ? 'contributors' : /^viewers\b/i.test(text) ? 'viewers' : /^waiting\b/i.test(text) ? 'waiting' : 'other').slice(0, 16) : [],
              panelStructure: panel ? (Array.from(panel.querySelectorAll('*')) as any[]).slice(0, 180).map(node => {
                const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
                const aria = String(node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
                const kind = (value: string) => /^(in the meeting|in this call|in the call)\b/i.test(value) ? 'in-call'
                  : /^contributors\b/i.test(value) ? 'contributors' : /^viewers\b/i.test(value) ? 'viewers'
                  : /^waiting\b/i.test(value) ? 'waiting' : /^\d{1,4}$/.test(value) ? 'numeric' : 'other';
                return { tag: node.tagName, attributes: Array.from(node.attributes).map((a: any) => a.name),
                  visible: !!node.getClientRects().length, children: node.children.length,
                  textKind: kind(text), ariaKind: kind(aria), participantAncestor: !!node.closest('[data-participant-id]') };
              }) : [],
              // Only generic UI-control metadata and booleans; never names, IDs or
              // full DOM/text. This probe diagnoses provider markup drift safely.
              controls: (Array.from(w.document.querySelectorAll('[aria-label],[data-tooltip]')) as any[])
                .filter(node => /people|participants|everyone/i.test(String(node.getAttribute('aria-label') || node.getAttribute('data-tooltip') || ''))
                  || /^(people|people_alt|group|groups|supervisor_account)$/.test(String(node.querySelector('.google-symbols,.google-material-icons,.material-icons,.material-symbols-outlined')?.textContent || '').trim()))
                .slice(0, 12).map(node => {
                  const wrappers = []; let parent = node;
                  for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
                    const numericLeaves = (Array.from(parent.querySelectorAll('*')) as any[])
                      .filter(child => child.children.length === 0 && child.getClientRects().length)
                      .map(child => String(child.textContent || '').trim()).filter(text => /^\d{1,4}$/.test(text));
                    wrappers.push({ tag: parent.tagName, buttons: parent.querySelectorAll('button,[role="button"]').length,
                      numericLeaves: numericLeaves.length, matchingTileCount: numericLeaves.filter(text => Number(text) === state.tiles.length).length });
                  }
                  return { tag: node.tagName, attributes: Array.from(node.attributes).map((a: any) => a.name), wrappers };
                }),
              panelControls: buttons.filter(button => button.hasAttribute('data-panel-id')).slice(0, 24).map(button => {
                const label = ['aria-label', 'data-tooltip', 'title'].map(key => button.getAttribute(key) || '').join(' ');
                return { visible: !!button.getClientRects().length, linked: button.hasAttribute('aria-controls'),
                  kind: /chat|message/i.test(label) ? 'chat' : /people|participants|show everyone/i.test(label) ? 'people' : 'other',
                  iconKinds: (Array.from(button.querySelectorAll('i,span,[data-google-symbols-override]')) as any[]).filter(icon => !icon.children.length)
                    .map(icon => /^(people|people_alt|group|groups|supervisor_account|\uE7EF|\uE7FB|\uF233)$/.test(String(icon.textContent || '').trim()) ? 'people' : 'other').slice(0, 8),
                  attributes: Array.from(button.attributes).map((a: any) => a.name) };
              }),
              peopleIcons: (Array.from(w.document.querySelectorAll('button,[role="button"]')) as any[]).filter(button =>
                /^(people|people_alt|group|groups|supervisor_account)$/.test(String(button.querySelector('.google-symbols,.google-material-icons,.material-icons,.material-symbols-outlined')?.textContent || '').trim())).length,
              localMarkers: (Array.from(w.document.querySelectorAll('*')) as any[]).slice(0, 3000).flatMap(node =>
                Array.from(node.attributes).filter((a: any) => /self|local/i.test(a.name)).map((a: any) => ({
                  attribute: a.name, flag: /^(true|false)$/i.test(a.value) ? a.value : null,
                  participantIndex: state.tiles.findIndex((t: any) => t.id === node.closest('[data-participant-id]')?.getAttribute('data-participant-id')),
                }))).slice(0, 24),
              tileStructure: Array.from(w.document.querySelectorAll('[data-participant-id]')).slice(0, 8).map((node: any) => ({
                tag: node.tagName, attributes: Array.from(node.attributes).map((a: any) => a.name),
                visible: !!node.getClientRects().length,
                effectsPreview: /visual_effects|backgrounds and effects/i.test(String(node.getAttribute('aria-label') || node.textContent || '')),
                flags: Object.fromEntries(Array.from(node.attributes).filter((a: any) => /^(true|false)$/i.test(a.value)).map((a: any) => [a.name, a.value])),
                descendants: [...new Set((Array.from(node.querySelectorAll('*')) as any[]).flatMap(child => Array.from(child.attributes).map((a: any) => a.name)))],
                media: (Array.from(node.querySelectorAll('audio,video')) as any[]).map(media => ({
                  tag: media.tagName, tracks: media.srcObject?.getTracks?.().map((track: any) => ({
                    kind: track.kind, provenLocal: w.__vexaIsLocalMediaTrack?.(track) === true,
                    settingsKeys: Object.keys(track.getSettings?.() || {}),
                  })) || [],
                })),
              })) }));
          }
          return { ids: tiles.map((t: any) => String(t.id)).sort(), names: Object.fromEntries(tiles.map((t: any) => [String(t.id), String(t.name || 'Unidentified participant')])), complete };
        }
        return { ids: [], names: {}, complete: false };
      };
      w.__vexaRosterTimer = (globalThis as any).setInterval(() => {
        const state = w.__vexaRoomSnapshot();
        w.__vexaRoomPresence?.(state.ids, state.names, state.complete);
      }, 250);
      w.__vexaGmeetCapture = w.VexaBrowserUtils.createGmeetCapture({
        log: (m: string) => w.logBot?.('[PerSpeaker] ' + m),
        onAudio: (index: number, pcm: Float32Array) => {
          w.__vexaGmeetSpeakers?.reportTrackAudio?.(index);
          // Bind the glow name at capture time (the v1 producer's inversion): exactly-one-lit ⇒ name.
          const lit: string[] = w.__vexaGmeetSpeakers?.litNames?.() ?? [];
          const glow = lit.length === 1 ? lit[0] : undefined;
          if (glow) w.__vexaNamedAudioData(index, glow, Array.from(pcm), Date.now());
          else w.__vexaPerSpeakerAudioData(index, Array.from(pcm), Date.now());
        },
      });
      await w.__vexaGmeetCapture.start();
    }
    // Meet chat -> the SAME sink the jitsi lane uses, so a typed message becomes an ordinary
    // transcript.v1 `source:'chat'` segment. Meet keeps chat in the DOM only while the panel is
    // OPEN (no redux store to read behind it, unlike jitsi), so the module opens it itself.
    if (w.VexaBrowserUtils?.createGmeetChat && !w.__vexaGmeetChat) {
      w.__vexaGmeetChat = w.VexaBrowserUtils.createGmeetChat({
        // Keep an observed People panel stable; chat can still be opened for explicit
        // delivery. Losing the in-call count invalidates room history immediately.
        autoOpenPanel: !voiceAgentEnabled,
        log: (m: string) => w.logBot?.('[GmeetChat] ' + m),
        onMessage: (m: { sender: string; text: string }) => w.__vexaChatMessage?.(m.sender, m.text),
      });
    }
  }, { isMixed: mixed, isJitsi: jitsi, isTeams: inv.platform === 'teams', isZoom: inv.platform === 'zoom', botName: inv.botName, voiceAgentEnabled: !!inv.voiceAgentEnabled }).catch((e) => {
    console.error(`[bot] capture bridge: page-side start failed: ${String(e)}`); // L4: surfaces only on the VM
  });

  // Stop fn: tear the page-side capture down on teardown (best-effort; the page may be closing).
  return async () => {
    if (countersTimer) clearInterval(countersTimer);
    await page.evaluate(() => {
      const w = (globalThis as any) as Record<string, any>;
      try { w.__vexaGmeetCapture?.stop?.(); } catch { /* best-effort */ }
      try { w.__vexaTeamsSpeakers?.destroy?.(); w.__vexaTeamsSpeakers = null; } catch { /* best-effort */ }
      try { w.__vexaJitsiSpeakers?.destroy?.(); w.__vexaJitsiSpeakers = null; } catch { /* best-effort */ }
      try { w.__vexaJitsiChat?.destroy?.(); w.__vexaJitsiChat = null; } catch { /* best-effort */ }
      try { w.__vexaGmeetChat?.destroy?.(); w.__vexaGmeetChat = null; } catch { /* best-effort */ }
      try { w.__vexaZoomSpeakers?.destroy?.(); w.__vexaZoomSpeakers = null; } catch { /* best-effort */ }
      try { if (w.__vexaMixRescan) { (globalThis as any).clearInterval(w.__vexaMixRescan); w.__vexaMixRescan = null; } } catch { /* */ }
      try { if (w.__vexaMixedCapture && typeof w.__vexaMixedCapture.stop === 'function') w.__vexaMixedCapture.stop(); } catch { /* best-effort */ }
      try { w.__vexaMixCtx?.close?.(); } catch { /* best-effort */ }
      try { w.__vexaGmeetSpeakers?.destroy?.(); } catch { /* best-effort */ }
      try { (globalThis as any).clearInterval(w.__vexaRosterTimer); } catch { /* */ }
    }).catch(() => { /* page already gone */ });
  };
}

/**
 * Start the page-side recording tap → recording.v1 chunks → the BotRecordingSink.  // L4 (O6/VM).
 *
 * The MediaRecorder loop lives in @vexa/record-chunker (bundled into window.VexaBrowserUtils, like
 * the capture bricks). It records the meeting's combined audio mix, base64-encodes each timeslice,
 * and hands it to `onChunk`. We bridge those chunks over the Playwright boundary to `recording.chunk`
 * using the SAME key the orchestrator closes with (`platform/native`); the sink uploads each chunk to
 * meeting-api the moment it arrives (#491/#412 — every finished part is durable before the meeting
 * ends), and the master is assembled server-side on read. The trailing empty is_final chunk (on
 * stop) is the COMPLETED signal. Started post-admission (on the live meeting page, where the
 * participant <audio> elements exist), exactly like the capture bridge.
 */
export async function startRecording(page: Page, inv: Invocation, recording: BotRecordingSink): Promise<() => Promise<void>> {
  await page.exposeFunction('__vexaRecordingStarted', (earliest: string, latest: string) => recording.started(earliest, latest)).catch(() => {});
  const key = `${inv.platform}/${inv.nativeMeetingId ?? inv.connectionId ?? 'session'}`;
  // Recording part interval (ms): the MediaRecorder timeslice = the durable-upload granularity.
  // Env-overridable (VEXA_RECORDING_TIMESLICE_MS) so a live multi-part run can shrink it to land
  // ≥2 parts in a short meeting (#509 A5); default 15000 (production parity). Each timeslice is a
  // chunk uploaded the moment it is produced (recording.ts sink), so a SIGKILL leaves every
  // finished part durable (#412). Invalid / non-positive values fall back to the default.
  const timesliceMs = ((): number => {
    const raw = process.env.VEXA_RECORDING_TIMESLICE_MS;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 15000;
  })();
  // Node-side: decode one base64 recording.v1 chunk → the per-chunk upload sink. mimeType→format.
  await page.exposeFunction('__vexaRecordingChunk', (base64: string, chunkSeq: number, isFinal: boolean, mimeType: string): void => {
    const bytes = base64 ? new Uint8Array(Buffer.from(base64, 'base64')) : new Uint8Array(0);
    const format: RecordingMasterFormat = /wav/i.test(mimeType) ? 'wav' : 'webm';
    recording.chunk(key, chunkSeq, isFinal, format, bytes);
  }).catch((e: Error) => { if (!String(e.message).includes('already registered')) throw e; });

  // Page-side: start the generic recording tap (finds + combines the page audio elements).
  await page.evaluate(async (timesliceMs) => {
    const w = (globalThis as any) as Record<string, any>;
    if (w.VexaBrowserUtils?.createRecordingTap && !w.__vexaRecordingTap) {
      w.__vexaRecordingTap = w.VexaBrowserUtils.createRecordingTap({
        timesliceMs,
        onStarted: (earliest: string, latest: string) => w.__vexaRecordingStarted?.(earliest, latest),
        onChunk: async (c: { base64: string; chunkSeq: number; isFinal: boolean; mimeType: string }) => {
          try { await w.__vexaRecordingChunk(c.base64, c.chunkSeq, c.isFinal, c.mimeType); return true; }
          catch { return false; }
        },
      });
      await w.__vexaRecordingTap.start();
    }
  }, timesliceMs).catch((e) => { console.error(`[bot] recording bridge: page-side start failed: ${String(e)}`); });

  // Stop fn: stop the recorder so it flushes the final (isFinal) chunk → master assembly.
  return async () => {
    await page.evaluate(async () => {
      const w = (globalThis as any) as Record<string, any>;
      try { await w.__vexaRecordingTap?.stop?.(); } catch { /* best-effort */ }
    }).catch(() => { /* page already gone */ });
  };
}

/**
 * The SPEAK path — inject TTS audio into the bot's mic.  // L4 (O6/VM): live-validated.
 *
 * Production (services/vexa-bot/core/src/index.ts:595, 1039–1059 + services/tts-playback.ts)
 * does this at the OS level, not via a page fake-mic: a PulseAudio chain `tts_sink → virtual_mic`
 * is what Chromium captures as its microphone. The bot (a) unmutes the meeting-UI mic button
 * (page.evaluate clicks the platform's mic control), (b) writes synthesized PCM to the tts_sink
 * device (paplay) which feeds virtual_mic, then (c) re-mutes after a short tail.
 *
 * This bot package does not own the PulseAudio/TTS process plumbing (that is the container
 * entrypoint + a TTS service, outside the bot's import surface), so here we wire only the
 * BROWSER half it CAN drive — the meeting-UI mic toggle — and leave a clearly-marked seam for
 * the OS-level audio injection the VM image provides. Speaking is gated on inv.voiceAgentEnabled.
 */
export interface SpeakController {
  stream(id: string, token: string): Promise<void>;
  chatStream(id: string, token: string): Promise<void>;
  activity(name: string, ended: boolean): void;
  presence(ids: string[], complete: boolean): boolean;
  roomRevision(): string;
  /** Begin speaking `text` (TTS synthesized + injected via the VM's PulseAudio chain). */
  speak(text: string, voice?: string): Promise<void>;
  /** Stop any in-flight speech (barge-in). */
  stop(): Promise<void>;
  /** Post `text` into the meeting's chat panel (acts.v1 `chat_send`). Best-effort DOM drive. */
  sendChat(text: string, expectedRoom?: string, expectedEpoch?: number): Promise<boolean>;
}

export function createSpeakController(page: Page, inv: Invocation, onInterrupt?: () => void): SpeakController {
  const enabled = !!inv.voiceAgentEnabled;
  const platform = inv.platform;
  const tts = createTtsPlayback((m) => console.log(`[bot] ${m}`));   // OS-level TTS→tts_sink half
  const stream = createMeetingSpeech(value => setTtsMute(value));
  let speechEpoch = 0;
  let room = '';
  let roomRevision = '';
  const advance = (): number => {
    const value = ++speechEpoch;
    void page.evaluate((epoch: number) => { (globalThis as any).__vexaSpeechEpoch = epoch; }, value).catch(() => {});
    return value;
  };
  const permittedRoom = (token: string): boolean => {
    try { return !!roomRevision && JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).room === roomRevision; }
    catch { return false; }
  };
  const speechTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const chats = new Set<string>();

  // Toggle the meeting-UI mic button so the bot is audible only while speaking (production
  // unmutes before speech + auto-mutes after — index.ts:1039–1059). The PulseAudio source
  // (tts_sink → virtual_mic) is the actual audio path and is provided by the VM image.
  // Ensure the meeting-UI mic is UNMUTED — state-checked, NEVER a blind toggle. The audibility gate
  // is the PulseAudio virtual_mic mute (tts-playback opens it only during playback), NOT this button.
  // The old code toggled the button blindly on every speak: because the bot joins UNMUTED, that click
  // MUTED the live mic for the exact playback window (then unmuted it after) → speech was silent.
  // We now click ONLY when the control clearly reports the mic is currently OFF, and we never mute it
  // back (the PA-level mute already keeps the bot silent between speaks).
  const ensureMicUnmuted = () => ensureMeetingMicUnmuted(page, platform);

  const controller: SpeakController = {
    async chatStream(id, token): Promise<void> {
      if (!enabled || !permittedRoom(token) || chats.has(id) || chats.size >= 5000) return;
      chats.add(id);
      const own = advance();
      tts.stop(); stream.stop();
      const audience = room;
      await deliverMeetingChat(id, token, () => own === speechEpoch && room === audience,
        text => controller.sendChat(text, audience, own));
    },
    activity(name, ended): void {
      if (ended) { clearTimeout(speechTimers.get(name)); speechTimers.delete(name); return; }
      if (speechTimers.has(name)) return;
      speechTimers.set(name, setTimeout(() => { advance(); stream.stop(); tts.stop(); onInterrupt?.(); }, 300));
    },
    presence(ids, complete): boolean {
      const next = JSON.stringify({ ids: [...new Set(ids)].sort(), complete });
      if (next === room) return false;
      room = next; roomRevision = globalThis.crypto.randomUUID(); advance(); stream.stop(); tts.stop();
      return true;
    },
    roomRevision: () => roomRevision,
    async stream(id: string, token: string): Promise<void> {
      if (!enabled || !permittedRoom(token)) return;
      const own = advance();
      tts.stop();
      if (speechTimers.size) {
        const pending = stream.speak(id, token); stream.stop(); await pending;
        return;
      }
      const audible = await ensureMicUnmuted();
      if (own !== speechEpoch) return;
      if (!audible) { await failMeetingSpeech(id, token); return; }
      if (speechTimers.size) {
        const pending = stream.speak(id, token); stream.stop(); await pending;
        return;
      }
      const audience = room;
      await stream.speak(id, token, async () => {
        if (own !== speechEpoch || !permittedRoom(token)) return false;
        return await page.evaluate(({ expectedRoom, epoch }) => {
          const g = globalThis as any;
          const snapshot = g.__vexaRoomSnapshot?.();
          return g.__vexaSpeechEpoch === epoch && !!snapshot &&
            JSON.stringify({ ids: [...new Set(snapshot.ids)].sort(), complete: snapshot.complete }) === expectedRoom;
        }, { expectedRoom: audience, epoch: own }).catch(() => false);
      });
    },
    async speak(text: string, voice?: string): Promise<void> {
      const own = advance();
      stream.stop();
      if (!enabled) { console.error('[bot] speak ignored: voiceAgentEnabled is false'); return; }
      console.log(`[bot] speak: ${text.length} characters`);
      await ensureMicUnmuted();                               // (a) make sure the UI mic is ON (never mutes a live mic)
      if (own !== speechEpoch) return;
      // (b) synthesize via the TTS service + stream PCM to tts_sink → virtual_mic; audibility is gated
      //     at the PA level (virtual_mic mute) inside tts.speak, so the UI mic just stays on.
      await tts.speak(text, voice).catch((e) => console.error(`[bot] speak: tts failed: ${String(e)}`));
    },
    async stop(): Promise<void> {
      if (!enabled) return;
      advance();
      tts.stop();                                             // barge-in: kill playback + re-mute tts_sink (PA-level)
      stream.stop();
      console.log('[bot] speak_stop');
    },
    async sendChat(text: string, expectedRoom?: string, expectedEpoch?: number): Promise<boolean> {
      if (!enabled) return false;
      // Post into the meeting chat via the DOM (no server-side chat backend in the core). Best-effort:
      // open the chat panel if needed, set the input value (native setter so React picks it up),
      // then click Send or press Enter. Meet/Jitsi use an aria-labelled textarea; Teams/Zoom differ.
      // NB: DOM type names (Document/HTMLElement/KeyboardEvent/…) are NOT available here — the bot
      // compiles with `lib: ["ES2022"]` and no `dom` lib (tsconfig.base.json), so referencing them
      // is a TS2304 build failure. Every evaluate block in this file therefore reaches the browser
      // through `(globalThis as any)`; keep that idiom.
      return await page.evaluate(async ({ text, expectedRoom, expectedEpoch }) => {
        const g = (globalThis as any);
        const doc = g.document;
        if (!doc) return false;
        const matches = () => {
          if (expectedEpoch !== undefined && g.__vexaSpeechEpoch !== expectedEpoch) return false;
          if (!expectedRoom) return true;
          const snapshot = g.__vexaRoomSnapshot?.();
          return !!snapshot && JSON.stringify({ ids: [...new Set(snapshot.ids)].sort(), complete: snapshot.complete }) === expectedRoom;
        };
        const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
        const findInput = (): any =>
          doc.querySelector('textarea[aria-label*="message" i]')
          || doc.querySelector('textarea[placeholder*="message" i]')
          || doc.querySelector('div[contenteditable="true"][aria-label*="message" i]')
          || doc.querySelector('textarea');
        const byLabel = (re: RegExp): any =>
          (Array.from(doc.querySelectorAll('[role="button"],button')) as any[])
            .find((b) => re.test((b.getAttribute('aria-label') || b.getAttribute('data-tooltip') || '')));
        let input = findInput();
        if (!input) {
          byLabel(/chat with everyone|open chat|^chat$|messages/i)?.click();   // open the panel
          await sleep(700);
          input = findInput();
        }
        if (!input || !matches()) return false;
        input.focus();
        const tag = input.tagName;
        if (tag === 'TEXTAREA' || tag === 'INPUT') {
          // Native value setter, so React's onChange actually fires (a bare `.value =` is swallowed).
          const proto = tag === 'TEXTAREA' ? g.HTMLTextAreaElement.prototype : g.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(input, text); else input.value = text;
          input.dispatchEvent(new g.Event('input', { bubbles: true }));
        } else {
          input.textContent = text;
          input.dispatchEvent(new g.Event('input', { bubbles: true }));
        }
        await sleep(200);
        if (!matches()) {
          input.value = ''; input.textContent = ''; input.dispatchEvent(new g.Event('input', { bubbles: true }));
          return false;
        }
        const send = byLabel(/send a message|send message|^send$/i);
        if (send && !send.disabled) send.click();
        else for (const type of ['keydown', 'keypress', 'keyup']) {
            input.dispatchEvent(new g.KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        }
        await sleep(150);
        return !(input.value || input.textContent || '').trim();
      }, { text, expectedRoom, expectedEpoch }).catch(() => false);
    },
  };
  return controller;
}
