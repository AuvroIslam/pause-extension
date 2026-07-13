import { canonicalHostname } from '@pause/core';

// Per-site signatures for "you've hit the usage/rate limit" states.
// These are inherently fragile (providers change copy/DOM often) so they live in
// one easily-updatable map, mirroring the MODEL_PROFILES / INPUT_SELECTORS pattern.
//
// A signature matches if ANY of its text patterns appears in visible page text,
// optionally scoped to `selectors` if provided (cheaper + fewer false positives).

interface LimitSignature {
  selectors?: string[];
  patterns: RegExp[];
}

const GENERIC_PATTERNS: RegExp[] = [
  /you'?ve reached (your|the) .{0,30}(limit|cap)/i,
  /message (limit|cap) reached/i,
  /you'?ve hit (your|the) .{0,20}limit/i,
  /reached the current usage cap/i,
  /upgrade to (continue|keep going|get more)/i,
  /you'?ve reached the free plan limit/i,
  /rate limit(ed)?/i,
];

const LIMIT_SIGNATURES: Record<string, LimitSignature> = {
  'chatgpt.com': {
    patterns: [
      /you'?ve reached the current usage cap/i,
      /you'?ve hit the free plan limit/i,
      /message limit/i,
      /come back (later|after)/i,
      ...GENERIC_PATTERNS,
    ],
  },
  'chat.openai.com': { patterns: GENERIC_PATTERNS },
  'claude.ai': {
    patterns: [
      /you'?ve reached your limit/i,
      /message limit reached/i,
      /you are out of free messages/i,
      /your limit will reset/i,
      /reached the maximum length for this conversation/i,
      ...GENERIC_PATTERNS,
    ],
  },
  'gemini.google.com': { patterns: GENERIC_PATTERNS },
  'grok.com': {
    patterns: [/you'?ve reached your .{0,20}limit/i, /out of .{0,10}(messages|requests)/i, ...GENERIC_PATTERNS],
  },
  'perplexity.ai': { patterns: GENERIC_PATTERNS },
  'chat.deepseek.com': { patterns: GENERIC_PATTERNS },
  'chat.mistral.ai': { patterns: GENERIC_PATTERNS },
  'copilot.microsoft.com': { patterns: GENERIC_PATTERNS },
  'poe.com': {
    patterns: [/you'?ve reached the (daily )?limit/i, /message limit/i, /out of (free )?messages/i, ...GENERIC_PATTERNS],
  },
};

function signatureFor(hostname: string): LimitSignature | null {
  return LIMIT_SIGNATURES[canonicalHostname(hostname)] ?? null;
}

// Message containers across the supported sites (mirrors transcript.ts's readers) plus
// generic fallbacks. A limit banner is page CHROME, never conversation content — so these
// subtrees are excluded from the scan. Without this, a chat that merely *discusses* rate
// limiting ("help me build a rate limiter", or an assistant explaining a 429) matches
// GENERIC_PATTERNS and fires a false handoff.
const CONVERSATION_SELECTORS = [
  '[data-message-author-role]',
  '[data-testid="user-message"]',
  '[data-testid="assistant-message"]',
  '.font-claude-message',
  'user-query',
  'model-response',
  'article',
  '[class*="message"]',
  '[class*="turn"]',
].join(',');

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

/** Visible text with conversation turns removed. Skips whole subtrees, so it stays cheap. */
function textOutsideConversation(maxChars: number): string {
  const parts: string[] = [];
  const walk = (node: Element): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.nodeValue;
        if (t && t.trim()) parts.push(t);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (el.matches(CONVERSATION_SELECTORS)) continue; // the whole turn is skipped
      if (el.getAttribute('aria-hidden') === 'true') continue;
      walk(el);
    }
  };
  if (document.body) walk(document.body);
  const text = parts.join(' ');
  // Banners sit near the composer at the bottom, so the tail is the useful part.
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

/** Cheap check: does the current DOM show this site's limit state right now? */
export function isLimitVisible(hostname: string): boolean {
  const sig = signatureFor(hostname);
  if (!sig) return false;

  const scopeText = (): string => {
    if (sig.selectors) {
      let txt = '';
      for (const sel of sig.selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          txt += ' ' + (el as HTMLElement).innerText;
        });
      }
      return txt;
    }
    return textOutsideConversation(4000);
  };

  const text = scopeText();
  return sig.patterns.some((re) => re.test(text));
}

/**
 * Watch for the limit state. Fires `onDetected` once when a limit banner appears
 * and stays visible for `confirmMs` (debounced to avoid transient false positives).
 * Returns a disposer. Re-arms after the banner disappears.
 */
export function watchForLimit(
  hostname: string,
  onDetected: () => void,
  opts: { confirmMs?: number } = {},
): () => void {
  if (!signatureFor(hostname)) return () => {};
  const confirmMs = opts.confirmMs ?? 1000;

  let armed = true; // becomes false after firing, re-arms when banner clears
  let pending: ReturnType<typeof setTimeout> | null = null;

  const evaluate = () => {
    const visible = isLimitVisible(hostname);
    if (visible && armed && !pending) {
      pending = setTimeout(() => {
        pending = null;
        if (isLimitVisible(hostname) && armed) {
          armed = false;
          onDetected();
        }
      }, confirmMs);
    } else if (!visible) {
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
      armed = true; // banner cleared — ready to fire again next time
    }
  };

  const obs = new MutationObserver(() => {
    // Coalesce bursts (streaming responses mutate heavily).
    if (!pending) evaluate();
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  const interval = setInterval(evaluate, 1500);
  evaluate();

  return () => {
    obs.disconnect();
    clearInterval(interval);
    if (pending) clearTimeout(pending);
  };
}
