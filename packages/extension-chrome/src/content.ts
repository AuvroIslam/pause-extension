// Pause — content script (adapter over @pause/core).
// Injects a ⏸ button + live score badge into AI chat inputs, runs the adaptive
// clarification flow, and — new in v3 — watches for rate-limit walls and offers a
// one-click, context-preserving handoff to a different AI.

import {
  buildAnswersBlock,
  canonicalHostname,
  getModelName,
  getModelProfile,
  handoffTargetLabel,
  maxQuestionsFor,
  scoreColor,
  scoreLabel,
  scorePrompt,
  type ClarifyQuestion,
} from '@pause/core';
import {
  DEFAULT_SETTINGS,
  getSettings,
  onSettingsChanged,
  type PauseSettings,
} from './settings.js';
import type {
  BuildHandoffRes,
  ImprovePromptRes,
  NextQuestionRes,
  PauseRequest,
} from './messages.js';
import { watchForLimit } from './limitWatch.js';
import { readTranscript } from './transcript.js';

declare global {
  interface Window {
    __pauseLoaded?: boolean;
  }
}

if (!window.__pauseLoaded) {
  window.__pauseLoaded = true;
  main();
}

function main(): void {
  'use strict';

  let settings: PauseSettings = DEFAULT_SETTINGS;

  // ─── State ─────────────────────────────────────────────────────────────────
  interface State {
    active: boolean;
    inputEl: HTMLElement | null;
    originalText: string;
    answers: string[];
    currentQ: number;
    questions: ClarifyQuestion[];
    improvedPrompt: string | null;
    modelProfile: string;
    shadowHost: HTMLElement | null;
    shadow: ShadowRoot | null;
    pauseBtn: HTMLElement | null;
    scoreBadge: HTMLElement | null;
  }
  const state: State = {
    active: false,
    inputEl: null,
    originalText: '',
    answers: [],
    currentQ: 0,
    questions: [],
    improvedPrompt: null,
    modelProfile: '',
    shadowHost: null,
    shadow: null,
    pauseBtn: null,
    scoreBadge: null,
  };

  function getHostname(): string {
    return canonicalHostname(window.location.hostname);
  }

  // ─── Input detection ─────────────────────────────────────────────────────────
  const INPUT_SELECTORS = [
    '#prompt-textarea',
    'div[contenteditable="true"][data-testid="chat-input"]',
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"].ql-editor',
    'div[contenteditable="true"][data-testid]',
    'div[contenteditable="true"][placeholder]',
    'div[contenteditable="true"]',
    'textarea:not([type="hidden"])',
  ];

  function findAIInput(): HTMLElement | null {
    for (const sel of INPUT_SELECTORS) {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        if (isUsableInput(el)) return el;
      }
    }
    const richTextarea = document.querySelector('rich-textarea');
    if (richTextarea && (richTextarea as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot) {
      const inner = (richTextarea as HTMLElement).shadowRoot!.querySelector<HTMLElement>(
        'div[contenteditable="true"]',
      );
      if (inner && isUsableInput(inner)) return inner;
    }
    return null;
  }

  function isUsableInput(el: HTMLElement): boolean {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 50 && r.height > 10;
  }

  function getInputText(el: HTMLElement | null): string {
    if (!el) return '';
    return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
      ? (el as HTMLTextAreaElement).value
      : el.innerText || el.textContent || '';
  }

  function setInputText(el: HTMLElement | null, text: string): void {
    if (!el) return;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto =
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      document.execCommand('selectAll');
      try {
        document.execCommand('insertText', false, text);
      } catch {
        el.innerText = text;
        el.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
        );
      }
    }
  }

  // ─── Positioning ───────────────────────────────────────────────────────────
  const BTN_SIZE = 36;

  function isDeepSeekHost(hostname: string): boolean {
    return hostname === 'chat.deepseek.com' || hostname === 'deepseek.com';
  }

  function findInputContainer(inputEl: HTMLElement): HTMLElement {
    const inputRect = inputEl.getBoundingClientRect();
    let el = inputEl.parentElement;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      const pos = style.position;
      const r = el.getBoundingClientRect();
      if (
        (pos === 'relative' || pos === 'absolute' || pos === 'sticky' || pos === 'fixed') &&
        r.width >= inputRect.width * 0.85
      )
        return el;
      if (style.overflow !== 'visible' && r.width >= inputRect.width * 0.85) return el;
      el = el.parentElement;
    }
    return inputEl;
  }

  function getVisualContainer(inputEl: HTMLElement): HTMLElement {
    const host = getHostname();
    if (host === 'gemini.google.com') {
      const root = inputEl.getRootNode?.() as ShadowRoot | null;
      if (root && (root as ShadowRoot).host) {
        const hostEl = (root as ShadowRoot).host as HTMLElement;
        const rr = hostEl.getBoundingClientRect();
        if (rr.width > 0 && rr.height > 0) return hostEl;
      }
    }
    return findInputContainer(inputEl);
  }

  function positionBtn(btn: HTMLElement, inputEl: HTMLElement): void {
    const host = getHostname();
    const isGemini = host === 'gemini.google.com';
    const isDeepSeek = isDeepSeekHost(host);
    const container = getVisualContainer(inputEl);
    const r = container.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const rightOffset = isGemini || isDeepSeek ? 8 : -6;
    let x = Math.round(r.right - BTN_SIZE - rightOffset);
    let y: number;
    if (isGemini || isDeepSeek) {
      y = Math.round(r.top + (r.height - BTN_SIZE) / 2);
    } else {
      y = Math.round(Math.min(r.bottom - BTN_SIZE - 10, window.innerHeight - BTN_SIZE - 14));
    }
    x = Math.max(8, Math.min(x, window.innerWidth - BTN_SIZE - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - BTN_SIZE - 8));
    btn.style.transform = `translate(${x}px,${y}px)`;
  }

  function positionBadge(badge: HTMLElement, inputEl: HTMLElement): void {
    const container = getVisualContainer(inputEl);
    const r = container.getBoundingClientRect();
    if (r.width === 0) return;
    const x = Math.round(r.left - 4);
    const y = Math.round(Math.max(r.top - 40, 8));
    badge.style.left = '0';
    badge.style.top = '0';
    badge.style.transform = `translate(${x}px,${y}px)`;
  }

  // ─── Score badge ─────────────────────────────────────────────────────────────
  function createScoreBadge(): HTMLElement {
    const badge = document.createElement('div');
    badge.id = '__pause-score-badge';
    Object.assign(badge.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      zIndex: '2147483645',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '3px 9px 3px 7px',
      borderRadius: '20px',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      fontSize: '11px',
      fontWeight: '500',
      background: 'rgba(20,20,20,0.92)',
      border: '1px solid rgba(255,255,255,0.1)',
      color: 'rgba(255,255,255,0.6)',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 0.2s ease',
      whiteSpace: 'nowrap',
      willChange: 'transform',
    } as CSSStyleDeclaration);
    document.body.appendChild(badge);
    return badge;
  }

  function updateScoreBadge(badge: HTMLElement | null, inputEl: HTMLElement | null, score: number): void {
    if (!badge || !inputEl || score === 0 || !settings.showScoreBadge) {
      if (badge) badge.style.opacity = '0';
      return;
    }
    const color = scoreColor(score);
    const label = scoreLabel(score);
    const fillW = Math.round((score / 100) * 22);
    badge.innerHTML = `
      <svg width="22" height="3" viewBox="0 0 22 3" style="flex-shrink:0;border-radius:2px;overflow:hidden">
        <rect width="22" height="3" fill="rgba(255,255,255,0.08)"/>
        <rect width="${fillW}" height="3" fill="${color}" opacity="0.9"/>
      </svg>
      <span style="color:${color}">${score}%</span>
      <span style="opacity:0.4">${label}</span>`;
    positionBadge(badge, inputEl);
    badge.style.opacity = '1';
  }

  // ─── Pause button ────────────────────────────────────────────────────────────
  const BTN_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="4" y="3" width="3" height="10" rx="1.5" fill="rgba(255,255,255,0.9)"/>
    <rect x="9" y="3" width="3" height="10" rx="1.5" fill="rgba(255,255,255,0.9)"/>
  </svg>`;

  function createPauseButton(): HTMLElement {
    const btn = document.createElement('div');
    btn.id = '__pause-trigger';
    btn.setAttribute('title', 'Pause — Think before you prompt');
    btn.innerHTML = BTN_SVG;
    Object.assign(btn.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '36px',
      height: '36px',
      cursor: 'pointer',
      zIndex: '2147483646',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: '50%',
      background: 'rgba(30,30,30,0.95)',
      border: '1px solid rgba(255,255,255,0.14)',
      transition: 'opacity 0.12s ease, background 0.12s ease',
      opacity: '0',
      pointerEvents: 'none',
      willChange: 'transform',
    } as CSSStyleDeclaration);
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(40,40,40,0.98)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'rgba(20,20,20,0.92)';
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      triggerPause();
    });
    document.body.appendChild(btn);
    return btn;
  }

  // ─── Shadow DOM + CSS ──────────────────────────────────────────────────────
  const PANEL_CSS = `
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
    .overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;animation:fadeIn .12s ease}
    .panel{background:#111;border:1px solid rgba(255,255,255,0.08);border-radius:14px;width:90%;max-width:540px;max-height:86vh;display:flex;flex-direction:column;overflow:hidden;animation:slideUp .14s ease;box-shadow:0 0 0 1px rgba(255,255,255,0.04) inset,0 24px 64px rgba(0,0,0,0.8)}
    @keyframes slideUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
    @keyframes slideDown{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(10px)}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes fadeIn{from{opacity:0}to{opacity:1}}
    @keyframes fadeOut{from{opacity:1}to{opacity:0}}
    @keyframes pulse{0%,100%{opacity:0.2}50%{opacity:1}}
    @keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}
    .shake{animation:shake .35s ease;border-color:rgba(168,0,56,0.45) !important}
    .overlay.closing{animation:fadeOut .15s ease forwards}
    .overlay.closing .panel{animation:slideDown .15s ease forwards}
    .btn-spin{display:inline-block;width:12px;height:12px;border-radius:50%;flex-shrink:0;border:1.5px solid rgba(0,0,0,0.25);border-top-color:#000;animation:spin .6s linear infinite}
    .btn-ghost .btn-spin,.btn-spin.light{border-color:rgba(255,255,255,0.15);border-top-color:rgba(255,255,255,0.75)}
    .hdr{padding:13px 16px 11px;border-bottom:1px solid rgba(255,255,255,0.05);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
    .logo{display:flex;align-items:center;gap:8px}
    .logo-icon{width:22px;height:22px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;display:flex;align-items:center;justify-content:center}
    .logo-name{font-size:13px;font-weight:600;color:rgba(255,255,255,0.9);letter-spacing:-.1px}
    .logo-sub{font-size:10px;color:rgba(255,255,255,0.3);letter-spacing:.5px;text-transform:uppercase;margin-top:1px}
    .hdr-right{display:flex;align-items:center;gap:8px}
    .q-counter{font-size:11px;color:rgba(255,255,255,0.25);letter-spacing:.2px}
    .close-btn{width:24px;height:24px;background:transparent;border:none;border-radius:6px;color:rgba(255,255,255,0.3);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;transition:color .1s,background .1s}
    .close-btn:hover{background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.8)}
    .prog-track{height:1px;background:rgba(255,255,255,0.05);flex-shrink:0}
    .prog-fill{height:100%;background:rgba(255,255,255,0.5);transition:width .3s ease}
    .body{padding:18px 16px;flex:1;overflow-y:auto}
    .loading-body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:48px 16px}
    .loading-dots{display:flex;gap:6px;align-items:center}
    .loading-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,0.5)}
    .loading-dot:nth-child(1){animation:pulse 1.1s ease-in-out infinite 0s}
    .loading-dot:nth-child(2){animation:pulse 1.1s ease-in-out infinite .18s}
    .loading-dot:nth-child(3){animation:pulse 1.1s ease-in-out infinite .36s}
    .loading-msg{font-size:13px;color:rgba(255,255,255,0.35);letter-spacing:.1px}
    .q-text{font-size:17px;font-weight:600;color:rgba(255,255,255,0.92);line-height:1.45;letter-spacing:-.2px;margin-bottom:16px}
    .multi-hint{font-size:11px;color:rgba(255,255,255,0.3);margin-bottom:10px;margin-top:-10px}
    .chips-row{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px}
    .chip{padding:7px 15px;border-radius:20px;font-size:12.5px;font-weight:500;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);color:rgba(255,255,255,0.5);cursor:pointer;transition:background .1s,border-color .1s,color .1s;font-family:inherit;white-space:nowrap;user-select:none;min-height:36px;display:inline-flex;align-items:center}
    .chip:hover{background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.85);border-color:rgba(255,255,255,0.2)}
    .chip.on{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.4);color:rgba(255,255,255,0.95)}
    .ans-box{width:100%;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:11px 13px;color:rgba(255,255,255,0.85);font-size:13px;font-family:inherit;resize:none;min-height:72px;outline:none;line-height:1.6;transition:border-color .15s,background .15s}
    .ans-box:focus{border-color:rgba(255,255,255,0.22);background:rgba(255,255,255,0.05)}
    .ans-box::placeholder{color:rgba(255,255,255,0.2)}
    .res-score-row{display:flex;align-items:center;justify-content:center;gap:24px;padding:22px 16px;margin-bottom:16px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:14px}
    .res-arrow{font-size:22px;font-weight:300;color:rgba(255,255,255,0.5);flex-shrink:0;line-height:1}
    .res-section-lbl{font-size:10px;letter-spacing:.8px;text-transform:uppercase;color:rgba(255,255,255,0.28);font-weight:500;margin-bottom:6px}
    .result-box{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:9px;padding:11px 13px;font-size:12.5px;color:rgba(255,255,255,0.4);line-height:1.65;white-space:pre-wrap;word-break:break-word;max-height:110px;overflow-y:auto}
    .after-box{border-color:rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.82);max-height:200px;margin-bottom:10px}
    .res-before-summary{font-size:10px;color:rgba(255,255,255,0.28);cursor:pointer;list-style:none;padding:0 0 8px 0;letter-spacing:.8px;text-transform:uppercase;font-weight:500;user-select:none;display:flex;align-items:center;gap:5px;width:100%;transition:color .15s}
    .res-before-summary:hover{color:rgba(255,255,255,0.55)}
    .res-before-summary::-webkit-details-marker{display:none}
    .error-body{text-align:center;padding:32px 16px}
    .error-icon{font-size:24px;margin-bottom:10px}
    .error-title{font-size:14px;font-weight:600;color:rgba(255,255,255,0.85);margin-bottom:6px}
    .error-msg{font-size:12px;color:rgba(255,255,255,0.35);line-height:1.6;margin-bottom:20px}
    .handoff-intro{font-size:13px;color:rgba(255,255,255,0.55);line-height:1.6;margin-bottom:16px}
    .handoff-intro b{color:rgba(255,255,255,0.85);font-weight:600}
    .handoff-targets{display:flex;flex-wrap:wrap;gap:8px}
    .handoff-target{padding:10px 16px;border-radius:10px;font-size:13px;font-weight:500;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.8);cursor:pointer;font-family:inherit;transition:background .1s,border-color .1s}
    .handoff-target:hover{background:rgba(255,255,255,0.1);border-color:rgba(255,255,255,0.28)}
    .ftr{padding:12px 16px 14px;border-top:1px solid rgba(255,255,255,0.05);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:8px}
    .ftr-left{display:flex;gap:6px}
    .ftr-right{display:flex;gap:6px}
    .btn{padding:8px 18px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;transition:background .1s,opacity .1s,transform .1s;min-height:36px;display:inline-flex;align-items:center;gap:6px;letter-spacing:-.1px}
    .btn-ghost{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);color:rgba(255,255,255,0.45)}
    .btn-ghost:hover{background:rgba(255,255,255,0.09);color:rgba(255,255,255,0.8);border-color:rgba(255,255,255,0.16)}
    .btn-primary{background:#fff;border:none;color:#000;font-weight:600;font-size:13px;padding:9px 22px}
    .btn-primary:hover{background:rgba(255,255,255,0.88)}
    .btn-primary:disabled{opacity:0.5;cursor:default;transform:none}
    ::-webkit-scrollbar{width:3px}
    ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:2px}`;

  const LOGO_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <rect x="2" y="1" width="3" height="10" rx="1.5" fill="rgba(255,255,255,0.7)"/>
    <rect x="7" y="1" width="3" height="10" rx="1.5" fill="rgba(255,255,255,0.7)"/>
  </svg>`;

  function initShadow(): ShadowRoot {
    if (state.shadow) return state.shadow;
    const host = document.createElement('div');
    host.id = '__pause-root';
    document.body.appendChild(host);
    ['keydown', 'keyup', 'keypress', 'input', 'compositionstart', 'compositionend'].forEach((t) => {
      host.addEventListener(t, (e) => e.stopPropagation());
    });
    ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup'].forEach((t) => {
      host.addEventListener(t, (e) => e.stopPropagation());
    });
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);
    state.shadowHost = host;
    state.shadow = shadow;
    return shadow;
  }

  function repositionPanel(): void {
    if (!state.shadowHost) return;
    Object.assign(state.shadowHost.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '2147483647',
    } as CSSStyleDeclaration);
  }

  // ─── Persistent panel shell ────────────────────────────────────────────────
  interface Shell {
    overlay: HTMLElement;
    panel: HTMLElement;
    prog: HTMLElement;
    hdr: HTMLElement;
    body: HTMLElement;
    ftr: HTMLElement;
  }
  let _shell: Shell | null = null;

  function ensureShell(shadow: ShadowRoot): Shell {
    if (_shell) return _shell;
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closePause();
    });
    const panel = document.createElement('div');
    panel.className = 'panel';
    const prog = document.createElement('div');
    prog.className = 'prog-track';
    prog.innerHTML = '<div class="prog-fill" id="p-prog-fill" style="width:0%"></div>';
    const hdr = document.createElement('div');
    const body = document.createElement('div');
    body.className = 'body';
    const ftr = document.createElement('div');
    ftr.className = 'ftr';
    panel.append(prog, hdr, body, ftr);
    overlay.appendChild(panel);
    shadow.appendChild(overlay);
    _shell = { overlay, panel, prog, hdr, body, ftr };
    return _shell;
  }

  function setProgress(pct: number): void {
    const fill = _shell?.prog.querySelector<HTMLElement>('#p-prog-fill');
    if (fill) fill.style.width = pct + '%';
  }

  function setHeader(subtitle: string, counterText: string): void {
    if (!_shell) return;
    _shell.hdr.innerHTML = `
      <div class="hdr">
        <div class="logo">
          <div class="logo-icon">${LOGO_SVG}</div>
          <div><div class="logo-name">Pause</div><div class="logo-sub">${escHtml(subtitle)}</div></div>
        </div>
        <div class="hdr-right">
          ${counterText ? `<span class="q-counter">${escHtml(counterText)}</span>` : ''}
          <button class="close-btn" id="p-close">✕</button>
        </div>
      </div>`;
    const closeBtn = _shell.hdr.querySelector<HTMLElement>('#p-close');
    if (closeBtn) closeBtn.onclick = closePause;
  }

  function setBody(html: string, onReady?: () => void): void {
    if (!_shell) return;
    const body = _shell.body;
    if (!body.innerHTML.trim()) {
      body.innerHTML = html;
      body.style.opacity = '1';
      onReady?.();
      return;
    }
    body.style.transition = 'opacity 0.06s ease';
    body.style.opacity = '0';
    setTimeout(() => {
      body.innerHTML = html;
      body.style.opacity = '1';
      onReady?.();
    }, 60);
  }

  function setFooter(html: string, onReady?: () => void): void {
    if (!_shell) return;
    _shell.ftr.innerHTML = html;
    _shell.ftr.style.display = html ? 'flex' : 'none';
    onReady?.();
  }

  function showShell(shadow: ShadowRoot): void {
    ensureShell(shadow);
    _shell!.overlay.style.display = 'flex';
  }

  function hideShell(): void {
    if (!_shell) return;
    const overlay = _shell.overlay;
    _shell = null;
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 160);
  }

  function clearPanel(shadow: ShadowRoot): void {
    hideShell();
    setTimeout(() => {
      Array.from(shadow.children).forEach((c) => {
        if (c.tagName !== 'STYLE') c.remove();
      });
    }, 160);
  }

  function escHtml(t: string): string {
    return String(t)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Messaging ─────────────────────────────────────────────────────────────
  function sendToBackground<T>(msg: PauseRequest, timeoutMs = 25000): Promise<T | { ok: false; error: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (val: unknown) => {
        if (!settled) {
          settled = true;
          resolve(val as T);
        }
      };
      const timer = setTimeout(() => done({ ok: false, error: 'TIMEOUT' }), timeoutMs);
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            const m = chrome.runtime.lastError.message || '';
            const code = m.toLowerCase().includes('message port closed')
              ? 'SW_TERMINATED'
              : 'EXTENSION_ERROR';
            done({ ok: false, error: code });
          } else {
            done(resp || { ok: false, error: 'NO_RESPONSE' });
          }
        });
      } catch {
        clearTimeout(timer);
        done({ ok: false, error: 'EXTENSION_ERROR' });
      }
    });
  }

  // ─── Screens ───────────────────────────────────────────────────────────────
  const LOADING_DOTS = `<div class="loading-dots"><div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div></div>`;

  function showLoading(shadow: ShadowRoot, message: string): void {
    showShell(shadow);
    setHeader('thinking…', '');
    setBody(`<div class="loading-body">${LOADING_DOTS}<div class="loading-msg">${escHtml(message)}</div></div>`);
    setFooter('');
  }

  function showQuestions(shadow: ShadowRoot): void {
    const qs = state.questions;
    const qi = state.currentQ;
    const q = qs[qi];
    if (!q) return;
    const totalKnown = state.questions.length;
    const pct = Math.min(((qi + 1) / Math.max(totalKnown, maxQuestionsFor(settings.verbosity))) * 95, 95);
    const prev = state.answers[qi] || '';

    showShell(shadow);
    setHeader('Think first', `Question ${qi + 1}`);
    setProgress(pct);

    setBody(
      `
      <div class="q-text">${escHtml(q.text)}</div>
      ${q.multiSelect ? '<p class="multi-hint">Select all that apply</p>' : ''}
      <div class="chips-row" id="p-chips">
        ${q.suggestions.map((s) => `<button class="chip">${escHtml(s)}</button>`).join('')}
      </div>
      <textarea class="ans-box" id="p-ans" placeholder="Or type your own answer…">${escHtml(prev)}</textarea>`,
      () => {
        const body = _shell!.body;
        const chipsRow = body.querySelector<HTMLElement>('#p-chips')!;
        const ansBox = body.querySelector<HTMLTextAreaElement>('#p-ans')!;
        const isMulti = !!q.multiSelect;

        const chipText = (c: Element) => (c.textContent || '').replace(/^✓\s*/, '').trim();
        const selectedChipsText = () =>
          Array.from(chipsRow.querySelectorAll('.chip.on')).map(chipText).join(', ');

        if (prev) {
          const parts = isMulti ? prev.split(',').map((s) => s.trim()) : [prev.trim()];
          chipsRow.querySelectorAll('.chip').forEach((c) => {
            if (parts.includes(chipText(c))) c.classList.add('on');
          });
        }

        chipsRow.addEventListener('mousedown', (e) => {
          const chip = (e.target as HTMLElement).closest('.chip');
          if (!chip) return;
          if (isMulti) {
            chip.classList.toggle('on');
            ansBox.value = selectedChipsText();
          } else {
            const on = chip.classList.contains('on');
            chipsRow.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
            if (!on) {
              chip.classList.add('on');
              ansBox.value = chipText(chip);
            } else ansBox.value = '';
          }
        });
        chipsRow.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('.chip')) ansBox.focus();
        });
        ansBox.addEventListener('input', () => {
          if (!isMulti)
            chipsRow
              .querySelectorAll('.chip')
              .forEach((c) => c.classList.toggle('on', chipText(c) === ansBox.value));
        });
        setTimeout(() => ansBox.focus(), 60);

        let fgTimer: ReturnType<typeof setTimeout> | null = null;
        ansBox.addEventListener('focusout', (e) => {
          if (state.active && !(e as FocusEvent).relatedTarget)
            fgTimer = setTimeout(() => ansBox.focus(), 50);
        });
        chipsRow.addEventListener('mousedown', () => fgTimer && clearTimeout(fgTimer), true);

        ansBox.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            if (isMulti && !e.ctrlKey && !e.metaKey) return;
            if (!e.shiftKey) {
              e.preventDefault();
              advanceQuestion(shadow, ansBox.value);
            }
          }
          if (e.key === 'Escape') closePause();
        });
      },
    );

    setFooter(
      `
      <div class="ftr-left">
        ${qi > 0 ? '<button class="btn btn-ghost" id="p-back">Back</button>' : '<span></span>'}
      </div>
      <div class="ftr-right">
        <button class="btn btn-ghost" id="p-skip">Skip</button>
        <button class="btn btn-primary" id="p-next">Next</button>
      </div>`,
      () => {
        const ftr = _shell!.ftr;
        ftr.querySelector<HTMLElement>('#p-next')!.onclick = () => {
          const box = _shell!.body.querySelector<HTMLTextAreaElement>('#p-ans');
          const ans = box?.value || '';
          if (!ans.trim()) {
            if (box) {
              box.focus();
              box.classList.add('shake');
              setTimeout(() => box.classList.remove('shake'), 400);
            }
            return;
          }
          advanceQuestion(shadow, ans);
        };
        ftr.querySelector<HTMLElement>('#p-skip')!.onclick = () => advanceQuestion(shadow, '__skip__');
        const back = ftr.querySelector<HTMLElement>('#p-back');
        if (back)
          back.onclick = () => {
            state.currentQ--;
            state.questions = state.questions.slice(0, state.currentQ + 1);
            state.answers = state.answers.slice(0, state.currentQ + 1);
            showQuestions(shadow);
          };
      },
    );
  }

  function setNextLoading(): void {
    if (!_shell) return;
    const nextBtn = _shell.ftr.querySelector<HTMLButtonElement>('#p-next');
    const skipBtn = _shell.ftr.querySelector<HTMLButtonElement>('#p-skip');
    const backBtn = _shell.ftr.querySelector<HTMLButtonElement>('#p-back');
    if (nextBtn) {
      nextBtn.style.minWidth = nextBtn.offsetWidth + 'px';
      nextBtn.disabled = true;
      nextBtn.innerHTML = '<span class="btn-spin light"></span>&nbsp;Thinking…';
      nextBtn.style.opacity = '0.7';
    }
    if (skipBtn) {
      skipBtn.disabled = true;
      skipBtn.style.opacity = '0.4';
    }
    if (backBtn) {
      backBtn.disabled = true;
      backBtn.style.opacity = '0.4';
    }
  }

  function advanceQuestion(shadow: ShadowRoot, rawAnswer: string): void {
    state.answers[state.currentQ] = rawAnswer.trim();
    if (state.questions.length < maxQuestionsFor(settings.verbosity)) {
      setNextLoading();
      fetchNextQuestion(shadow);
    } else {
      buildImprovedPrompt(shadow);
    }
  }

  async function buildImprovedPrompt(shadow: ShadowRoot, attempt = 0): Promise<void> {
    showLoading(shadow, 'Building your improved prompt…');
    const answersBlock = buildAnswersBlock(state.questions, state.answers);
    const resp = await sendToBackground<ImprovePromptRes>({
      type: 'IMPROVE_PROMPT',
      originalText: state.originalText,
      answersBlock,
      modelProfile: state.modelProfile,
      answeredCount: state.answers.filter((a) => a && a.trim()).length,
      totalQuestions: state.questions.length,
      verbosity: settings.verbosity,
    });
    if (!resp.ok) {
      if (resp.error === 'SW_TERMINATED' && attempt < 2) {
        await new Promise((r) => setTimeout(r, 600));
        return buildImprovedPrompt(shadow, attempt + 1);
      }
      showError(shadow, resp.error, () => buildImprovedPrompt(shadow));
      return;
    }
    state.improvedPrompt = resp.improvedPrompt;
    showResults(shadow);
  }

  function showResults(shadow: ShadowRoot): void {
    const orig = state.originalText.trim() || '(empty)';
    const improved = state.improvedPrompt || orig;
    const scoreBefore = scorePrompt(orig);
    const scoreAfter = scorePrompt(improved);

    const SVG_R = 38;
    const SVG_C = +(2 * Math.PI * SVG_R).toFixed(2);
    const circleSvg = (score: number, color: string, label: string) => {
      const offset = +(SVG_C * (1 - score / 100)).toFixed(2);
      const ff = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
      const id = `cl${Math.random().toString(36).slice(2, 7)}`;
      return (
        `<svg class="res-circle-svg" viewBox="0 0 100 100" width="90" height="90">` +
        `<defs><clipPath id="${id}"><path d="M50,${50 - SVG_R - 8} A${SVG_R + 8},${SVG_R + 8} 0 1,1 ${50 - 0.001},${50 - SVG_R - 8} Z"/></clipPath></defs>` +
        `<circle cx="50" cy="50" r="${SVG_R}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="6"/>` +
        `<circle cx="50" cy="50" r="${SVG_R}" fill="none" stroke="${color}" stroke-width="6" stroke-dasharray="${SVG_C}" stroke-dashoffset="${offset}" stroke-linecap="round" transform="rotate(-90 50 50)" style="filter:drop-shadow(0 0 6px ${color}bb)" clip-path="url(#${id})"/>` +
        `<text x="50" y="48" dominant-baseline="middle" text-anchor="middle" font-size="22" font-weight="700" fill="${color}" font-family="${ff}">${score}%</text>` +
        `<text x="50" y="65" text-anchor="middle" font-size="8" fill="rgba(255,255,255,0.65)" font-family="${ff}" letter-spacing="1.5">${label}</text>` +
        `</svg>`
      );
    };

    showShell(shadow);
    setHeader('Done', '');
    setProgress(100);
    setBody(`
      <div class="res-score-row">
        ${circleSvg(scoreBefore, scoreColor(scoreBefore), 'BEFORE')}
        <div class="res-arrow">&#x2192;</div>
        ${circleSvg(scoreAfter, scoreColor(scoreAfter), 'AFTER')}
      </div>
      <details class="res-before-toggle">
        <summary class="res-before-summary">Show original</summary>
        <div class="result-box" style="margin-top:8px;margin-bottom:14px">${escHtml(orig)}</div>
      </details>
      <div class="res-section-lbl">Improved prompt</div>
      <div class="result-box after-box" id="p-improved">${escHtml(improved)}</div>`);

    setFooter(
      `
      <div class="ftr-left"><button class="btn btn-ghost" id="p-redo">Redo</button></div>
      <div class="ftr-right">
        <button class="btn btn-ghost" id="p-copy">Copy</button>
        <button class="btn btn-primary" id="p-replace">Use this prompt</button>
      </div>`,
      () => {
        _shell!.ftr.querySelector<HTMLElement>('#p-replace')!.onclick = () => {
          setInputText(state.inputEl, improved);
          closePause();
        };
        _shell!.ftr.querySelector<HTMLElement>('#p-copy')!.onclick = () => {
          navigator.clipboard.writeText(improved).catch(() => {});
          const b = _shell!.ftr.querySelector<HTMLElement>('#p-copy');
          if (b) {
            b.textContent = 'Copied!';
            setTimeout(() => (b.textContent = 'Copy'), 2000);
          }
        };
        _shell!.ftr.querySelector<HTMLElement>('#p-redo')!.onclick = () => {
          state.answers = [];
          state.questions = [];
          state.currentQ = 0;
          startQuestionFlow(shadow);
        };
      },
    );
  }

  const ERROR_MESSAGES: Record<string, string> = {
    RATE_LIMIT: 'All AI providers are rate-limited right now. Wait a moment and try again.',
    TIMEOUT: 'Request timed out. Check your internet connection.',
    NETWORK: 'No internet connection detected.',
    BAD_RESPONSE: 'Unexpected AI response. Try again.',
    SERVER_ERROR: 'AI service error. All providers failed. Try again shortly.',
    SW_TERMINATED: 'Extension restarted mid-request. Please try again.',
    EXTENSION_ERROR: 'Extension error. Try refreshing the page.',
  };

  function showError(shadow: ShadowRoot, errorCode: string, onRetry?: () => void): void {
    const msg = ERROR_MESSAGES[errorCode] || `Something went wrong (${errorCode}).`;
    showShell(shadow);
    setHeader('Paused', '');
    setProgress(0);
    setBody(`
      <div class="error-body">
        <div class="error-icon">⚠️</div>
        <div class="error-title">Couldn't continue</div>
        <div class="error-msg">${escHtml(msg)}</div>
      </div>`);
    setFooter(
      `
      <div class="ftr-left"></div>
      <div class="ftr-right">
        <button class="btn btn-ghost" id="p-dismiss">Dismiss</button>
        <button class="btn btn-primary" id="p-action">Try again</button>
      </div>`,
      () => {
        _shell!.ftr.querySelector<HTMLElement>('#p-dismiss')!.onclick = closePause;
        _shell!.ftr.querySelector<HTMLElement>('#p-action')!.onclick = () => {
          if (onRetry) onRetry();
          else triggerPause();
        };
      },
    );
  }

  // ─── Main clarify flow ─────────────────────────────────────────────────────
  async function startQuestionFlow(shadow: ShadowRoot): Promise<void> {
    showLoading(shadow, 'Thinking about your prompt…');
    state.modelProfile = getModelProfile(getHostname()).profile;
    state.questions = [];
    state.answers = [];
    state.currentQ = 0;
    await fetchNextQuestion(shadow);
  }

  async function fetchNextQuestion(shadow: ShadowRoot, attempt = 0): Promise<void> {
    const previousQA = state.questions.map((q, i) => ({
      question: q.text,
      answer: (state.answers[i] || '').trim(),
    }));
    const resp = await sendToBackground<NextQuestionRes>({
      type: 'NEXT_QUESTION',
      promptText: state.originalText,
      modelProfileName: getModelName(getHostname()),
      previousQA,
      questionIndex: state.questions.length,
      verbosity: settings.verbosity,
    });
    if (!resp.ok) {
      if (resp.error === 'SW_TERMINATED' && attempt < 2) {
        await new Promise((r) => setTimeout(r, 600));
        return fetchNextQuestion(shadow, attempt + 1);
      }
      showError(shadow, resp.error, () => fetchNextQuestion(shadow));
      return;
    }
    if (resp.done) {
      buildImprovedPrompt(shadow);
      return;
    }
    state.questions.push(resp.question);
    state.currentQ = state.questions.length - 1;
    showQuestions(shadow);
  }

  function triggerPause(): void {
    if (state.active) return;
    const inputEl = state.inputEl || findAIInput();
    if (!inputEl) return;
    const text = getInputText(inputEl);
    if (text.trim().length < 3) {
      if (state.pauseBtn) {
        state.pauseBtn.setAttribute('title', 'Type something first!');
        setTimeout(
          () => state.pauseBtn?.setAttribute('title', 'Pause — Think before you prompt'),
          2000,
        );
      }
      return;
    }
    state.inputEl = inputEl;
    state.originalText = text;
    state.active = true;
    state.answers = [];
    state.questions = [];
    state.currentQ = 0;
    state.improvedPrompt = null;
    const shadow = initShadow();
    repositionPanel();
    startQuestionFlow(shadow);
  }

  function closePause(): void {
    state.active = false;
    state.answers = [];
    state.questions = [];
    state.currentQ = 0;
    state.improvedPrompt = null;
    if (state.shadow) clearPanel(state.shadow);
    if (state.shadowHost)
      Object.assign(state.shadowHost.style, { width: '0', height: '0' } as CSSStyleDeclaration);
    setTimeout(() => {
      if (state.active || !state.inputEl || !state.scoreBadge) return;
      updateScoreBadge(state.scoreBadge, state.inputEl, scorePrompt(getInputText(state.inputEl)));
    }, 200);
  }

  // ─── Handoff (limit → continue elsewhere) ──────────────────────────────────
  const PENDING_KEY = 'pausePendingHandoff';
  const PENDING_TTL = 5 * 60 * 1000;
  let _handoffOffered = false;

  function eligibleTargets(): string[] {
    const here = getHostname();
    return settings.handoffTargets.filter((t) => canonicalHostname(t) !== here);
  }

  function showHandoffCard(shadow: ShadowRoot): void {
    const targets = eligibleTargets();
    if (targets.length === 0) return;
    state.active = true;
    showShell(shadow);
    repositionPanel();
    setHeader('Limit reached', '');
    setProgress(0);
    setBody(
      `
      <div class="handoff-intro">You've hit <b>${escHtml(getModelName(getHostname()))}</b>'s limit. Continue this exact conversation on another AI you're signed into — Pause carries the context over.</div>
      <div class="handoff-targets" id="p-handoff-targets">
        ${targets
          .map(
            (t) =>
              `<button class="handoff-target" data-host="${escHtml(t)}">Continue on ${escHtml(handoffTargetLabel(t))} →</button>`,
          )
          .join('')}
      </div>`,
      () => {
        _shell!.body.querySelectorAll<HTMLElement>('.handoff-target').forEach((btn) => {
          btn.onclick = () => startHandoff(shadow, btn.dataset.host!);
        });
      },
    );
    setFooter(
      `<div class="ftr-left"></div><div class="ftr-right"><button class="btn btn-ghost" id="p-handoff-dismiss">Not now</button></div>`,
      () => {
        _shell!.ftr.querySelector<HTMLElement>('#p-handoff-dismiss')!.onclick = closePause;
      },
    );
  }

  async function startHandoff(shadow: ShadowRoot, targetHostname: string): Promise<void> {
    showLoading(shadow, `Packing your context for ${getModelName(targetHostname)}…`);
    const transcript = readTranscript(getHostname());
    const pendingUserText = getInputText(state.inputEl || findAIInput());
    const resp = await sendToBackground<BuildHandoffRes>(
      {
        type: 'BUILD_HANDOFF',
        transcript,
        targetHostname,
        pendingUserText,
        verbosity: settings.verbosity,
      },
      30000,
    );
    if (!resp.ok) {
      showError(shadow, resp.error, () => startHandoff(shadow, targetHostname));
      return;
    }
    await new Promise<void>((resolve) => {
      chrome.storage.local.set(
        { [PENDING_KEY]: { targetHostname, prompt: resp.continuationPrompt, ts: Date.now() } },
        () => resolve(),
      );
    });
    // Also copy to clipboard as a fallback in case auto-inject misses.
    navigator.clipboard.writeText(resp.continuationPrompt).catch(() => {});
    closePause();
    window.open(`https://${targetHostname}`, '_blank', 'noopener');
  }

  // On any supported page, check for a pending handoff meant for THIS site.
  function consumePendingHandoff(): void {
    chrome.storage.local.get(PENDING_KEY, (obj) => {
      const pending = obj?.[PENDING_KEY] as
        | { targetHostname: string; prompt: string; ts: number }
        | undefined;
      if (!pending) return;
      if (canonicalHostname(pending.targetHostname) !== getHostname()) return;
      if (Date.now() - pending.ts > PENDING_TTL) {
        chrome.storage.local.remove(PENDING_KEY);
        return;
      }
      // Wait for the input to exist, then inject.
      let tries = 0;
      const tryInject = () => {
        const input = findAIInput();
        if (input) {
          setInputText(input, pending.prompt);
          chrome.storage.local.remove(PENDING_KEY);
          toast(`Context carried over from your previous chat. Review & send.`);
          return;
        }
        if (tries++ < 40) setTimeout(tryInject, 500);
      };
      tryInject();
    });
  }

  function toast(message: string): void {
    const el = document.createElement('div');
    el.textContent = message;
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '24px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      background: 'rgba(20,20,20,0.96)',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.14)',
      padding: '10px 16px',
      borderRadius: '10px',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      fontSize: '13px',
      boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
      opacity: '0',
      transition: 'opacity .2s ease',
    } as CSSStyleDeclaration);
    document.body.appendChild(el);
    requestAnimationFrame(() => (el.style.opacity = '1'));
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 6000);
  }

  // ─── Positioning system (event-driven) ─────────────────────────────────────
  let _swWarmedUp = false;
  let _resizeObs: ResizeObserver | null = null;
  let _mutationObs: MutationObserver | null = null;
  let _mutationRaf: number | null = null;
  let _trackedInput: HTMLElement | null = null;

  function reposition(): void {
    const btn = state.pauseBtn;
    const badge = state.scoreBadge;
    const input = state.inputEl;
    if (!btn || !input) return;
    positionBtn(btn, input);
    if (!state.active && badge && badge.style.opacity !== '0') positionBadge(badge, input);
    if (state.active) repositionPanel();
  }

  function attachObservers(inputEl: HTMLElement): void {
    if (inputEl === _trackedInput) return;
    _trackedInput = inputEl;
    if (_resizeObs) _resizeObs.disconnect();
    if (window.ResizeObserver) {
      _resizeObs = new ResizeObserver(reposition);
      _resizeObs.observe(inputEl);
      let el = inputEl.parentElement;
      while (el && el !== document.body) {
        const s = window.getComputedStyle(el);
        if (s.overflow !== 'visible' || s.position !== 'static') {
          _resizeObs.observe(el);
          break;
        }
        el = el.parentElement;
      }
    }
    if (_mutationObs) _mutationObs.disconnect();
    _mutationObs = new MutationObserver(() => {
      if (_mutationRaf) return;
      _mutationRaf = requestAnimationFrame(() => {
        _mutationRaf = null;
        if (!_trackedInput || !document.contains(_trackedInput)) tick();
        else reposition();
      });
    });
    _mutationObs.observe(document.body, { childList: true, subtree: true });
  }

  function tick(): void {
    if (_trackedInput && !document.contains(_trackedInput)) {
      _trackedInput = null;
      if (_resizeObs) {
        _resizeObs.disconnect();
        _resizeObs = null;
      }
      if (_mutationObs) {
        _mutationObs.disconnect();
        _mutationObs = null;
      }
      if (!state.active) state.inputEl = null;
    }
    const input = findAIInput();
    const btn = state.pauseBtn;
    const badge = state.scoreBadge;
    if (!btn) return;
    if (input && settings.enabled) {
      if (!state.active) state.inputEl = input;
      if (!_swWarmedUp) {
        _swWarmedUp = true;
        chrome.runtime.sendMessage({ type: 'PING' } satisfies PauseRequest);
      }
      attachObservers(input);
      btn.style.opacity = '0.8';
      btn.style.pointerEvents = 'auto';
      positionBtn(btn, input);
      if (state.active) {
        if (badge) badge.style.opacity = '0';
      } else if (badge) {
        updateScoreBadge(badge, input, scorePrompt(getInputText(input)));
      }
    } else {
      _trackedInput = null;
      if (_resizeObs) {
        _resizeObs.disconnect();
        _resizeObs = null;
      }
      if (_mutationObs) {
        _mutationObs.disconnect();
        _mutationObs = null;
      }
      btn.style.opacity = '0';
      btn.style.pointerEvents = 'none';
      if (badge) badge.style.opacity = '0';
    }
  }

  async function init(): Promise<void> {
    settings = await getSettings();
    onSettingsChanged((s) => {
      settings = s;
      tick();
    });

    state.pauseBtn = createPauseButton();
    state.scoreBadge = createScoreBadge();

    let scoreTimer: ReturnType<typeof setTimeout> | null = null;
    document.addEventListener(
      'input',
      () => {
        if (scoreTimer) clearTimeout(scoreTimer);
        scoreTimer = setTimeout(() => {
          if (state.active || !state.inputEl) return;
          updateScoreBadge(state.scoreBadge, state.inputEl, scorePrompt(getInputText(state.inputEl)));
        }, 350);
      },
      { passive: true, capture: true },
    );

    window.addEventListener('scroll', reposition, { passive: true });
    window.addEventListener('resize', reposition, { passive: true });

    setInterval(() => {
      if (state.active) chrome.runtime.sendMessage({ type: 'PING' } satisfies PauseRequest);
    }, 20000);

    setInterval(tick, 800);
    [100, 300, 800, 1500, 3000].forEach((d) => setTimeout(tick, d));

    // Handoff: consume any pending context targeted at this site.
    consumePendingHandoff();

    // Handoff: watch for this site's rate-limit wall.
    if (settings.handoffEnabled) {
      watchForLimit(getHostname(), () => {
        if (_handoffOffered || state.active) return;
        _handoffOffered = true;
        setTimeout(() => (_handoffOffered = false), 60000); // re-offer at most once/min
        showHandoffCard(initShadow());
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void init());
  } else {
    void init();
  }
}
