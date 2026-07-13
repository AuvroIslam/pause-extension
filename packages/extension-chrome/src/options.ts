import { getModelName, knownHostnames } from '@pause/core';
import { DEFAULT_SETTINGS, getSettings, setSettings } from './settings.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function showSaved(): void {
  const el = $('saved');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1200);
}

async function render(): Promise<void> {
  const s = await getSettings();

  ($('enabled') as HTMLInputElement).checked = s.enabled;
  ($('showScoreBadge') as HTMLInputElement).checked = s.showScoreBadge;
  ($('handoffEnabled') as HTMLInputElement).checked = s.handoffEnabled;
  ($('verbosity') as HTMLSelectElement).value = s.verbosity;

  // Dedupe hostnames by model name so the target list reads cleanly.
  const seen = new Set<string>();
  const hosts = knownHostnames().filter((h) => {
    const name = getModelName(h);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });

  const container = $('targets');
  container.innerHTML = '';
  for (const host of hosts) {
    const label = document.createElement('label');
    label.className = 'target';
    const checked = s.handoffTargets.includes(host);
    label.innerHTML = `<input type="checkbox" data-host="${host}" ${checked ? 'checked' : ''}/> ${getModelName(host)}`;
    container.appendChild(label);
  }

  container.querySelectorAll<HTMLInputElement>('input[data-host]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const host = cb.dataset.host!;
      const current = (await getSettings()).handoffTargets;
      const next = cb.checked
        ? Array.from(new Set([...current, host]))
        : current.filter((h) => h !== host);
      await setSettings({ handoffTargets: next });
      showSaved();
    });
  });

  ($('enabled') as HTMLInputElement).addEventListener('change', async (e) => {
    await setSettings({ enabled: (e.target as HTMLInputElement).checked });
    showSaved();
  });
  ($('showScoreBadge') as HTMLInputElement).addEventListener('change', async (e) => {
    await setSettings({ showScoreBadge: (e.target as HTMLInputElement).checked });
    showSaved();
  });
  ($('handoffEnabled') as HTMLInputElement).addEventListener('change', async (e) => {
    await setSettings({ handoffEnabled: (e.target as HTMLInputElement).checked });
    showSaved();
  });
  ($('verbosity') as HTMLSelectElement).addEventListener('change', async (e) => {
    const value = (e.target as HTMLSelectElement).value as typeof DEFAULT_SETTINGS.verbosity;
    await setSettings({ verbosity: value });
    showSaved();
  });
}

void render();
