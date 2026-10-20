import assert from 'node:assert/strict';
import { createBotPipeline } from './pipeline.js';
import { whisperStreamingFromEnv } from './config.js';
import type { Invocation } from './config.js';
import type { TranscriptSegment } from './contracts.js';
import { speechEnd } from './streaming-gmeet.js';

class FakeSocket {
  readyState = 1; bufferedAmount = 0; closed = false;
  sent: (string | ArrayBufferView)[] = [];
  listeners = new Map<string, ((e: any) => void)[]>();
  send(v: string | ArrayBufferView) { this.sent.push(v); }
  close() { this.closed = true; this.readyState = 3; }
  addEventListener(n: string, fn: (e: any) => void) { this.listeners.set(n, [...(this.listeners.get(n) || []), fn]); }
  emit(n: string, e: any = {}) { for (const fn of this.listeners.get(n) || []) fn(e); }
  get uid() { return JSON.parse(this.sent.find(v => typeof v === 'string') as string).uid; }
  ready() { this.emit('open'); this.frame({ message: 'SERVER_READY' }); }
  frame(v: object) { this.emit('message', { data: JSON.stringify({ uid: this.uid, ...v }) }); }
}
const inv = { platform: 'google_meet', transcribeEnabled: true, language: 'en' } as Invocation;
const pcm = (seconds = 1) => new Float32Array(seconds * 16000).fill(.1);
const pause = () => new Promise(resolve => setTimeout(resolve, 120));
function fixture(earlyFinal = true) {
  let clock = 1792485000000;
  const sockets: FakeSocket[] = [], results: TranscriptSegment[] = [], faults: any[] = [];
  const pipe = createBotPipeline(inv, { publish: async s => { results.push(s); } }, {
    transcribe: async () => { throw Error('batch path must not run'); },
    streaming: { url: 'ws://whisper.invalid:9090', model: 'large-v3-turbo', earlyFinal,
      now: () => clock, socket: () => { const ws = new FakeSocket(); sockets.push(ws); return ws; } },
    onError: e => faults.push(e),
  });
  return { pipe, sockets, results, faults, now: () => clock,
    async advance(ms: number) { clock += ms; await pause(); },
    async clean() { for (const ws of sockets) if (!ws.closed) ws.emit('error'); await pipe.stop(); },
  };
}
assert.equal(speechEnd(new Float32Array(16000)), 0);
assert.equal(speechEnd(pcm()), 16000);
assert.equal(whisperStreamingFromEnv({}), undefined);
assert.equal(whisperStreamingFromEnv({ BOT_WHISPER_WS_URL: 'ws://whisper-live:9090' })?.model, 'large-v3-turbo');
for (const url of ['https://host', 'ws://user:secret@host', 'ws://host?token=secret']) {
  assert.throws(() => whisperStreamingFromEnv({ BOT_WHISPER_WS_URL: url }));
}

