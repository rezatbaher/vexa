/** Pull immutable approved images from the configured private backend; revoke on room changes. */
import type { Page } from '@vexa/remote-browser';
import type { Act } from './contracts.js';
import { beginPresenting } from './meeting-visuals.js';

type Show = Extract<Act, { action: 'presentation_show' }>;
export function createMeetingPresentation(page: Page, room: () => string | undefined, complete: () => boolean, expectedRoom: () => string) {
  let generation = 0;
  let lastSequence = 0;
  let active: Show | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;
  const base = process.env.MEETING_SPEECH_URL?.replace(/\/$/, '');
  const report = async (act: Show, event: string) => {
    if (!base) return;
    await fetch(`${base}/presentations/${encodeURIComponent(act.presentation_id)}/events`, {
      method: 'POST', headers: { Authorization: `Bearer ${act.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event }), signal: AbortSignal.timeout(3000),
    }).then(r => r.body?.cancel()).catch(() => {});
  };
  const stop = async (sequence?: number) => {
    if (sequence !== undefined) {
      if (sequence <= lastSequence) return;
      lastSequence = sequence;
    }
    generation++; abort?.abort(); clearTimeout(timer); timer = undefined;
    const previous = active; active = undefined;
    await page.evaluate(() => (globalThis as any).__vexaMeetingVisuals?.stop()).catch(() => {});
    if (previous) await report(previous, 'stopped');
  };
  const load = async (act: Show, signal?: AbortSignal) => {
    const response = await fetch(`${base}/presentations/${encodeURIComponent(act.presentation_id)}/pages/${act.page}`, {
      headers: { Authorization: `Bearer ${act.token}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000), redirect: 'error',
    });
    if (!response.ok || !/^image\/(?:jpeg|png)/.test(response.headers.get('content-type') || '')) throw new Error('Presentation revoked');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 8*1024*1024) throw new Error('Page too large');
    return bytes;
  };
  const show = async (act: Show) => {
    if (!base || !/^https?:\/\//.test(base) || act.sequence <= lastSequence || room() !== act.room_revision || !complete()) {
      await report(act, 'failed'); return;
    }
    let initial: Uint8Array;
    try { initial = await load(act); } catch { await report(act, 'failed'); return; }
    if (act.sequence <= lastSequence || room() !== act.room_revision || !complete()) return;
    lastSequence = act.sequence;
    const requested = generation + 1;
    await stop();
    if (generation !== requested || act.sequence !== lastSequence) return;
    active = act;
    const own = generation;
    const refresh = async (first = false): Promise<void> => {
      if (own !== generation) return;
      abort = new AbortController();
      try {
        if (room() !== act.room_revision || !complete()) throw new Error('Room changed');
        const bytes = first ? initial : await load(act, abort.signal);
        if (own !== generation || room() !== act.room_revision || !complete()) return;
        const data = `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
        const drawn = await page.evaluate(({ data, expectedRoom }) => (globalThis as any).__vexaMeetingVisuals?.show(data, expectedRoom), { data, expectedRoom: expectedRoom() });
        if (own !== generation || !drawn) return;
        if (first) {
          if (!await beginPresenting(page)) throw new Error('Presentation UI did not start');
          if (own !== generation) return;
          await report(act, 'sharing');
        }
        if (own === generation) timer = setTimeout(() => { void refresh(); }, 2000);
      } catch {
        if (own === generation) { await stop(); await report(act, 'failed'); }
      }
    };
    await refresh(true);
  };
  return { show, stop };
}
