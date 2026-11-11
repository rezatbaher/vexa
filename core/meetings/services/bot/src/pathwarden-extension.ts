/** The in-process composition seam for Pathwarden commands and room observations. */
import type { Page } from '@vexa/remote-browser';
import type { Act } from './contracts.js';
import type { SpeakController } from './capture-bridge.js';
import type { createMeetingControl } from './meeting-control.js';
import { createMeetingPresentation } from './meeting-presentation.js';

export function createPathwardenExtension(opts: {
  enabled: boolean;
  page: Page;
  speak: SpeakController;
  controls: ReturnType<typeof createMeetingControl>;
  publish(frame: Record<string, unknown>): Promise<unknown>;
  now?: () => number;
}) {
  const { page, speak, controls } = opts;
  const now = opts.now ?? Date.now;
  let disposed = false;
  let completeRoom = false;
  let expectedRoom = '';
  let presenceAt = 0;
  const presentation = createMeetingPresentation(page, () => speak.roomRevision(), () => completeRoom, () => expectedRoom);
  const handlers = new Map<Act['action'], (act: Act) => Promise<void>>();
  if (opts.enabled) {
    handlers.set('meeting_control', act => controls.handle(act));
    handlers.set('speak', async act => { if (act.action === 'speak') await speak.speak(act.text, act.voice); });
    handlers.set('speak_stream', async act => { if (act.action === 'speak_stream') await speak.stream(act.speech_id, act.stream_token); });
    handlers.set('chat_stream', async act => { if (act.action === 'chat_stream') await speak.chatStream(act.speech_id, act.stream_token); });
    handlers.set('speak_stop', () => speak.stop());
    handlers.set('chat_send', async act => { if (act.action === 'chat_send') await speak.sendChat(act.text); });
    const avatar = async (act: Act): Promise<void> => {
      if (act.action !== 'avatar_reset' && !(act.action === 'avatar_set' && act.url === 'voxai:default')) return;
      await page.evaluate(enabled => {
        const w = globalThis as any;
        w.__vexaMeetingVisuals?.avatar(enabled);
        const buttons = Array.from<any>(w.document.querySelectorAll('button,[role="button"]'));
        buttons.find(node => node.getClientRects().length && (enabled ? /turn on camera/i : /turn off camera/i)
          .test(node.getAttribute('aria-label') || ''))?.click();
      }, act.action === 'avatar_set');
    };
    handlers.set('avatar_set', avatar);
    handlers.set('avatar_reset', avatar);
    handlers.set('presentation_show', async act => { if (act.action === 'presentation_show') await presentation.show(act); });
    handlers.set('presentation_stop', async act => { if (act.action === 'presentation_stop') await presentation.stop(act.sequence); });
    handlers.set('screen_stop', () => presentation.stop());
    handlers.set('leave', () => presentation.stop());
  }
  return {
    commandActions: () => [...handlers.keys()],
    async handle(act: Act): Promise<void> {
      if (disposed) return;
      if (controls.muted() && ['speak', 'speak_stream', 'speak_audio'].includes(act.action)) return;
      await handlers.get(act.action)?.(act);
    },
    presence(ids: string[], names: Record<string, string>, complete: boolean): void {
      if (!opts.enabled || disposed) return;
      const changed = speak.presence(ids, complete);
      completeRoom = complete;
      expectedRoom = JSON.stringify({ ids: [...new Set(ids)].sort(), complete });
      if (changed || !complete) void presentation.stop();
      if (!changed && now() - presenceAt < 2000) return;
      presenceAt = now();
      void opts.publish({ type: 'meeting.presence.v1', ids, names, complete,
        revision: speak.roomRevision(), observed_at: new Date(now()).toISOString() }).catch(() => {});
    },
    async dispose(): Promise<void> {
      disposed = true;
      if (!opts.enabled) return;
      await presentation.stop();
      await speak.stop();
    },
  };
}
