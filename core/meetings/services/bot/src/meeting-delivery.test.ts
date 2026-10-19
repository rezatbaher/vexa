import assert from 'node:assert/strict';
import http from 'node:http';
import { createSpeakController } from './capture-bridge.js';

// Exercise the actual controller and DOM submission callback. No real browser/meeting is used.
const g = globalThis as any;
const snapshot = { ids: ['a'], complete: true };
g.__vexaRoomSnapshot = () => snapshot;
g.Event = class {};
let submitted = 0, filled!: () => void;
const input = { tagName: 'DIV', textContent: '', focus() {}, dispatchEvent() { filled?.(); } };
const send = { disabled: false, getAttribute: () => 'Send', click() { submitted++; input.textContent = ''; } };
g.document = { querySelector: () => input, querySelectorAll: () => [send] };
const page = { evaluate: async (fn: any, arg: any) => fn(arg) };
const controller = createSpeakController(page as any, { voiceAgentEnabled: true, platform: 'google_meet' } as any);
controller.presence(snapshot.ids, true);
const token = (room: string) => `header.${Buffer.from(JSON.stringify({ room })).toString('base64url')}.signature`;
const original = token(controller.roomRevision());
let gets = 0;
const events: string[] = [];
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') { gets++; res.end(JSON.stringify({ text: 'Private authorized answer.' })); }
  else { let body = ''; for await (const c of req) body += c; events.push(JSON.parse(body).event); res.end('{}'); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.MEETING_SPEECH_URL = `http://127.0.0.1:${(server.address() as any).port}`;
try {
  snapshot.ids = ['a', 'newcomer']; controller.presence(snapshot.ids, true);
  await controller.chatStream('old-chat', original);
  await controller.stream('old-voice', original);
  assert.equal(gets, 0, 'Delayed voice/chat must not adopt the new room');
  snapshot.ids = ['a']; controller.presence(snapshot.ids, true);
  await controller.chatStream('old-again', original);
  assert.equal(gets, 0, 'Leaving and rejoining the same roster must not revive old replies');
  const current = token(controller.roomRevision());
  const entered = new Promise<void>(resolve => { filled = resolve; });
  const pending = controller.chatStream('cancelled-chat', current);
  await entered;
  await controller.stop();
  await pending;
  assert.equal(submitted, 0, 'Stop during the DOM delay must prevent submission');
  assert(events.includes('interrupted'));
  await controller.chatStream('successful-chat', current);
  assert.equal(submitted, 1);
  assert(events.includes('chat_submitted'));
  console.log('PASS meeting delivery: audience binding, rejoin, DOM cancellation, successful submission');
} finally {
  await controller.stop(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  delete g.document; delete g.__vexaRoomSnapshot;
}
