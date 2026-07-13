import * as vscode from 'vscode';
import { createProxyClient, type CallAI, type Verbosity } from '@pause/core';

export function getConfig(): { verbosity: Verbosity; proxyUrl: string; targetModel: string } {
  const cfg = vscode.workspace.getConfiguration('pause');
  return {
    verbosity: cfg.get<Verbosity>('verbosity', 'concise'),
    proxyUrl: cfg.get<string>('proxyUrl', 'https://pause-proxy-seven.vercel.app/api/ai'),
    targetModel: cfg.get<string>('targetModel', 'claude.ai'),
  };
}

/** CallAI backed by the Vercel proxy, using the VS Code host's global fetch (Node 18+). */
export function makeCallAI(proxyUrl: string): CallAI {
  return createProxyClient({ proxyUrl, fetchImpl: fetch, timeoutMs: 25000 });
}

const FRIENDLY: Record<string, string> = {
  TIMEOUT: 'The request timed out. Check your connection and try again.',
  NETWORK: 'Could not reach the Pause service. Are you online?',
  RATE_LIMIT: 'All AI providers are rate-limited right now. Try again shortly.',
  SERVER_ERROR: 'The AI service failed. Try again in a moment.',
  BAD_RESPONSE: 'The AI returned something unexpected. Try again.',
};

export function friendlyError(err: unknown): string {
  const code = err instanceof Error ? err.message : String(err);
  return FRIENDLY[code] ?? `Something went wrong (${code}).`;
}
