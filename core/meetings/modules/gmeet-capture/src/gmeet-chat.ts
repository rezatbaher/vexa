/**
 * Google Meet chat reader — SHARED browser module, mirror of teams-chat.ts / zoom-chat.ts.
 * Watches the Meet chat panel and emits each new message as { sender, text }. The bot's
 * composition root publishes these as transcript.v1 `source:'chat'` segments, exactly as the
 * jitsi lane already does. Pure DOM observation — no audio, no network.
 *
 * ⚠️ Meet's chat lives in the DOM ONLY WHILE THE PANEL IS OPEN (same constraint as Teams/Zoom;
 * unlike Jitsi, there is no redux store to read behind the panel). So this module also OPENS the
 * panel — without that a bot that nobody clicked for captures nothing and looks broken.
 *
 * ⚠️ Meet's DOM is obfuscated and changes across builds. `data-message-id` / `data-sender-name`
 * are the durable hooks; everything else is a defensive cascade plus a heuristic fallback
 * (largest leaf text = body, short sibling = sender). `getState()` dumps the real structure so the
 * selectors can be tuned from a live call instead of guessed at again.
 */

export interface GmeetChatMessage { sender: string; text: string }

export interface GmeetChatOptions {
  log?: (m: string) => void;
  onMessage: (msg: GmeetChatMessage) => void;
  /** Re-attach / panel-open poll interval (ms). Default 2000. */
  pollMs?: number;
  /** Try to open the chat panel when it is not mounted. Default true. */
  autoOpenPanel?: boolean;
}

export interface GmeetChat {
  destroy(): void;
  getState(): {
    matchedContainer: string | null;
    panelOpened: boolean;
    seen: number;
    recent: GmeetChatMessage[];
    candidates: Array<{ sel: string; count: number }>;
    sample: { sel: string; structure: string[] } | null;
  };
}

// Candidate selectors, most-specific first.
export const CONTAINER_SELECTORS = [
  'div[aria-live="polite"][role="log"]',
  'div[aria-live="polite"]',
  '[role="log"]',
  '[aria-label*="Messages from"]',
  '[jsname="xySENc"]',
  '[class*="chat"] [role="list"]',
];
export const MESSAGE_SELECTORS = [
  'div[data-message-id]',
  'div[data-message-text]',
  '[role="listitem"]',
  'div[jsname="Ypafjf"]',
];
export const SENDER_SELECTORS = [
  '[data-sender-name]',
  '[class*="sender-name"]',
  '[class*="senderName"]',
  '[class*="display-name"]',
];
export const TEXT_SELECTORS = [
  '[data-message-text]',
  'div[jsname="dTKtvb"]',
  'div[dir="auto"]',
];
// Buttons that open the panel. Meet localizes these, so match generously.
const OPEN_CHAT_LABELS = /chat with everyone|open chat|^chat$|messages|in-call messages/i;

