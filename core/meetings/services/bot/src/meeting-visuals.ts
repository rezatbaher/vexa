/** Browser-native canvas tracks for an approved immutable page and an optional static avatar. */
import type { BrowserContext, Page } from '@vexa/remote-browser';

export async function installMeetingVisuals(context: Pick<BrowserContext, 'addInitScript'>): Promise<void> {
  await context.addInitScript(() => {
    const w = globalThis as any;
    const navigator = w.navigator, document = w.document;
    if (!navigator.mediaDevices || w.__vexaMeetingVisuals) return;
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d')!;
    const avatar = document.createElement('canvas'); avatar.width = 640; avatar.height = 360;
    const ac = avatar.getContext('2d')!;
    const paintAvatar = () => {
      ac.fillStyle = '#142c3b'; ac.fillRect(0, 0, 640, 360);
      ac.fillStyle = '#86ded1'; ac.font = 'bold 74px sans-serif'; ac.textAlign = 'center'; ac.fillText('VOXAI', 320, 166);
      ac.fillStyle = '#ffffff'; ac.font = '24px sans-serif'; ac.fillText('Meeting assistant', 320, 222);
    };
    paintAvatar();
    let avatarEnabled = false;
    let stream: any;
    let image: any;
    let generation = 0;
    let approvedRoom = '';
    const permitted = () => {
      const snapshot = w.__vexaRoomSnapshot?.();
      return !!snapshot?.complete && approvedRoom === JSON.stringify({ ids: [...new Set(snapshot.ids)].sort(), complete: snapshot.complete });
    };
    const blank = () => { image = undefined; ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, 1280, 720); };
    blank();
    navigator.mediaDevices.getDisplayMedia = async (constraints: any) => {
      if (!image || !permitted()) {
        throw new Error('No approved presentation');
      }
      stream = canvas.captureStream(1);
      return stream;
    };
    const originalUser = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints: any) => {
      if (!avatarEnabled || !constraints?.video) return originalUser(constraints);
      const result = avatar.captureStream(1);
      if (constraints.audio) {
        const audio = await originalUser({ audio: constraints.audio, video: false });
        audio.getAudioTracks().forEach((track: any) => result.addTrack(track));
      }
      return result;
    };
    const guard = () => {
      if (image && !permitted()) {
        generation++; blank(); stream?.getTracks().forEach((track: any) => track.stop()); stream = undefined;
      }
    };
    new w.MutationObserver(guard).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    setInterval(() => {
      guard();
      if (image) {
        ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, 1280, 720);
        const scale = Math.min(1280 / image.width, 720 / image.height);
        ctx.drawImage(image, (1280-image.width*scale)/2, (720-image.height*scale)/2, image.width*scale, image.height*scale);
      }
      if (avatarEnabled) paintAvatar();
    }, 1000);
    w.__vexaMeetingVisuals = {
      async show(data: string, expectedRoom: string) {
        approvedRoom = expectedRoom;
        if (!permitted()) return false;
        const own = ++generation;
        // Only a Node-fetched, audience-authorized image crosses into the meeting origin.
        if (!/^data:image\/(?:jpeg|png);base64,/.test(data)) throw new Error('Invalid rendered page');
        const next = new w.Image(); next.src = data;
        await next.decode();
        if (own !== generation || !permitted()) return false;
        image = next;
        ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, 1280, 720);
        const scale = Math.min(1280 / next.width, 720 / next.height);
        ctx.drawImage(next, (1280-next.width*scale)/2, (720-next.height*scale)/2, next.width*scale, next.height*scale);
        return true;
      },
      stop() { generation++; blank(); stream?.getTracks().forEach((track: any) => track.stop()); stream = undefined; },
      sharing() { return !!stream?.getVideoTracks().some((track: any) => track.readyState === 'live'); },
      avatar(value: boolean) { avatarEnabled = value; },
    };
  });
}

export async function beginPresenting(page: Page): Promise<boolean> {
  const confirmed = () => page.evaluate(() => {
    const w = globalThis as any;
    const buttons = Array.from<any>(w.document.querySelectorAll('button,[role="button"]'));
    return !!w.__vexaMeetingVisuals?.sharing() && buttons.some(node => node.getClientRects().length &&
      /stop presenting/i.test(node.getAttribute('aria-label') || node.textContent || ''));
  });
  if (await confirmed()) return true;
  const clicked = await page.evaluate(() => {
    const document = (globalThis as any).document;
    const controls = Array.from<any>(document.querySelectorAll('button,[role="button"]'));
    const button = controls.find(node => node.getClientRects().length && /present now/i.test(node.getAttribute('aria-label') || node.textContent || ''));
    button?.click(); return !!button;
  });
  if (!clicked) return false;
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const document = (globalThis as any).document;
    const item = Array.from<any>(document.querySelectorAll('[role="menuitem"],button,[role="button"]'))
      .find(node => node.getClientRects().length && /^(?:a tab|your entire screen|entire screen)$/i.test((node.textContent || '').trim()));
    item?.click();
  });
  for (let i = 0; i < 15; i++) {
    if (await confirmed()) return true;
    await page.waitForTimeout(200);
  }
  return false;
}
