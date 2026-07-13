import type { CallAI, CallParams, ChatMessage } from './types.js';

export interface ProxyClientOptions {
  /** Full URL of the Vercel proxy /api/ai endpoint. */
  proxyUrl: string;
  /** fetch implementation (globalThis.fetch in browsers, injected in Node). */
  fetchImpl?: typeof fetch;
  /** Abort after this many ms. Default 20s. */
  timeoutMs?: number;
}

/**
 * Build a CallAI that routes through the Vercel proxy. No API keys client-side.
 * Errors are thrown with stable codes (TIMEOUT, NETWORK, RATE_LIMIT, SERVER_ERROR,
 * HTTP_xxx) so the UI can map them to friendly messages.
 *
 * Shared by the Chrome service worker and the VSCode extension host — the only
 * difference is which `fetch` they inject.
 */
export function createProxyClient(opts: ProxyClientOptions): CallAI {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);

  return async function callAI(messages: ChatMessage[], params: CallParams = {}): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await doFetch(opts.proxyUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, extraParams: params }),
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') throw new Error('TIMEOUT');
      throw new Error('NETWORK');
    }
    clearTimeout(timer);

    if (response.status === 429) throw new Error('RATE_LIMIT');
    if (response.status >= 500) throw new Error('SERVER_ERROR');
    if (!response.ok) throw new Error(`HTTP_${response.status}`);

    const data = (await response.json()) as { content?: string; error?: string };
    if (data.error) throw new Error(data.error);
    return data.content ?? '';
  };
}