export function createGmeetChat(opts: GmeetChatOptions): GmeetChat {
  const log = opts.log || (() => {});
  const autoOpen = opts.autoOpenPanel !== false;
  const seenNodes = new WeakSet<Element>();
  const seenHashes = new Set<string>();
  const recent: GmeetChatMessage[] = [];
  let matchedContainer: string | null = null;
  let container: Element | null = null;
  let panelOpened = false;

  const firstText = (root: Element, selectors: string[]): string => {
    for (const s of selectors) {
      const el = root.querySelector(s);
      const t = el?.textContent?.trim();
      if (t) return t;
    }
    return '';
  };

  const senderFromAttr = (node: Element): string => {
    // Meet hangs data-sender-name on the message OR on the group wrapper above it.
    let cur: Element | null = node;
    for (let i = 0; i < 4 && cur; i++, cur = cur.parentElement) {
      const v = cur.getAttribute?.('data-sender-name');
      if (v && v.trim()) return v.trim();
    }
    return '';
  };

  const extract = (node: Element): GmeetChatMessage | null => {
    const attrText = node.getAttribute?.('data-message-text');
    let text = (attrText && attrText.trim()) || firstText(node, TEXT_SELECTORS);
    let sender = senderFromAttr(node) || firstText(node, SENDER_SELECTORS);

    // Sender is grouped: Meet prints one header for a run of messages from one person.
    if (!sender) {
      let cur: Element | null = node.parentElement;
      for (let i = 0; i < 4 && cur && !sender; i++, cur = cur.parentElement) {
        sender = firstText(cur, SENDER_SELECTORS);
      }
    }

    // Heuristic fallback: largest leaf text is the body, a short non-timestamp sibling the sender.
    if (!text) {
      const frags = Array.from(node.querySelectorAll('*'))
        .map((e) => (e.childElementCount === 0 ? (e.textContent || '').trim() : ''))
        .filter((t) => t.length > 0);
      if (!frags.length) return null;
      const longest = frags.reduce((a, b) => (b.length > a.length ? b : a), '');
      text = longest;
      if (!sender) {
        const shortName = frags.find(
          (f) => f !== longest && f.length <= 40 && !/^\d{1,2}:\d{2}/.test(f),
        );
        if (shortName) sender = shortName;
      }
    }
    // Meet renders "You" for the bot's own posts and appends a time to the header row.
    sender = sender.replace(/\s*\d{1,2}:\d{2}\s*(AM|PM)?\s*$/i, '').trim() || 'Unknown';
    if (!text) return null;
    return { sender, text };
  };

  const dumpNode = (node: Element): string[] =>
    Array.from(node.querySelectorAll('*')).slice(0, 25).map((e) => {
      const cls = (e.getAttribute('class') || '').slice(0, 40);
      const jsn = e.getAttribute('jsname');
      const aria = e.getAttribute('aria-label');
      const t = e.childElementCount === 0 ? (e.textContent || '').trim().slice(0, 30) : '';
      return `${e.tagName.toLowerCase()}${jsn ? '[jsname=' + jsn + ']' : ''}${cls ? '.' + cls : ''}${aria ? '[al=' + aria.slice(0, 30) + ']' : ''}${t ? ' »' + t : ''}`;
    });

  const emit = (node: Element) => {
    if (seenNodes.has(node)) return;
    seenNodes.add(node);
    const msg = extract(node);
    if (!msg) return;
    const hash = `${msg.sender} ${msg.text}`;
    if (seenHashes.has(hash)) return; // the list re-renders the same item on scroll
    seenHashes.add(hash);
    recent.push(msg);
    if (recent.length > 30) recent.shift();
    log(`chat ${msg.sender}: ${msg.text.slice(0, 60)}`);
    try { opts.onMessage(msg); } catch { /* never break capture */ }
  };

  const scanMessages = (root: ParentNode) => {
    for (const sel of MESSAGE_SELECTORS) {
      const nodes = root.querySelectorAll(sel);
      if (nodes.length) { nodes.forEach((n) => emit(n)); return; }
    }
  };

  const findContainer = (): Element | null => {
    for (const sel of CONTAINER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) { matchedContainer = sel; return el; }
    }
    return null;
  };

  const openPanel = () => {
    if (!autoOpen) return;
    const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
    for (const b of buttons) {
      const label = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`.trim();
      if (OPEN_CHAT_LABELS.test(label)) {
        try { (b as HTMLElement).click(); panelOpened = true; log('opened the chat panel'); } catch { /* best-effort */ }
        return;
      }
    }
  };

  const observer = new MutationObserver(() => { if (container) scanMessages(container); });
  const attach = () => {
    const found = findContainer();
    if (!found) { openPanel(); return; }
    if (found !== container) {
      container = found;
      observer.disconnect();
      observer.observe(container, { childList: true, subtree: true });
      scanMessages(container);
      log(`chat container matched: ${matchedContainer}`);
    } else {
      scanMessages(container);
    }
  };
  attach();
  const poll = window.setInterval(attach, opts.pollMs && opts.pollMs > 0 ? opts.pollMs : 2000);

  return {
    destroy() { window.clearInterval(poll); observer.disconnect(); },
    getState() {
      let sample: { sel: string; structure: string[] } | null = null;
      if (container) {
        for (const sel of MESSAGE_SELECTORS) {
          const n = container.querySelector(sel);
          if (n) { sample = { sel, structure: dumpNode(n) }; break; }
        }
      }
      return {
        matchedContainer,
        panelOpened,
        seen: seenHashes.size,
        recent: recent.slice(-10),
        candidates: CONTAINER_SELECTORS.map((sel) => ({ sel, count: document.querySelectorAll(sel).length })),
        sample,
      };
    },
  };
}
