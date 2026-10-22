import { strict as assert } from 'assert';
import { JSDOM } from 'jsdom';
import { countRealParticipantTilesStrict } from './admission';

async function count(html: string): Promise<number | null> {
  const dom = new JSDOM(html);
  const page: any = { locator: (selector: string) => ({ evaluateAll: async (fn: any) => fn([...dom.window.document.querySelectorAll(selector)]) }) };
  try { return await countRealParticipantTilesStrict(page); } finally { dom.window.close(); }
}
(async () => {
  assert.equal(await count('<div data-participant-id="self" data-tile-media-id="a"><button>Backgrounds and effects</button></div><div data-participant-id="human">Human</div>'), 2);
  assert.equal(await count('<div data-participant-id="preview" aria-label="Backgrounds and effects"></div>'), 0);
  assert.equal(await count('<div data-participant-id="a" data-tile-media-id="a"></div><div data-participant-id="a" data-tile-media-id="a"></div>'), 1);
  assert.equal(await count('<div data-participant-id="preview"><button><span>visual_effects</span>Backgrounds and effects</button></div>'), 0);
  assert.equal(await count('<div data-participant-id="self" data-tile-media-id="a" aria-label="Backgrounds and effects"></div>'), 1);
  console.log('participant structure: 5 regression scenarios passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
