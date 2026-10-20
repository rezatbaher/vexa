/** Real Node WebSocket transport against a local WhisperLive protocol fixture. */
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { createStreamingGmeet } from './streaming-gmeet.js';
import type { TranscriptSegment } from './contracts.js';

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise<void>(resolve => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;
let binaryPcm = 0, binaryEos = false, textEos = false;
const output: TranscriptSegment[] = [], faults: unknown[] = [];
server.on('connection', socket => {
  let uid = '';
  socket.on('message', (raw, binary) => {
    if (raw.toString() === 'END_OF_AUDIO') { binaryEos = binary; textEos = !binary; return; }
    if (!uid) {
      assert(!binary); const hello = JSON.parse(raw.toString()); uid = hello.uid;
      assert.equal(hello.audio_format, 'float32'); assert.equal(hello.model, 'large-v3-turbo');
      assert.equal(hello.same_output_threshold, 8);
      socket.send(JSON.stringify({ uid, message: 'SERVER_READY' }));
    } else if (binary) {
      if (binaryPcm === 0) {
        assert.equal(raw.byteLength, 16000 * 4);
        assert(Math.abs((raw as Buffer).readFloatLE(0) - .1) < .0001);
      }
      binaryPcm++;
      const message = JSON.stringify({ uid, language: 'en', segments: [{ start: 0, end: 1,
        text: 'Vox AI, summarize the meeting.', completed: false }] });
      socket.send(message); socket.send(message);
    }
  });
});
const pipe = createStreamingGmeet({ publish: async s => { output.push(s); } }, {
  url: `ws://127.0.0.1:${port}`, onError: e => faults.push(e),
});
try {
  pipe.feedAudio(0, 'Test speaker', new Float32Array(16000).fill(.1), Date.now());
  const deadline = Date.now() + 3000;
  while ((!output.some(s => s.completed) || (!binaryEos && !textEos)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(output.filter(s => s.completed).length, 1);
  assert.equal(faults.length, 0);
  assert(binaryPcm > 0, 'Actual Float32 PCM must use binary frames');
  assert(binaryEos && !textEos, 'WhisperLive requires a binary END_OF_AUDIO marker');
  console.log('PASS actual WebSocket protocol: JSON handshake, binary Float32 PCM, streamed drafts, one early final, binary EOS');
} finally {
  await pipe.stop();
  for (const client of server.clients) client.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
