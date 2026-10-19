/** Bounded, state-checked microphone control; never click a settings button or toggle twice. */
import type { BrowserContext, Page } from '@vexa/remote-browser';

export async function ensureMeetingMicUnmuted(page: Page, platform: string): Promise<boolean> {
  return page.evaluate(async ({ platform }) => {
    const doc = (globalThis as any).document;
    let clicked = false;
    const label = (button: any) => String(button.getAttribute('aria-label') || button.getAttribute('data-tooltip') || '').toLowerCase();
    const off = (value: string) => /turn on|unmute|mic is off|microphone is off/.test(value);
    const on = (value: string) => !off(value) && /turn off|mute microphone|mute my|mute audio/.test(value);
    const visible = (button: any) => button.getClientRects().length > 0;
    for (let attempt = 0; attempt < 16; attempt++) {
      const button = platform === 'teams' ? doc.querySelector('#microphone-button')
        : platform === 'zoom' ? doc.querySelector('.join-audio-container__btn')
        : (Array.from(doc.querySelectorAll('button,[role="button"]')) as any[]).find(button =>
            visible(button) && /microphone|mute audio/.test(label(button)) && (on(label(button)) || off(label(button))));
      if (button && visible(button)) {
        const current = label(button);
        if (on(current)) return true;
        if (!clicked && off(current) && !button.disabled) {
          button.click();
          clicked = true;
        }
      }
      if (attempt < 15) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }, { platform }).catch(() => false);
}

/** Install before navigation. Only captured tracks and their clones prove local origin. */
export async function installLocalMediaTracker(context: BrowserContext): Promise<void> {
  // String injection keeps document-start code independent of transpiler helpers.
  await context.addInitScript(`(() => {
    if (window.__vexaIsLocalMediaTrack) return;
    const devices = navigator.mediaDevices;
    const proto = window.MediaStreamTrack && window.MediaStreamTrack.prototype;
    const streamProto = window.MediaStream && window.MediaStream.prototype;
    if (!devices || !devices.getUserMedia || !proto || !proto.clone || !streamProto || !streamProto.clone) return;
    const capture = devices.getUserMedia;
    const clone = proto.clone;
    const cloneStream = streamProto.clone;
    const local = new WeakSet();
    const stats = { capturedTracks: 0, trackClones: 0, localTrackClones: 0, streamClones: 0, localStreamClones: 0 };
    const captureDescriptor = Object.getOwnPropertyDescriptor(devices, 'getUserMedia');
    const cloneDescriptor = Object.getOwnPropertyDescriptor(proto, 'clone');
    const streamDescriptor = Object.getOwnPropertyDescriptor(streamProto, 'clone');
    if (!cloneDescriptor || !streamDescriptor) return;
    try {
      Object.defineProperty(devices, 'getUserMedia', { configurable: true, writable: true,
        value: async function (...args) {
          const stream = await capture.apply(this, args);
          stream.getTracks().forEach(track => { local.add(track); stats.capturedTracks++; });
          return stream;
        } });
      Object.defineProperty(proto, 'clone', { ...cloneDescriptor, value: function (...args) {
        const result = clone.apply(this, args);
        stats.trackClones++;
        if (local.has(this)) { local.add(result); stats.localTrackClones++; }
        return result;
      } });
      Object.defineProperty(streamProto, 'clone', { ...streamDescriptor, value: function (...args) {
        const result = cloneStream.apply(this, args);
        const source = this.getTracks(); stats.streamClones++;
        // Native stream cloning bypasses the JS track.clone wrapper. Mixed streams
        // remain unmarked: source/result track ordering is not an identity proof.
        if (source.length && source.every(track => local.has(track))) { result.getTracks().forEach(track => local.add(track)); stats.localStreamClones++; }
        return result;
      } });
      window.__vexaIsLocalMediaTrack = track => local.has(track);
      window.__vexaLocalMediaStats = () => ({ ...stats });
    } catch {
      if (captureDescriptor) Object.defineProperty(devices, 'getUserMedia', captureDescriptor);
      else delete devices.getUserMedia;
      if (cloneDescriptor) Object.defineProperty(proto, 'clone', cloneDescriptor);
      if (streamDescriptor) Object.defineProperty(streamProto, 'clone', streamDescriptor);
    }
  })();`);
}

/** Open only the linked People panel, once; never click an invite/add-person action. */
export async function ensureMeetingPeoplePanel(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const w = globalThis as any, doc = w.document;
    const candidates = (Array.from(doc.querySelectorAll('button,[role="button"]')) as any[]).filter(button => {
      const label = ['aria-label', 'data-tooltip', 'title'].map(key => button.getAttribute(key) || '').join(' ');
      if (!button.getClientRects().length || !button.hasAttribute('data-panel-id') || !button.hasAttribute('aria-controls')
        || /chat|message|invite|add (?:people|participants)/i.test(label)) return false;
      const icons = Array.from(button.querySelectorAll('.google-symbols,.google-material-icons,.material-icons,.material-symbols-outlined,[data-google-symbols-override]')) as any[];
      const peopleIcon = icons.some(icon => /^(people|people_alt|group|groups|supervisor_account|\uE7EF|\uE7FB|\uF233)$/.test(String(icon.textContent || '').trim())
        || /^(people|people_alt|group|groups|supervisor_account)$/.test(String(icon.getAttribute('data-google-symbols-override') || '').trim()));
      return /\bpeople\b|\bparticipants\b|show everyone/i.test(label) || peopleIcon;
    });
    if (candidates.length !== 1) return false;
    const button = candidates[0], target = String(button.getAttribute('aria-controls') || '').trim();
    if (!target || /\s/.test(target)) return false;
    let clicked = false;
    for (let attempt = 0; attempt < 16; attempt++) {
      const panel = doc.getElementById(target);
      if (button.getAttribute('aria-expanded') === 'true' && panel?.getClientRects().length) {
        w.__vexaPeoplePanel = { target, panel: button.getAttribute('data-panel-id') };
        return true;
      }
      if (!clicked && button.getAttribute('aria-expanded') === 'false' && !button.disabled) { button.click(); clicked = true; }
      if (attempt < 15) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }).catch(() => false);
}
