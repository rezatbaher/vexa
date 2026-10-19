/** Single-use, audience-bound text pull. DOM submission is reported separately from speech. */
export async function deliverMeetingChat(
  id: string, token: string, valid: () => boolean, send: (text: string) => Promise<boolean>,
): Promise<void> {
  const base = process.env.MEETING_SPEECH_URL?.trim();
  if (!base) return;
  const url = `${base.replace(/\/$/, '')}/speech/${encodeURIComponent(id)}`;
  const controller = new AbortController();
  const timer = setInterval(() => { if (!valid()) controller.abort(); }, 100);
  const deadline = setTimeout(() => controller.abort(), 8000);
  let event = 'failed';
  try {
    const response = await fetch(url + '/text', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    if (!response.ok || !valid()) { event = valid() ? 'failed' : 'interrupted'; return; }
    const payload = await response.json() as { text?: unknown };
    if (typeof payload.text !== 'string' || payload.text.length > 8000 || !valid()) return;
    event = await send(payload.text) ? 'chat_submitted' : 'interrupted';
  } catch { event = valid() ? 'failed' : 'interrupted'; }
  finally {
    clearInterval(timer); clearTimeout(deadline);
    await fetch(url + '/events', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event }), signal: AbortSignal.timeout(3000),
    }).then(response => response.body?.cancel()).catch(() => {});
  }
}
