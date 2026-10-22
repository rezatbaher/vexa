import assert from 'node:assert/strict';
import { createMeetingControl } from './meeting-control.js';
import { parseAct } from './contracts.js';
import { startRecording } from './capture-bridge.js';

async function run() {
  const stored: any[] = [], frames: any[] = [], pauses: boolean[] = [];
  let clock = 100000;
  const controls = createMeetingControl({
    transcript: { async publish(s) { stored.push(s); } },
    async publish(f) { frames.push(f); },
    recordingConfigured: true, transcriptionConfigured: true,
    async setRecordingPaused(p) { pauses.push(p); return true; },
    async stopSpeaking() {}, now: () => clock,
  });
  const segment = (text: string, start = clock) => ({ segment_id: 'seg', speaker: 'Person', text,
    start: start / 1000, end: (start + 1) / 1000, completed: true });
  await controls.sink.publish(segment('Before pause'));
  const request_id = '12345678-1234-1234-1234-123456789012';
  await controls.handle({ action: 'meeting_control', revision: 1, request_id, notes_enabled: false });
  await controls.sink.publish(segment('Private unrecorded conversation'));
  await controls.sink.publish(segment('Hey assistant resume notes'));
  await controls.sink.publish(segment('Hey agent.'));
  clock += 3000;
  await controls.sink.publish(segment('Resume notes'));
  await controls.sink.publish(segment('Private paused discussion'));
  assert.equal(stored.length, 1);
  assert.equal(frames.filter(f => f.type === 'meeting.command.v1').length, 3);
  assert.equal(frames[0].state.transcription_enabled, false);
  clock += 1000;
  await controls.handle({ action: 'meeting_control', revision: 2, request_id, notes_enabled: true });
  await controls.sink.publish(segment('Buffered speech across pause', clock - 500));
  await controls.sink.publish(segment('After resume'));
  assert.equal(stored.length, 2);
  await controls.handle({ action: 'meeting_control', revision: 1, request_id, notes_enabled: false });
  assert.equal(controls.retain(), true);
  assert.deepEqual(pauses, [true, false]);
  assert.equal(parseAct({ action: 'meeting_control', revision: 1, request_id, notes_enabled: 'false' }), null);
  console.log('meeting controls: paused retention, ephemeral commands, boundary and replay checks passed');
}
await run();

const failedFrames: any[] = [], failedStored: any[] = [];
const failed = createMeetingControl({ transcript: { async publish(s) { failedStored.push(s); } },
  async publish(f) { failedFrames.push(f); }, recordingConfigured: true, transcriptionConfigured: true,
  async setRecordingPaused() { return false; }, async stopSpeaking() {} });
const request_id = '12345678-1234-1234-1234-123456789012';
await failed.handle({ action: 'meeting_control', request_id, revision: 1, notes_enabled: false });
await failed.handle({ action: 'meeting_control', request_id, revision: 2, notes_enabled: true });
assert.equal(failed.retain(), false, 'failed recorder pause requires restart before retention can resume');
assert.equal(failedFrames.at(-1).state.recording_enabled, null);
assert.equal(failedFrames.at(-1).error, 'recording_control_failed');

const exposed: Record<string, Function> = {}, chunks: any[] = [];
const page = { async exposeFunction(name: string, fn: Function) { exposed[name] = fn; }, async evaluate() {} };
await startRecording(page as any, { platform: 'google_meet' } as any, {
  started() {}, chunk(...args: any[]) { chunks.push(args); }, close() {},
}, () => false);
exposed.__vexaRecordingChunk('cHJpdmF0ZQ==', 1, false, 'audio/webm');
exposed.__vexaRecordingChunk('', 2, true, 'audio/webm');
assert.equal(chunks.length, 1);
assert.equal(chunks[0][2], true);
assert.equal(chunks[0][4].length, 0, 'paused completion never includes audio');
console.log('failed pause stays fail-closed; stopping while paused preserves empty final marker');
