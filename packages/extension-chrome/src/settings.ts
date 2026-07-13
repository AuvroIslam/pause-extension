import type { Verbosity } from '@pause/core';

/** User-configurable settings, persisted in chrome.storage.sync. */
export interface PauseSettings {
  /** Master switch for the ⏸ button + score badge. */
  enabled: boolean;
  /** How eager the clarification flow is. */
  verbosity: Verbosity;
  /** Whether to watch for rate-limit banners and offer handoff. */
  handoffEnabled: boolean;
  /** Hostnames the user allows as handoff targets (must be logged in there). */
  handoffTargets: string[];
  /** Show the live score badge. */
  showScoreBadge: boolean;
}

export const DEFAULT_SETTINGS: PauseSettings = {
  enabled: true,
  verbosity: 'concise',
  handoffEnabled: true,
  handoffTargets: ['claude.ai', 'gemini.google.com', 'chatgpt.com', 'perplexity.ai'],
  showScoreBadge: true,
};

const KEY = 'pauseSettings';

export async function getSettings(): Promise<PauseSettings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(KEY, (obj) => {
      resolve({ ...DEFAULT_SETTINGS, ...(obj?.[KEY] as Partial<PauseSettings> | undefined) });
    });
  });
}

export async function setSettings(patch: Partial<PauseSettings>): Promise<PauseSettings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [KEY]: next }, () => resolve(next));
  });
}

/** Subscribe to settings changes (fires with the full merged settings). */
export function onSettingsChanged(cb: (s: PauseSettings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[KEY]) {
      cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue as Partial<PauseSettings>) });
    }
  });
}
