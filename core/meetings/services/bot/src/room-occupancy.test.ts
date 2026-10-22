import assert from 'node:assert/strict';
import { readGoogleRoomOccupancy } from './join-driver.js';

async function read(tiles: any[], snapshot: any, bodyText?: string) {
  const page: any = { evaluate: async (fn: any) => {
    const g = globalThis as any;
    g.__vexaGmeetSpeakers = { getState: () => ({ tiles }) };
    g.__vexaRoomSnapshot = () => snapshot;
    if (bodyText !== undefined) g.document = { body: { innerText: bodyText } };
    try { return fn(); } finally { delete g.__vexaGmeetSpeakers; delete g.__vexaRoomSnapshot; delete g.document; }
  } };
  return readGoogleRoomOccupancy(page);
}
(async () => {
  assert.equal(await read([{id:'human',self:false}], {ids:['human'],complete:true}), 'unknown');
  assert.equal(await read([{id:'self',self:true}], {ids:[],complete:true}), 'alone');
  assert.equal(await read([{id:'self',self:true}], {ids:[],complete:false}), 'unknown');
  assert.equal(await read([{id:'a',self:false},{id:'b',self:false}], {ids:['a','b'],complete:false}), 'occupied');
  assert.equal(await read([], {ids:[],complete:true}), 'unknown');
  assert.equal(await read([{id:'a',self:true},{id:'a',self:false}], {ids:[],complete:true}), 'unknown');
  // The post-call screen: no tiles and Meet's own ended wording is an empty room (2026-09-01).
  assert.equal(await read([], {ids:[],complete:false}, 'You left the meeting\nReturn to home screen'), 'alone');
  assert.equal(await read([], {ids:[],complete:false}, 'Meeting ended'), 'alone');
  // A tile-less read with no such wording is still no evidence; a waiting room is never "ended".
  assert.equal(await read([], {ids:[],complete:false}, 'Loading'), 'unknown');
  assert.equal(await read([], {ids:[],complete:false}, 'Asking to be let in\nReturn to home screen'), 'unknown');
  // Ended wording with a human tile present (e.g. in chat) does not empty the room.
  assert.equal(await read([{id:'a',self:false},{id:'b',self:true}], {ids:['a'],complete:true}, 'Meeting ended'), 'occupied');
  console.log('room occupancy: 11 lifecycle regression scenarios passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
