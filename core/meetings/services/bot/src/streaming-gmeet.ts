/** Google Meet Float32 PCM -> persistent WhisperLive WebSocket -> transcript.v1.
 * Channel/name bindings never change during a socket. No audio/text is logged.
 * Stable-tail endpointing is bounded by actual speech energy and decode freshness.
 */
import { TranscriptionError } from '@vexa/transcribe-whisper';
import { randomUUID } from 'node:crypto';
import { isHallucination } from '@vexa/gmeet-pipeline';
import type { TranscriptSegment } from './contracts.js';
import type { BotPipeline } from './pipeline.js';
import type { TranscriptSink } from './ports.js';

interface Socket {
  readyState: number;
  bufferedAmount: number;
  send(data: string | ArrayBufferView): void;
  close(): void;
  addEventListener(name: string, fn: (event: any) => void): void;
}
export interface StreamingOptions {
  url: string;
  model?: string;
  language?: string;
  earlyFinal?: boolean;
  now?: () => number;
  socket?: (url: string) => Socket;
  onError?: (error: unknown) => void;
}
interface Candidate { start: number; end: number; text: string; repeats: number; at: number }
interface Stream {
  id: string; channel: number; name: string; origin: number; cursor: number;
  socket: Socket; ready: boolean; ended: boolean; lastFeed: number; lastSpeech: number; lastSpeechOffset: number;
  capture: { a: number; b: number; start: number; end: number }[];
  queued: Float32Array[]; queuedSamples: number; candidate?: Candidate; language?: string;
  pieces: Map<string, Candidate>; lastDraft?: string;
  finals: Map<string, string>; confirmedUntil: number; retireUntil?: number; publishing: Promise<void>;
}
const SR = 16000;
const MAX_QUEUE = 8 * SR;
const INCOMPLETE = /\b(and|or|the|to|with|because|of|for|a|an|at|in|that|if|but|is)$/i;

/** Last energetic 20ms frame. Silence padding never extends the speech clock. */
export function speechEnd(pcm: Float32Array): number {
  let last = 0;
  for (let i = 0; i < pcm.length; i += 320) {
    let power = 0;
    const n = Math.min(320, pcm.length - i);
    for (let j = i; j < i + n; j++) power += pcm[j] * pcm[j];
    if (Math.sqrt(power / n) >= 700 / 32768) last = i + n;
  }
  return last;
}

