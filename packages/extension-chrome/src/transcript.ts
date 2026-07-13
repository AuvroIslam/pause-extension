import { canonicalHostname, type TranscriptTurn } from '@pause/core';

// Reads the visible conversation out of the page DOM so it can be handed off to
// another AI. Per-site selectors with a generic fallback. Fragile by nature —
// kept isolated here so updates are localized.

interface SiteReader {
  turns: () => TranscriptTurn[];
}

function textOf(el: Element): string {
  return ((el as HTMLElement).innerText || el.textContent || '').trim();
}

const READERS: Record<string, SiteReader> = {
  'chatgpt.com': {
    turns() {
      const out: TranscriptTurn[] = [];
      document.querySelectorAll('[data-message-author-role]').forEach((el) => {
        const role = el.getAttribute('data-message-author-role');
        const text = textOf(el);
        if (text) out.push({ role: role === 'user' ? 'user' : 'assistant', text });
      });
      return out;
    },
  },
  'claude.ai': {
    turns() {
      const out: TranscriptTurn[] = [];
      document
        .querySelectorAll('[data-testid="user-message"], .font-claude-message, [data-testid="assistant-message"]')
        .forEach((el) => {
          const isUser = el.matches('[data-testid="user-message"]');
          const text = textOf(el);
          if (text) out.push({ role: isUser ? 'user' : 'assistant', text });
        });
      return out;
    },
  },
  'gemini.google.com': {
    turns() {
      const out: TranscriptTurn[] = [];
      document.querySelectorAll('user-query, .user-query-container').forEach((el) => {
        const text = textOf(el);
        if (text) out.push({ role: 'user', text });
      });
      document.querySelectorAll('model-response, message-content.model-response-text').forEach((el) => {
        const text = textOf(el);
        if (text) out.push({ role: 'assistant', text });
      });
      // Gemini's DOM order may not interleave; sort is not reliable, so we return
      // as-is (users + responses grouped). The handoff summarizer tolerates this.
      return out;
    },
  },
};

/**
 * Generic fallback: grab reasonably-sized text blocks that look like chat turns.
 * Alternating role guess is imperfect but the handoff summarizer is robust to it.
 */
function genericTurns(): TranscriptTurn[] {
  const candidates = Array.from(
    document.querySelectorAll('article, [class*="message"], [class*="turn"], [role="listitem"]'),
  )
    .map((el) => textOf(el))
    .filter((t) => t.length > 2 && t.length < 20000);

  // Deduplicate nested matches (parent + child both matched).
  const seen = new Set<string>();
  const unique = candidates.filter((t) => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });

  return unique.map((text, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text }));
}

/** Read the current conversation for a hostname. Falls back to a generic reader. */
export function readTranscript(hostname: string): TranscriptTurn[] {
  const reader = READERS[canonicalHostname(hostname)];
  const turns = reader ? reader.turns() : genericTurns();
  return turns.length > 0 ? turns : genericTurns();
}