// Exercise the actual composition root: ten channels, one socket each, ready-before-audio,
// two matching drafts + real silence, one final each, and no batch transcription calls.
{
  const f = fixture();
  try {
    for (let i = 0; i < 10; i++) f.pipe.feedAudio(i, `Speaker ${i}`, pcm(), f.now());
    assert.equal(f.sockets.length, 10);
    for (const ws of f.sockets) {
      assert.equal(ws.sent.length, 0, 'PCM must wait for SERVER_READY');
      ws.ready();
      const hello = JSON.parse(ws.sent[0] as string);
      assert.equal(hello.audio_format, 'float32'); assert.equal(hello.use_vad, true);
      assert(ws.sent[1] instanceof Float32Array);
      for (let n = 0; n < 2; n++) ws.frame({ language: 'en', segments: [{ start: 0, end: 1, text: 'Vox AI, summarize the decisions.', completed: false }] });
    }
    await f.advance(500);
    assert.equal(f.results.filter(s => s.completed).length, 10);
    assert.equal(new Set(f.results.filter(s => s.completed).map(s => s.segment_id)).size, 10);
    assert(f.sockets.every(ws => ws.closed));
    const count = f.results.length;
    for (const ws of f.sockets) ws.frame({ segments: [{ start: 0, end: 1, text: 'Vox AI, summarize the decisions.', completed: true }] });
    await pause(); assert.equal(f.results.length, count, 'Delayed finals after early endpoint cannot duplicate turns');
    assert.equal(f.faults.length, 0);
  } finally { await f.clean(); }
}
// A continuing speaker invalidates an old decode even if its text is repeated.
{
  const f = fixture();
  try {
    f.pipe.feedAudio(0, 'Alice', pcm(), f.now()); const ws = f.sockets[0]; ws.ready();
    for (let n = 0; n < 2; n++) ws.frame({ segments: [{ start: 0, end: 1, text: 'Please review the plan', completed: false }] });
    await f.advance(400); f.pipe.feedAudio(0, 'Alice', pcm(.4), f.now());
    await f.advance(500);
    assert.equal(f.results.filter(s => s.completed).length, 0, 'Old decode must not truncate newly captured words');
    assert(!ws.closed);
    const end = 1.4;
    for (let n = 0; n < 2; n++) ws.frame({ segments: [{ start: 0, end, text: 'Please review the plan tomorrow.', completed: false }] });
    await f.advance(100);
    assert.equal(f.results.filter(s => s.completed).length, 1);
    assert.equal(f.results.filter(s => s.completed)[0].text, 'Please review the plan tomorrow.');
  } finally { await f.clean(); }
}
// Speaker rotation drains the old speaker under its fixed name; no relabel/drop race.
{
  const f = fixture(false);
  try {
    f.pipe.feedAudio(0, 'Alice', pcm(), f.now()); const a = f.sockets[0]; a.ready();
    await f.advance(200); f.pipe.feedAudio(0, 'Bob', pcm(.2), f.now()); const b = f.sockets[1]; b.ready();
    assert(!a.closed, 'Rotation must retain the old socket until finalization');
    a.frame({ segments: [{ start: 0, end: 1, text: 'Alice agreed to the proposal.', completed: true }] });
    b.frame({ segments: [{ start: 0, end: .2, text: 'Bob will review the proposal.', completed: true }] });
    await f.advance(500);
    assert.deepEqual(f.results.filter(s => s.completed).map(s => s.speaker), ['Alice', 'Bob']);
    assert(a.closed && b.closed);
  } finally { await f.clean(); }
}
// A late retired-speaker failure must not throttle the healthy successor on the same channel.
{
  const f = fixture(false);
  try {
    f.pipe.feedAudio(0, 'Alice', pcm(), f.now()); const a = f.sockets[0]; a.ready();
    await f.advance(200); f.pipe.feedAudio(0, 'Bob', pcm(.2), f.now()); const b = f.sockets[1]; b.ready();
    a.emit('error'); const before = b.sent.length;
    await f.advance(100); f.pipe.feedAudio(0, 'Bob', pcm(.1), f.now());
    assert(b.sent.length > before, 'Retired Alice failure must not drop Bob audio');
    assert(!b.closed);
  } finally { await f.clean(); }
}
// Delayed PCM arriving after synthetic silence retains its ORIGINAL capture interval.
// A later attendee must never be granted old speech relabeled with the decoder's clock.
{
  const f = fixture(false);
  try {
    const firstEnd = f.now();
    f.pipe.feedAudio(0, 'Alice', pcm(), firstEnd); const ws = f.sockets[0]; ws.ready();
    for (let i = 0; i < 15; i++) await f.advance(100);
    // Determine the decoder position from the actual binary PCM submitted, including padding.
    const samples = ws.sent.filter(v => v instanceof Float32Array).reduce((sum, v) => sum + (v as Float32Array).length, 0);
    const delayedStart = samples / 16000;
    f.pipe.feedAudio(0, 'Alice', pcm(.256), firstEnd + 256);
    ws.frame({ segments: [{ start: delayedStart, end: delayedStart + .256, text: 'Speech captured before the attendee joined.', completed: true }] });
    await pause();
    const result = f.results.find(s => s.completed)!;
    assert(result);
    assert.equal(Date.parse(result.absolute_start_time!), firstEnd);
    assert.equal(Date.parse(result.absolute_end_time!), firstEnd + 256);
    const laterJoin = firstEnd + 1000;
    assert(result.start * 1000 < laterJoin, 'An attendance span starting later must exclude this entire segment');
  } finally { await f.clean(); }
}
// WAIT is attributable, the failed socket closes, cooldown prevents reconnection storms.
{
  const f = fixture();
  try {
    f.pipe.feedAudio(0, 'Alice', pcm(), f.now()); const ws = f.sockets[0]; ws.ready(); ws.frame({ status: 'WAIT' });
    assert(ws.closed); assert.equal(f.faults[0].kind, 'rate_limited'); assert.equal(f.faults[0].source, 'stt');
    f.pipe.feedAudio(0, 'Alice', pcm(), f.now()); assert.equal(f.sockets.length, 1);
    await f.advance(3100); f.pipe.feedAudio(0, 'Alice', pcm(), f.now()); assert.equal(f.sockets.length, 2);
  } finally { await f.clean(); }
}
// Unready/broken servers have bounded queues; recording capture itself remains operational.
{
  const f = fixture();
  try {
    for (let i = 0; i < 9; i++) f.pipe.feedAudio(0, 'Alice', pcm(), f.now());
    assert(f.sockets[0].closed); assert(f.faults.some(e => e.detail.includes('buffer exceeded')));
  } finally { await f.clean(); }
}
console.log('PASS streaming Meet: 10 channels, handshake, early endpoints, continuing speech, late-final dedup, rotation, capacity faults, bounded buffering');