export function createStreamingGmeet(sink: TranscriptSink, opts: StreamingOptions): BotPipeline {
  const now = opts.now ?? Date.now;
  const makeSocket = opts.socket ?? ((url: string) => new (globalThis as unknown as {
    WebSocket: new (url: string) => Socket;
  }).WebSocket(url));
  const streams = new Map<number, Stream>();
  const retiring = new Set<Stream>();
  const cooldown = new Map<number, number>();
  const publications = new Set<Promise<void>>();
  let stopped = false;
  let stopping = false;
  let shutdown: Promise<void> | undefined;
  const fault = (kind: string) => opts.onError?.(new TranscriptionError(kind === 'capacity unavailable' ? 'rate_limited' : 'unavailable', undefined, kind, true));
  const send = (s: Stream, pcm: Float32Array) => {
    if (s.ended) return;
    if (!s.ready) {
      s.queued.push(pcm.slice()); s.queuedSamples += pcm.length;
      if (s.queuedSamples > MAX_QUEUE) fail(s, 'connection audio buffer exceeded 8 seconds');
      return;
    }
    if (s.socket.bufferedAmount > MAX_QUEUE * 4) { fail(s, 'audio backpressure'); return; }
    // Node's WebSocket sends this typed array as Float32 little-endian PCM, not WAV.
    s.socket.send(pcm);
  };
  const close = (s: Stream, complete = false) => {
    // Retain confirmed speech on failure without asking a truncated question.
    if (!s.ended && !complete) {
      const prefix = assembled(s, false);
      if (prefix) publish(s, prefix, true, true);
    }
    if (s.ended) return;
    s.ended = true;
    if (streams.get(s.channel) === s) streams.delete(s.channel);
    retiring.delete(s);
    s.queued = []; s.queuedSamples = 0;
    try { if (s.socket.readyState === 1) s.socket.send(Buffer.from('END_OF_AUDIO')); s.socket.close(); } catch { /* already closed */ }
  };
  const retire = (s: Stream) => {
    if (s.ended) return;
    if (streams.get(s.channel) === s) streams.delete(s.channel);
    s.retireUntil = now() + 8000; retiring.add(s);
  };
  function fail(s: Stream, kind: string) {
    if (s.ended) return;
    fault(kind);
    if (!streams.has(s.channel) || streams.get(s.channel) === s) cooldown.set(s.channel, now() + 3000);
    close(s);
  }
  const assembled = (s: Stream, includeTail: boolean): Candidate | undefined => {
    const parts = [...s.pieces.values()];
    if (includeTail && s.candidate) parts.push(s.candidate);
    parts.sort((a, b) => a.start - b.start);
    if (!parts.length) return;
    return { start: parts[0].start, end: Math.max(...parts.map(c => c.end)),
      text: parts.map(c => c.text).join(' '), repeats: 0, at: now() };
  };
  const publish = (s: Stream, c: Candidate, completed: boolean, incomplete = false) => {
    const a = s.origin + c.start * 1000, b = s.origin + c.end * 1000;
    // Decoder offsets include synthetic silence and delayed frames. Only the producer's
    // original capture timestamps can grant attendance access. Whole-frame bounds are
    // deliberately conservative: a boundary frame must be inside the attendance span.
    const frames = s.capture.filter(f => f.a < b && a < f.b);
    if (!frames.length) return;
    const start = Math.min(...frames.map(f => f.start));
    const end = Math.max(...frames.map(f => f.end));
    if (end <= start || isHallucination(c.text, { allowShort: true })) return;
    if (!completed && s.lastDraft === c.text) return;
    if (!completed) s.lastDraft = c.text;
    const seg: TranscriptSegment = {
      segment_id: `${s.id}:utterance${incomplete ? ":incomplete" : ""}`, speaker: s.name,
      speaker_key: `wl:${s.id}`, text: c.text, start: start / 1000, end: end / 1000,
      absolute_start_time: new Date(start).toISOString(), absolute_end_time: new Date(end).toISOString(),
      completed, language: s.language, words: [],
      source: s.name === 'Speaker' ? 'provisional-cluster-id' : 'glow-bound',
      confidence: s.name === 'Speaker' ? 0 : 1,
    };
    const key = seg.segment_id;
    if (s.finals.get(key) === c.text) return;
    if (completed) {
      s.finals.set(key, c.text);
      if (s.finals.size > 200) s.finals.delete(s.finals.keys().next().value!);
    }
    const pending = s.publishing.then(() => sink.publish(seg)).catch(() => fault('transcript publish failed'));
    s.publishing = pending;
    publications.add(pending); void pending.finally(() => publications.delete(pending));
  };
  const receive = (s: Stream, raw: unknown) => {
    if (s.ended || stopped || typeof raw !== 'string' || raw.length > 512000) return;
    let frame: any;
    try { frame = JSON.parse(raw); } catch { fail(s, 'malformed response'); return; }
    if (frame.uid && frame.uid !== s.id) return;
    if (frame.status === 'WAIT' || frame.status === 'ERROR' || frame.message === 'DISCONNECT') {
      fail(s, frame.status === 'WAIT' ? 'capacity unavailable' : 'server disconnected'); return;
    }
    if (frame.message === 'SERVER_READY') {
      s.ready = true;
      const queued = s.queued; s.queued = []; s.queuedSamples = 0;
      for (const pcm of queued) send(s, pcm);
      return;
    }
    if (typeof frame.language === 'string' && /^[a-z]{2,3}$/.test(frame.language)) s.language = frame.language;
    if (!Array.isArray(frame.segments)) return;
    let tail: Candidate | undefined;
    for (const seg of frame.segments.slice(-100)) {
      const start = Number(seg.start), end = Number(seg.end), text = String(seg.text ?? '').trim();
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !text || text.length > 12000 || s.origin + end * 1000 > s.cursor + 300) continue;
      if (isHallucination(text, { allowShort: true })) {
        s.pieces.delete(start.toFixed(3));
        if (seg.completed === true) s.confirmedUntil = Math.max(s.confirmedUntil, s.origin + end * 1000);
        continue;
      }
      const old = s.candidate;
      const c: Candidate = { start, end, text, at: now(),
        repeats: old && old.text === text && Math.abs(old.start - start) < .02 ? old.repeats + 1 : 1 };
      if (seg.completed === true) {
        s.pieces.set(start.toFixed(3), c);
        if (s.pieces.size > 2048) { fail(s, 'utterance text buffer limit'); return; }
        s.confirmedUntil = Math.max(s.confirmedUntil, s.origin + end * 1000);
      }
      else { tail = c; }
    }
    // Whisper confirms prefixes while the caller is still speaking. Keep those words,
    // then publish ONE completed utterance only at an endpoint; wake words may span prefixes.
    s.candidate = tail && s.origin + tail.end * 1000 > s.confirmedUntil ? tail : undefined;
    const draft = assembled(s, true);
    if (draft) publish(s, draft, false);
  };
  const open = (channel: number, name: string, origin: number): Stream | undefined => {
    if (streams.size + retiring.size >= 32) { fault('active channel limit'); return; }
    let socket: Socket;
    try { socket = makeSocket(opts.url); } catch { fault('connection failed'); cooldown.set(channel, now() + 3000); return; }
    const s: Stream = { id: randomUUID(), channel, name, origin, cursor: origin, socket, ready: false,
      ended: false, lastFeed: now(), lastSpeech: origin, lastSpeechOffset: origin, capture: [], queued: [], queuedSamples: 0,
      language: opts.language, pieces: new Map(), finals: new Map(), confirmedUntil: origin, publishing: Promise.resolve() };
    streams.set(channel, s);
    socket.addEventListener('open', () => {
      if (s.ended || stopped) { socket.close(); return; }
      socket.send(JSON.stringify({ uid: s.id, language: opts.language && /^[a-z]{2,3}$/.test(opts.language) ? opts.language : null, task: 'transcribe',
        model: opts.model ?? 'large-v3-turbo', use_vad: true, audio_format: 'float32',
        // Avoid irreversible mid-sentence cuts; local silence/stable-tail endpointing stays fast.
        same_output_threshold: 8, send_last_n_segments: 30 }));
    });
    socket.addEventListener('message', e => { try { receive(s, e.data); } catch { fail(s, 'response processing failed'); } });
    socket.addEventListener('error', () => fail(s, 'connection failed'));
    socket.addEventListener('close', () => { if (!s.ended) fail(s, 'connection closed'); });
    return s;
  };
  const tick = () => {
    const at = now();
    for (const s of [...streams.values(), ...retiring]) {
      if (!s.ready && at - s.origin > 8000) { fail(s, 'server readiness timeout'); continue; }
      if (s.retireUntil && at >= s.retireUntil) {
        fault('final transcript timeout'); close(s); continue;
      }
      if (at - s.lastFeed >= 450 && !s.candidate && s.confirmedUntil >= s.lastSpeechOffset - 160 && s.confirmedUntil > s.origin) {
        const utterance = assembled(s, false);
        if (utterance) publish(s, utterance, true);
        close(s, true); continue;
      }
      const c = s.candidate;
      // Require two matching decodes, a quiet caller, a fresh decode, and coverage of the
      // latest speech. A later audio frame invalidates the endpoint until decoded too.
      const hold = c && INCOMPLETE.test(c.text.replace(/[,.!?]+$/, '')) ? 1100 : 450;
      if (opts.earlyFinal !== false && c && c.repeats >= 2 && at - s.lastSpeech >= hold &&
          at - c.at < 2000 && s.origin + c.end * 1000 >= s.lastSpeechOffset - 160 &&
          at - s.lastFeed >= 450) {
        const utterance = assembled(s, true);
        if (utterance) publish(s, utterance, true);
        close(s, true); // New audio gets a new segment/socket; delayed server finals cannot duplicate a reply.
        continue;
      }
      if (at - s.lastFeed > 15000) { fault('utterance finalization timeout'); close(s); continue; }
      // Capture omits silent chunks. Restore silence at real-time pace, leaving 500ms
      // for a delayed AudioWorklet frame so silence cannot run ahead of captured speech.
      if (at - s.lastFeed > 600) {
        const count = Math.min(1600, Math.floor((at - 500 - s.cursor) * SR / 1000));
        if (count > 0) { send(s, new Float32Array(count)); s.cursor += count / SR * 1000; }
      }
    }
  };
  const timer = setInterval(tick, 100); timer.unref();
  return {
    async start() {},
    async stop() {
      if (!shutdown) shutdown = (async () => {
        stopping = true;
        for (const s of [...streams.values()]) retire(s);
        const deadline = Date.now() + 8500;
        while (retiring.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        stopped = true; clearInterval(timer);
        for (const s of [...streams.values(), ...retiring]) close(s);
        await Promise.all([...publications]);
      })();
      await shutdown;
    },
    feedMixedAudio() {}, recordHint() {},
    feedAudio(channel, glowName, pcm, tsMs) {
      if (stopped || stopping || !pcm.length || !Number.isFinite(tsMs) || Math.abs(now() - tsMs) > 5000) return;
      if ((cooldown.get(channel) ?? 0) > now()) return;
      const duration = pcm.length / SR * 1000;
      let s = streams.get(channel);
      if (s && glowName && s.name !== glowName) { retire(s); s = undefined; }
      if (!s) s = open(channel, glowName || 'Speaker', tsMs - duration);
      if (!s) return;
      // Audio frames are end-stamped. Fill omitted silent frames, but never create huge queues.
      const gap = Math.max(0, tsMs - duration - s.cursor);
      if (gap > 8000) { retire(s); s = open(channel, glowName || 'Speaker', tsMs - duration); if (!s) return; }
      else if (gap >= 20) { send(s, new Float32Array(Math.round(gap / 1000 * SR))); s.cursor += gap; }
      if (s.ended) return;
      if (s.capture.length >= 4096) { fail(s, 'capture timing buffer limit'); return; }
      s.capture.push({ a: s.cursor, b: s.cursor + duration, start: tsMs - duration, end: tsMs });
      send(s, pcm);
      s.cursor += duration; s.lastFeed = now();
      const end = speechEnd(pcm);
      if (end) {
        s.lastSpeech = tsMs - (pcm.length - end) / SR * 1000;
        s.lastSpeechOffset = s.cursor - (pcm.length - end) / SR * 1000;
      }
    },
  };
}
