import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installMeetingVisuals, beginPresenting } from './meeting-visuals.js';

let script: Function | undefined;
await installMeetingVisuals({ async addInitScript(fn: any) { script = fn; } } as any);
let snapshot: any = { ids: ['alice'], complete: true };
let guard = () => {};
let draws = 0, stopped = 0;
let resolveDecode: (() => void) | undefined;
let delayed = false;
const intervals: Function[] = [];
const tracks: any[] = [];
const document = {
  documentElement: {},
  createElement() {
    return { width: 0, height: 0, getContext() { return { fillRect() {}, fillText() {}, drawImage() { draws++; } }; },
      captureStream() { const track = { readyState: 'live', stop() { this.readyState = 'ended'; stopped++; } }; tracks.push(track);
        return { getTracks: () => [track], getVideoTracks: () => [track], addTrack() {} }; },
    };
  },
  querySelectorAll() { return [{ getClientRects: () => [1], getAttribute: () => 'Present now', textContent: 'Present now', click() {} }]; },
};
class Image {
  width = 1280; height = 720; src = '';
  async decode() { if (delayed) await new Promise<void>(resolve => { resolveDecode = resolve; }); }
}
const world: any = vm.createContext({ document, Image,
  navigator: { mediaDevices: { async getUserMedia() { return {}; } } },
  MutationObserver: class { constructor(fn: () => void) { guard = fn; } observe() {} },
  setInterval(fn: Function) { intervals.push(fn); },
  __vexaRoomSnapshot: () => snapshot,
  __name: (fn: Function) => fn,
});
vm.runInContext(`(${script!.toString()})()`, world);
const visual = world.__vexaMeetingVisuals;
const approved = JSON.stringify({ ids: ['alice'], complete: true });
assert.equal(await visual.show('data:image/jpeg;base64,eA==', approved), true);
assert.equal(draws, 1);
await world.navigator.mediaDevices.getDisplayMedia({ video: true });
assert.equal(visual.sharing(), true);
snapshot = { ids: ['alice', 'new-guest'], complete: true };
guard();
assert.equal(visual.sharing(), false);
assert.equal(stopped, 1);
assert.equal(await visual.show('data:image/jpeg;base64,eA==', approved), false);
assert.equal(draws, 1, 'stale Node audience cannot paint into the current browser');
await assert.rejects(world.navigator.mediaDevices.getDisplayMedia({ video: true }));
snapshot = { ids: ['alice'], complete: true };
delayed = true;
const pending = visual.show('data:image/jpeg;base64,eA==', approved);
snapshot = { ids: ['alice'], complete: false };
resolveDecode!();
assert.equal(await pending, false);
assert.equal(draws, 1, 'a room change during image decode never publishes the image');
// A locally live display track with no provider Stop presenting state is not sharing confirmation.
snapshot = { ids: ['alice'], complete: true }; delayed = false;
await visual.show('data:image/jpeg;base64,eA==', approved);
await world.navigator.mediaDevices.getDisplayMedia({ video: true });
const page = { async evaluate(fn: Function, arg?: any) {
  world.input = arg;
  return vm.runInContext(`(${fn.toString()})(input)`, world);
}, async waitForTimeout() {} };
assert.equal(await beginPresenting(page as any), false);
visual.stop();
console.log('browser visuals: exact-room first frame, decode race, immediate revocation and honest sharing confirmation passed');
