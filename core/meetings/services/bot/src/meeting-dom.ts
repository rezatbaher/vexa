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
    if (!devices || !devices.getUserMedia || !proto || !proto.clone) return;
    const capture = devices.getUserMedia;
    const clone = proto.clone;
    const local = new WeakSet();
    const captureDescriptor = Object.getOwnPropertyDescriptor(devices, 'getUserMedia');
    const cloneDescriptor = Object.getOwnPropertyDescriptor(proto, 'clone');
    try {
      Object.defineProperty(devices, 'getUserMedia', { configurable: true, writable: true,
        value: async function (...args) {
          const stream = await capture.apply(this, args);
          stream.getTracks().forEach(track => local.add(track));
          return stream;
        } });
      Object.defineProperty(proto, 'clone', { ...cloneDescriptor, value: function (...args) {
        const result = clone.apply(this, args);
        if (local.has(this)) local.add(result);
        return result;
      } });
      window.__vexaIsLocalMediaTrack = track => local.has(track);
    } catch {
      if (captureDescriptor) Object.defineProperty(devices, 'getUserMedia', captureDescriptor);
      else delete devices.getUserMedia;
      if (cloneDescriptor) Object.defineProperty(proto, 'clone', cloneDescriptor);
    }
  })();`);
}
