/** Audience-bound PCM pull. The URL is infrastructure-owned; acts carry no arbitrary URL.
 * stop aborts request, response and playback, so a late HTTP response cannot reopen the mic.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https from 'node:https';

export interface MeetingSpeech {
  speak(id: string, token: string, permitted?: () => Promise<boolean>): Promise<void>;
  stop(): void;
}

export async function failMeetingSpeech(id: string, token: string): Promise<void> {
  const base = process.env.MEETING_SPEECH_URL?.trim();
  if (!base) return;
  await fetch(`${base.replace(/\/$/, '')}/speech/${encodeURIComponent(id)}/events`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'failed' }), signal: AbortSignal.timeout(3000),
  }).then(response => response.body?.cancel()).catch(() => {});
}

export function createMeetingSpeech(mute: (value: boolean) => void,
  play: () => ChildProcess = () => spawn('paplay', ['--raw', '--format=s16le', '--rate=24000', '--channels=1', '--device=tts_sink'], { stdio: ['pipe', 'ignore', 'ignore'] }),
): MeetingSpeech {
  let generation = 0;
  let request: ClientRequest | undefined;
  let response: IncomingMessage | undefined;
  let process: ChildProcess | undefined;
  let cancel: (() => void) | undefined;
  const seen = new Set<string>();
  const stop = (): void => {
    generation++;
    cancel?.(); cancel = undefined;
    request?.destroy(); request = undefined;
    response?.destroy(); response = undefined;
    process?.stdin?.destroy(); process?.kill('SIGKILL'); process = undefined;
    mute(true);
  };
  const speak = async (id: string, token: string, permitted?: () => Promise<boolean>): Promise<void> => {
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 5000) throw new Error('Meeting speech limit');
    stop();
    const own = generation;
    const base = globalThis.process.env.MEETING_SPEECH_URL?.trim();
    if (!base) return;
    const url = new URL(`${base.replace(/\/$/, '')}/speech/${encodeURIComponent(id)}`);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    const transport = url.protocol === 'https:' ? https : http;
    const headers = { Authorization: `Bearer ${token}` };
    const report = async (event: string): Promise<void> => {
      await new Promise<void>((resolve) => {
        const callback = transport.request(new URL(url.href + '/events'), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' } }, r => { r.resume(); r.on('end', resolve); });
        callback.on('error', () => resolve());
        callback.setTimeout(3000, () => { callback.destroy(); resolve(); });
        callback.end(JSON.stringify({ event }));
      });
    };
    await new Promise<void>((resolve) => {
      let finished = false;
      let complete = false;
      let started = false;
      const finish = (event: string): void => {
        if (finished) return;
        finished = true;
        if (own === generation) {
          cancel = undefined;
          request?.destroy(); request = undefined;
          response?.destroy(); response = undefined;
          process?.stdin?.destroy(); process?.kill('SIGKILL'); process = undefined;
          mute(true);
        }
        void report(event).finally(resolve);
      };
      cancel = () => finish('interrupted');
      request = transport.request(url, { method: 'GET', headers }, async res => {
        if (own !== generation || finished) { res.destroy(); return; }
        response = res;
        if (res.statusCode !== 200 || res.headers['x-pcm-rate'] !== '24000') { res.resume(); finish('failed'); return; }
        res.pause();
        let allowed = false;
        try { allowed = !permitted || await permitted(); } catch { /* fail closed */ }
        if (!allowed || own !== generation || finished) { res.destroy(); finish('interrupted'); return; }
        res.once('end', () => { complete = true; });
        res.on('aborted', () => finish('failed'));
        res.on('error', () => finish('failed'));
        const player = play();
        process = player;
        player.on('error', () => finish('failed'));
        player.stdin?.on('error', () => finish('failed'));
        player.on('exit', code => finish(code === 0 && complete && started ? 'completed' : 'failed'));
        res.once('data', () => {
          if (own !== generation || finished) return;
          started = true; mute(false); void report('started');
        });
        res.pipe(player.stdin!);
        res.resume();
      });
      request.on('error', () => finish('failed'));
      request.setTimeout(45000, () => finish('failed'));
      request.end();
    });
  };
  return { speak, stop };
}
