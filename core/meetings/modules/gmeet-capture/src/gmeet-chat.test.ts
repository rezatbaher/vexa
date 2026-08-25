/**
 * gmeet-capture L2 (chat) — the PURE extraction logic, no browser. Drives the real
 * createGmeetChat against an in-memory DOM shim and pins the rules that are NOT about
 * selectors: grouped-sender resolution, the heuristic fallback, virtualized-list dedup,
 * and the panel-open attempt. The selectors themselves are live-validated against a real
 * Meet call via getState() — Meet's DOM is obfuscated and WILL drift.
 * Run: npx tsx src/gmeet-chat.test.ts
 */
import { createGmeetChat } from './gmeet-chat.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

// ── Minimal DOM shim: tag, [attr], [attr*="v"], [attr^="v"], comma lists ──
class FakeEl {
  tag: string; attrs: Record<string, string> = {}; children: FakeEl[] = []; text = '';
  parentElement: FakeEl | null = null;
  constructor(tag: string, attrs: Record<string, string> = {}, text = '') {
    this.tag = tag; this.attrs = attrs; this.text = text;
  }
  get tagName() { return this.tag.toUpperCase(); }
  get childElementCount() { return this.children.length; }
  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join(' ') : this.text;
  }
  getAttribute(n: string) { return n in this.attrs ? this.attrs[n] : null; }
  add(...kids: FakeEl[]) { for (const k of kids) { k.parentElement = this; this.children.push(k); } return this; }
  descendants(): FakeEl[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  matches(sel: string): boolean {
    for (const part of sel.split(',').map((s) => s.trim())) {
      const m = part.match(/^\[([\w-]+)(?:([*^]?=)"([^"]*)")?\]$/);
      if (m) {
        const [, name, op, val] = m; const v = this.getAttribute(name);
        if (v == null) continue;
        if (!op || (op === '=' && v === val) || (op === '*=' && v.includes(val)) || (op === '^=' && v.startsWith(val))) return true;
        continue;
      }
      const tm = part.match(/^([a-z]+)?(\[[\w-]+\])?$/i);
      if (tm && tm[1] && this.tag === tm[1].toLowerCase() && !tm[2]) return true;
      if (part === '*') return true;
      const combo = part.match(/^([a-z]+)\[([\w-]+)(?:="([^"]*)")?\]$/i);
      if (combo) {
        const [, tag, name, val] = combo;
        if (this.tag === tag.toLowerCase()) { const v = this.getAttribute(name); if (v != null && (val === undefined || v === val)) return true; }
      }
    }
    return false;
  }
  querySelectorAll(sel: string): FakeEl[] { return this.descendants().filter((e) => e.matches(sel)); }
  querySelector(sel: string): FakeEl | null { return this.querySelectorAll(sel)[0] ?? null; }
}

const g = globalThis as any;
let root = new FakeEl('body');
const timers: Array<() => void> = [];
g.document = {
  querySelector: (s: string) => root.querySelector(s),
  querySelectorAll: (s: string) => root.querySelectorAll(s),
};
g.window = { setInterval: (cb: () => void) => { timers.push(cb); return timers.length; }, clearInterval: () => {} };
g.MutationObserver = class { observe() {} disconnect() {} };

const msg = (id: string, sender: string, text: string) =>
  new FakeEl('div', { 'data-message-id': id, 'data-sender-name': sender })
    .add(new FakeEl('div', { 'data-message-text': text }, text));

console.log('gmeet-chat:');

// 1. the durable-hook path
root = new FakeEl('body').add(
  new FakeEl('div', { 'aria-live': 'polite', role: 'log' }).add(msg('m1', 'Reza Baher', 'hello team')),
);
let got: Array<{ sender: string; text: string }> = [];
let chat = createGmeetChat({ onMessage: (m) => got.push(m) });
check('extracts sender + text from data-message-id / data-sender-name',
  got.length === 1 && got[0].sender === 'Reza Baher' && got[0].text === 'hello team', JSON.stringify(got));

// 2. dedup — a virtualized list re-renders the same item on scroll
const before = got.length;
timers.forEach((t) => t());
check('a re-scan does not re-emit the same message', got.length === before, `${before} -> ${got.length}`);
chat.destroy();

// 3. grouped sender: Meet prints one header for a run of messages
root = new FakeEl('body').add(
  new FakeEl('div', { 'aria-live': 'polite', role: 'log' }).add(
    new FakeEl('div', { 'data-sender-name': 'Alan Murphy' }).add(
      new FakeEl('div', { 'data-message-id': 'g1' }).add(new FakeEl('div', { 'data-message-text': 'first' }, 'first')),
      new FakeEl('div', { 'data-message-id': 'g2' }).add(new FakeEl('div', { 'data-message-text': 'second' }, 'second')),
    ),
  ),
);
got = [];
chat = createGmeetChat({ onMessage: (m) => got.push(m) });
check('a grouped run inherits the sender from the wrapper',
  got.length === 2 && got.every((m) => m.sender === 'Alan Murphy'), JSON.stringify(got));
chat.destroy();

// 4. heuristic fallback when the durable attrs are gone (the drift case)
root = new FakeEl('body').add(
  new FakeEl('div', { role: 'log' }).add(
    new FakeEl('div', { role: 'listitem' }).add(
      new FakeEl('span', {}, 'Sam Patel'),
      new FakeEl('span', {}, 'the longest fragment here is the message body'),
    ),
  ),
);
got = [];
chat = createGmeetChat({ onMessage: (m) => got.push(m) });
check('falls back to largest-leaf=body / short-sibling=sender',
  got.length === 1 && got[0].text.startsWith('the longest') && got[0].sender === 'Sam Patel', JSON.stringify(got));
chat.destroy();

// 5. it tries to OPEN the panel when nothing is mounted (Meet keeps chat in the DOM only while open)
let clicked = '';
const btn = new FakeEl('button', { 'aria-label': 'Chat with everyone' });
(btn as any).click = () => { clicked = 'chat'; };
root = new FakeEl('body').add(btn);
got = [];
chat = createGmeetChat({ onMessage: (m) => got.push(m) });
check('opens the chat panel when no container is present', clicked === 'chat', `clicked=${clicked}`);
check('getState reports the panel-open attempt', chat.getState().panelOpened === true);
chat.destroy();

// 6. autoOpenPanel:false is respected
clicked = '';
chat = createGmeetChat({ onMessage: () => {}, autoOpenPanel: false });
check('autoOpenPanel:false does not touch the DOM', clicked === '');
chat.destroy();

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
