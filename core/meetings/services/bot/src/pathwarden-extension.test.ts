import assert from 'node:assert/strict';
import { createPathwardenExtension } from './pathwarden-extension.js';
import { createMeetingControl } from './meeting-control.js';

async function run() {
  const calls: string[] = [], frames: any[] = [], stored: any[] = [];
  const controls = createMeetingControl({ transcript: { async publish(s) { stored.push(s); } },
    publish: async f => { frames.push(f); }, recordingConfigured: false, transcriptionConfigured: true,
    setRecordingPaused: async () => true, stopSpeaking: async () => { calls.push('stop'); } });
  const page: any = { async evaluate() { calls.push('page'); } };
  const speak: any = { async speak() { calls.push('speak'); }, async stream() { calls.push('stream'); },
    async chatStream() { calls.push('chat'); }, async stop() { calls.push('stop'); },
    async sendChat() { calls.push('send'); }, presence: () => true, roomRevision: () => 'room' };
  const opts = { page, speak, controls, publish: async (frame: any) => { frames.push(frame); } };
  const absent = createPathwardenExtension({ ...opts, enabled: false });
  assert.deepEqual(absent.commandActions(), []);
  await absent.handle({ action: 'speak', text: 'ignored' });
  absent.presence(['human'], {}, true);
  await absent.dispose();
  assert.deepEqual(calls, []); assert.deepEqual(frames, []);
  const present = createPathwardenExtension({ ...opts, enabled: true });
  assert(present.commandActions().includes('speak_stream'));
  await present.handle({ action: 'speak', text: 'hello' });
  assert.deepEqual(calls, ['speak']);
  await present.handle({ action: 'meeting_control', revision: 1,
    request_id: '12345678-1234-1234-1234-123456789012', replies_muted: true, notes_enabled: false });
  await controls.sink.publish({ segment_id: 's', speaker: 'human', text: 'private', start: 0, end: 1, completed: true });
  assert.equal(stored.length, 0);
  const before = calls.length;
  await present.handle({ action: 'speak', text: 'muted' });
  assert.equal(calls.length, before);
  present.presence(['human'], { human: 'Person' }, false);
  assert.equal(frames.at(-1).complete, false);
  await present.dispose();
  const disposed = calls.length;
  await present.handle({ action: 'chat_send', text: 'after teardown' });
  present.presence([], {}, true);
  assert.equal(calls.length, disposed);
  console.log('pathwarden extension: absent path, actual dispatch, pause/mute, presence and disposal pass');
}
run().catch(e => { console.error(e); process.exit(1); });
