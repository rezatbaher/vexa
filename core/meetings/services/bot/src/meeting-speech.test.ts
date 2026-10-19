import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { createMeetingSpeech } from './meeting-speech.js';

const id = 'a091ee10-8b13-4269-a8c5-eaa80e9a0b53';
const token = 'fake.header.signature';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function scenario(mode: 'delayed' | 'running' | 'completed') {
  let gets = 0, players = 0, killed = 0;
  const mute: boolean[] = [], events: string[] = [];
  const request = deferred<http.ServerResponse>();
  const playback = deferred<void>();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      gets++; request.resolve(res);
      if (mode !== 'delayed') {
        res.writeHead(200, { 'X-PCM-Rate': '24000' }); res.write(Buffer.alloc(200));
        if (mode === 'completed') res.end(Buffer.alloc(200));
      }
    } else {
      let body = ''; for await (const chunk of req) body += chunk;
      events.push(JSON.parse(body).event); res.end('{}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  process.env.MEETING_SPEECH_URL = `http://127.0.0.1:${port}`;
  const adapter = createMeetingSpeech(value => mute.push(value), () => {
    players++;
    const player = new EventEmitter() as ChildProcess;
    const input = new Writable({ write(_data, _encoding, callback) { callback(); } });
    Object.defineProperty(player, 'stdin', { value: input });
    player.kill = () => { killed++; queueMicrotask(() => player.emit('exit', null)); return true; };
    input.once('finish', () => queueMicrotask(() => player.emit('exit', 0)));
    playback.resolve();
    return player;
  });
  try {
    const speaking = adapter.speak(id, token);
    const response = await request.promise;
    if (mode === 'delayed') {
      adapter.stop(); response.writeHead(200, { 'X-PCM-Rate': '24000' }); response.end(Buffer.alloc(100));
    } else if (mode === 'running') {
      await playback.promise; adapter.stop(); response.end(Buffer.alloc(100));
    }
    await speaking;
    await adapter.speak(id, token);  // Redelivered commands must not fetch or play twice.
    assert.equal(gets, 1);
    assert.equal(mute.at(-1), true);
    if (mode === 'delayed') { assert.equal(players, 0); assert(!mute.includes(false)); assert(events.includes('interrupted')); }
    if (mode === 'running') { assert.equal(players, 1); assert(killed >= 1); assert(events.includes('interrupted')); }
    if (mode === 'completed') { assert.equal(players, 1); assert(events.includes('completed')); assert(!events.includes('failed')); }
  } finally { adapter.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
for (const mode of ['delayed', 'running', 'completed'] as const) { await scenario(mode); console.log(`PASS meeting speech: ${mode}`); }
