import assert from 'node:assert/strict';
import http from 'node:http';
import { createMeetingPresentation } from './meeting-presentation.js';

const events: any[] = [];
let delayed: http.ServerResponse | undefined;
const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = ''; req.on('data', b => { body += b; });
    req.on('end', () => { events.push({ token: req.headers.authorization, ...JSON.parse(body) }); res.end('{}'); });
    return;
  }
  if (req.headers.authorization === 'Bearer revoked') { res.writeHead(409); res.end(); return; }
  if (req.headers.authorization === 'Bearer delayed') { delayed = res; return; }
  res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(Buffer.from('approved-image'));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as any;
process.env.MEETING_SPEECH_URL = `http://127.0.0.1:${address.port}`;
let sharing = false, draws = 0, stops = 0;
(globalThis as any).__vexaMeetingVisuals = {
  async show() { draws++; sharing = true; return true; },
  sharing: () => sharing,
  stop() { stops++; sharing = false; },
};
(globalThis as any).document = { querySelectorAll() { return [{ getClientRects: () => [1],
  getAttribute: () => sharing ? 'Stop presenting' : 'Present now', textContent: '', click() {} }]; } };
const page = { async evaluate(fn: Function, arg?: any) { return fn(arg); }, async waitForTimeout() {} };
const controller = createMeetingPresentation(page as any, () => 'room', () => true, () => '{"ids":["alice"],"complete":true}');
const act = (sequence: number, token = 'valid'): any => ({ action: 'presentation_show', sequence, token,
  presentation_id: '12345678-1234-1234-1234-123456789012', room_revision: 'room', page: 1 });
try {
  await controller.show(act(2));
  assert.equal(sharing, true);
  const before = stops;
  await controller.show(act(1));
  await controller.show(act(3, 'revoked'));
  assert.equal(stops, before, 'stale/unauthorized command must not stop a current authorized presentation');
  assert.equal(draws, 1);
  const pending = controller.show(act(3, 'delayed'));
  for (let i=0; !delayed && i<100; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(delayed);
  await controller.show(act(4));
  delayed!.writeHead(200, { 'Content-Type': 'image/jpeg' }); delayed!.end(Buffer.from('old-approved-image'));
  await pending;
  assert.equal(draws, 2, 'late authorized response cannot overwrite a later sequence');
  assert.equal(sharing, true);
  await controller.stop(3);
  assert.equal(sharing, true, 'delayed older stop cannot cancel a newer approved show');
} finally {
  await controller.stop();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
console.log('presentation protocol: authorize before replacement, stale commands and reordered responses fenced');
