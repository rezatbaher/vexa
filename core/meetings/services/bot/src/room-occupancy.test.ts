import assert from 'node:assert/strict';
import { readGoogleRoomOccupancy } from './join-driver.js';

async function read(tiles: any[], snapshot: any) {
  const page: any = { evaluate: async (fn: any) => {
    const g = globalThis as any;
    g.__vexaGmeetSpeakers = { getState: () => ({ tiles }) };
    g.__vexaRoomSnapshot = () => snapshot;
    try { return fn(); } finally { delete g.__vexaGmeetSpeakers; delete g.__vexaRoomSnapshot; }
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
  console.log('room occupancy: 6 lifecycle regression scenarios passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
