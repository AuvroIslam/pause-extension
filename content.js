// Pause Chrome Extension v2 — Content Script
// Injects a ⏸ button into AI chat inputs. On click, shows a floating panel
// above the chatbox with Groq-generated clarifying questions + chip suggestions.

(function () {
  'use strict';

  if (window.__pauseLoaded) return;
  window.__pauseLoaded = true;

  // ─── Model profiles ──────────────────────────────────────────────────────────

  // Model profiles contain concrete formatting rules derived from each platform's
  // official prompting documentation. These are passed to Groq so the improved
  // prompt is structured the way the target model actually responds best to.
  const MODEL_PROFILES = {
    // Source: platform.openai.com/docs/guides/prompt-engineering
    'chatgpt.com': { name: 'ChatGPT (GPT-4o)', profile: 'Apply OpenAI best practices: (1) Open with a role assignment: "You are an expert [role]." (2) Use triple-quote or markdown delimiters to separate instructions from content. (3) State the exact output format (bullet list, numbered steps, JSON, table, prose). (4) Specify length and audience ("in 3 paragraphs", "for a non-technical reader"). (5) For multi-step tasks add "Think step by step" or list the steps explicitly. (6) Prefer active, direct instructions over vague requests.' },
    'chat.openai.com': { name: 'ChatGPT (GPT-4o)', profile: 'Apply OpenAI best practices: (1) Open with a role assignment: "You are an expert [role]." (2) Use triple-quote or markdown delimiters to separate instructions from content. (3) State the exact output format (bullet list, numbered steps, JSON, table, prose). (4) Specify length and audience ("in 3 paragraphs", "for a non-technical reader"). (5) For multi-step tasks add "Think step by step" or list the steps explicitly. (6) Prefer active, direct instructions over vague requests.' },
    // Source: docs.anthropic.com/en/docs/build-with-claude/prompt-engineering
    'claude.ai': { name: 'Claude', profile: 'Apply Anthropic best practices: (1) Wrap distinct sections in XML tags, e.g. <context>…</context> <task>…</task> <format>…</format>. (2) Be direct — state exactly what you want without hinting. (3) Specify explicit constraints: what to include, what to avoid, tone, length. (4) For reasoning tasks prepend "Think through this step by step before answering." (5) Provide a concrete example of the ideal output when format matters.' },
    // Source: ai.google.dev/gemini-api/docs/prompting-strategies (PTCF framework)
    'gemini.google.com': { name: 'Gemini', profile: 'Apply Google PTCF framework: Persona ("You are a…"), Task (clear action verb), Context (background, constraints, audience), Format (bullet list / table / paragraph count / JSON). Be specific about the desired output structure. For complex tasks break into numbered sub-steps. End with the exact format line: "Format your response as [format]."' },
    // Source: x.ai/blog/grok and community-verified patterns
    'grok.com': { name: 'Grok', profile: 'Apply Grok best practices: (1) Ask directly — Grok prefers sharp, opinionated questions over open-ended ones. (2) For real-time topics, include "using the latest available information". (3) Use comparative framing: "Compare X and Y" or "What is the best X for Y use case". (4) Technical depth is welcome — include relevant stack/version details. (5) Avoid filler — every sentence should carry a concrete constraint or requirement.' },
    'x.ai': { name: 'Grok', profile: 'Apply Grok best practices: (1) Ask directly — Grok prefers sharp, opinionated questions over open-ended ones. (2) For real-time topics, include "using the latest available information". (3) Use comparative framing: "Compare X and Y" or "What is the best X for Y use case". (4) Technical depth is welcome — include relevant stack/version details. (5) Avoid filler — every sentence should carry a concrete constraint or requirement.' },
    // Source: docs.perplexity.ai and official blog
    'perplexity.ai': { name: 'Perplexity', profile: 'Apply Perplexity best practices: (1) Scope the search domain explicitly ("in peer-reviewed papers", "on official documentation sites", "from news after 2024"). (2) Ask for citations or sources inline. (3) Use research framing: "Provide an evidence-based summary of…". (4) Specify recency: "as of [year]" or "most recent developments". (5) Comparative and "pros/cons" questions surface Perplexity\'s citation strength best.' },
    // Source: learn.microsoft.com/en-us/copilot/microsoft-365/prompting-tips
    'copilot.microsoft.com': { name: 'Microsoft Copilot', profile: 'Apply Microsoft Copilot best practices: (1) Set clear Goal, Context, Source, Expectation (GCSE structure). (2) Be concise and task-oriented — one clear ask per prompt. (3) Specify output format: action items, email draft, summary table, meeting agenda. (4) Add business context (role, team, deadline) to get work-appropriate output. (5) Reference specific documents or data sources when available.' },
    // Source: docs.mistral.ai/guides/prompting-capabilities
    'chat.mistral.ai': { name: 'Mistral', profile: 'Apply Mistral best practices: (1) Use a clear system-style opener: "You are a [role]. Your task is to [task].". (2) Be unambiguous — Mistral follows instructions literally, so vague wording produces vague output. (3) Specify output format explicitly (JSON schema, markdown table, numbered list, prose paragraphs). (4) For code tasks, state language, version, and style guide. (5) Multilingual instructions are fine — match the language of the desired output.' },
    // Source: poe.com/about and multi-model prompt patterns
    'poe.com': { name: 'Poe', profile: 'Apply Poe multi-model best practices: (1) Make the prompt fully self-contained — no implicit context. (2) State role, task, constraints, and output format explicitly since different underlying models are available. (3) Avoid model-specific syntax (no XML tags, no triple-quote delimiters) to stay portable. (4) Specify the exact output structure with an example if possible. (5) Keep instructions short and unambiguous.' },
  };

  // ─── State ──────────────────────────────────────────────────────────────────

  const state = {
    active:         false,
    inputEl:        null,
    originalText:   '',
    answers:        [],
    currentQ:       0,
    questions:      [],
    improvedPrompt: null,
    modelProfile:   '',
    shadowHost:     null,
    shadow:         null,
    pauseBtn:       null,
    scoreBadge:     null,
  };

  // ─── Input detection ────────────────────────────────────────────────────────

  // Site-specific selectors — ordered from most specific to most generic.
  // ChatGPT:   #prompt-textarea  (ProseMirror div)
  // Claude:    div[data-testid="chat-input"]  (ProseMirror div)
  // Gemini:    div.ql-editor  (Quill — may be inside <rich-textarea> shadow root)
  // Perplexity/Copilot/Mistral/Poe: textarea or generic contenteditable
  const INPUT_SELECTORS = [
    '#prompt-textarea',                                        // ChatGPT
    'div[contenteditable="true"][data-testid="chat-input"]', // Claude
    'div[contenteditable="true"].ProseMirror',               // Claude / ChatGPT fallback
    'div[contenteditable="true"].ql-editor',                 // Gemini (light DOM)
    'div[contenteditable="true"][data-testid]',              // Generic testid
    'div[contenteditable="true"][placeholder]',              // Sites using placeholder attr
    'div[contenteditable="true"]',                           // Generic fallback
    'textarea:not([type="hidden"])',                         // Plain textareas
  ];

  function findAIInput() {
    // Standard DOM traversal
    for (const sel of INPUT_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (isUsableInput(el)) return el;
      }
    }
    // Gemini: <rich-textarea> uses an open shadow root containing the Quill editor
    const richTextarea = document.querySelector('rich-textarea');
    if (richTextarea && richTextarea.shadowRoot) {
      const inner = richTextarea.shadowRoot.querySelector('div[contenteditable="true"]');
      if (inner && isUsableInput(inner)) return inner;
    }
    return null;
  }

  function isUsableInput(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    // Use relaxed thresholds — empty contenteditable divs are often only ~20px tall
    return r.width > 50 && r.height > 10;
  }

  function getInputText(el) {
    if (!el) return '';
    return (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
      ? el.value
      : (el.innerText || el.textContent || '');
  }

  function setInputText(el, text) {
    if (!el) return;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      // For React-controlled textareas, use the native setter to bypass React's
      // value tracking, then fire events so React picks up the change.
      const proto  = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, text);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // contenteditable (ProseMirror on ChatGPT/Claude, Quill on Gemini, etc.)
      // selectAll + insertText fires the native beforeinput/input events that
      // React and ProseMirror both listen to, so the framework state stays in sync.
      document.execCommand('selectAll');
      try {
        document.execCommand('insertText', false, text);
      } catch (_) {
        // Last-resort fallback — won't update React state but at least sets visible text
        el.innerText = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    }
  }

  // ─── Panel positioning ──────────────────────────────────────────────────────

  function findInputContainer(inputEl) {
    const inputRect = inputEl.getBoundingClientRect();
    let el = inputEl.parentElement;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      const pos   = style.position;
      const r     = el.getBoundingClientRect();
      if (
        (pos === 'relative' || pos === 'absolute' || pos === 'sticky' || pos === 'fixed') &&
        r.width >= inputRect.width * 0.85
      ) return el;
      if (style.overflow !== 'visible' && r.width >= inputRect.width * 0.85) return el;
      el = el.parentElement;
    }
    return inputEl;
  }

  function repositionPanel() {
    if (!state.shadowHost) return;
    // Full-screen overlay — the modal is centered via CSS flexbox inside it.
    Object.assign(state.shadowHost.style, {
      position: 'fixed',
      inset:    '0',
      width:    '100%',
      height:   '100%',
      zIndex:   '2147483647',
    });
  }

  // ─── Prompt quality scorer ───────────────────────────────────────────────────
  // Heuristic scorer — no API, instant, runs on every keystroke (debounced).
  // Dimensions: action clarity, specificity, audience, format, constraints,
  // context/background, role framing, examples, technical depth.
  // Returns 0–100.

  function scorePrompt(text) {
    const t = (text || '').trim();
    if (t.length < 5) return 0;
    const lo = t.toLowerCase();
    let score = 0;

    // 1. Length / richness (0–15)
    const len = t.length;
    score += len > 25  ?  3 : 0;
    score += len > 80  ?  4 : 0;
    score += len > 200 ?  4 : 0;
    score += len > 400 ?  4 : 0;

    // 2. Clear action verb (0–10)
    if (/\b(write|build|create|make|explain|summarize|analyze|fix|debug|generate|design|implement|compare|list|describe|draft|plan|review|translate|convert|refactor|optimize|find|suggest|recommend|help me|evaluate|assess|identify)\b/.test(lo)) score += 10;

    // 3. Audience / recipient — expanded to cover email/communication targets (0–10)
    if (/\b(for (a |an |the |my )?(beginner|expert|student|senior|junior|team|client|customer|non.technical|technical|manager|developer|designer|child|adult|supervisor|colleague|boss|professor|recruiter|hiring manager)|audience|reader|recipient|aimed at|targeted at|formal recipient|informal recipient)\b/.test(lo)) score += 10;

    // 4. Output format specified (0–10)
    if (/\b(as a (list|table|json|markdown|bullet|numbered|outline|summary|essay|email|report|paragraph|function|class|script)|in (bullet|table|json|markdown|prose|steps|paragraphs?)|format[: ]|output format|step.by.step|numbered list|bullet point|paragraph form|prose form)\b/.test(lo)) score += 10;

    // 5. Length / size constraint (0–8)
    if (/\b(under|within|max(imum)?|at most|no more than|minimum|at least|exactly|approximately|around|roughly|\d+[\-–]\d+ (words?|sentences?|lines?|paragraphs?|pages?)|\d+ (words?|sentences?|lines?|paragraphs?|pages?)|short|brief|concise|detailed|comprehensive|in depth)\b/.test(lo)) score += 8;

    // 6. Tone / style specified — critical for communication/creative prompts (0–8)
    if (/\b(formal|informal|casual|professional|friendly|apologetic|assertive|empathetic|neutral|persuasive|diplomatic|concise|verbose|technical|simple|humorous|serious|warm|cold|polite|respectful|urgent|enthusiastic|tone should|writing style|in a .{0,20} tone)\b/.test(lo)) score += 8;

    // 7. Role / persona framing (0–8)
    if (/\b(you are (a |an |the |an? )|act as (a |an |the )|as a |assume (you are|the role)|imagine you('?re| are)|pretend|take the role|i('?m| am) a |expert in|specialist in)\b/.test(lo)) score += 8;

    // 8. Context / situation / purpose provided (0–10)
    if (/\b(because|since|currently|i('?m| am) (working|building|trying|writing|unable|sick|ill|away)|context[: ]|background[: ]|situation[: ]|the goal is|trying to|need to|i have|i('?ve| have) already|due to|as a result of|inform(ing)? (him|her|them|you)|unable to (attend|make it|be there)|health issue|personal reason)\b/.test(lo)) score += 10;

    // 9. Structured sections / explicit instructions (0–8)
    // Prompts with labeled sections (Instructions:, Context:, Output:, Format:) are high-quality
    const sectionHeaders = (t.match(/\b(Instructions?|Context|Background|Output( Format)?|Format|Constraints?|Requirements?|Task|Goal|Example|Note|Steps?)[:\n]/g) || []).length;
    score += Math.min(sectionHeaders * 4, 8);

    // 10. Chain-of-thought / reasoning instructions (0–5)
    if (/\b(think step by step|step by step|reason through|think through|let'?s think|before (answering|responding|writing)|first .{0,30} then|chain of thought|work through)\b/.test(lo)) score += 5;

    // 11. Examples or references (0–5)
    if (/\b(for example|e\.g\.|such as|like (this|the following)|similar to|inspired by|based on|following (this|the)|here('?s| is) an example)\b/.test(lo)) score += 5;

    // 12. Technical specificity — stack/tool mentions (0–10)
    const techTerms = (lo.match(/\b(react|next\.?js|vue|angular|svelte|python|javascript|typescript|node\.?js|django|flask|fastapi|java|spring|kotlin|swift|flutter|dart|rust|go(lang)?|c\+\+|c#|\.net|php|laravel|ruby|rails|postgres|mysql|mongodb|redis|docker|kubernetes|aws|gcp|azure|graphql|rest|sql|html|css|tailwind|bootstrap|firebase|supabase)\b/g) || []).length;
    score += Math.min(techTerms * 4, 10);

    // 13. Specificity via proper nouns and numbers (0–6)
    const ignoreWords = new Set(['The','This','That','When','What','How','Why','Who','Where','Which','Please','Write','Create','Build','Make','Help','Can','Should','Would','Could','Instructions','Output','Format','Content','Note','Think','First','Then']);
    const properNouns = (t.match(/\b[A-Z][a-z]{2,}\b/g) || []).filter(w => !ignoreWords.has(w)).length;
    const numbers = (t.match(/\d+/g) || []).length;
    score += Math.min(properNouns * 1.5 + numbers * 1.5, 6);

    // Penalty: very short with no specifics
    if (len < 30 && score < 25) score = Math.max(score - 8, 0);

    return Math.min(Math.round(score), 100);
  }

  function scoreLabel(s) {
    if (s >= 80) return 'Excellent';
    if (s >= 60) return 'Good';
    if (s >= 40) return 'Fair';
    if (s >= 20) return 'Weak';
    return 'Vague';
  }

  // Brand palette: #A80038 red · #FFDB00 yellow · #1C352D green (as bg pill)
  function scoreColor(s) {
    if (s >= 80) return '#4d8c6f';   // visible green derived from #1C352D
    if (s >= 60) return '#7aaa90';
    if (s >= 40) return '#FFDB00';
    if (s >= 20) return '#A80038';
    return '#7a0028';
  }
  function scorePillStyle(s) {
    if (s >= 60) return `background:#1C352D;color:rgba(255,255,255,0.85)`;
    if (s >= 40) return `background:#3a3000;color:#FFDB00`;
    return `background:#3a0018;color:#A80038`;
  }

  // ─── Score badge (lives in page DOM, not shadow) ──────────────────────────

  function createScoreBadge() {
    const badge = document.createElement('div');
    badge.id = '__pause-score-badge';
    Object.assign(badge.style, {
      position: 'fixed', left: '0', top: '0',
      zIndex: '2147483645',
      display: 'flex', alignItems: 'center', gap: '6px',
      padding: '3px 9px 3px 7px', borderRadius: '20px',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      fontSize: '11px', fontWeight: '500', letterSpacing: '0.1px',
      background: 'rgba(20,20,20,0.92)',
      border: '1px solid rgba(255,255,255,0.1)',
      color: 'rgba(255,255,255,0.6)',
      pointerEvents: 'none', opacity: '0',
      transition: 'opacity 0.2s ease',
      whiteSpace: 'nowrap',
      willChange: 'transform',
    });
    document.body.appendChild(badge);
    return badge;
  }

  function updateScoreBadge(badge, inputEl, score) {
    if (!badge || !inputEl || score === 0) {
      if (badge) badge.style.opacity = '0';
      return;
    }
    const r     = inputEl.getBoundingClientRect();
    const color = scoreColor(score);
    const label = scoreLabel(score);
    const fillW = Math.round((score / 100) * 22);
    badge.innerHTML = `
      <svg width="22" height="3" viewBox="0 0 22 3" style="flex-shrink:0;border-radius:2px;overflow:hidden">
        <rect width="22" height="3" fill="rgba(255,255,255,0.08)"/>
        <rect width="${fillW}" height="3" fill="${color}" opacity="0.9"/>
      </svg>
      <span style="color:${color}">${score}%</span>
      <span style="opacity:0.4">${label}</span>
    `;
    positionBadge(badge, inputEl);
    badge.style.opacity = '1';
  }

  // ─── Pause button ───────────────────────────────────────────────────────────

  const BTN_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="4" y="3" width="3" height="10" rx="1.5" fill="rgba(255,255,255,0.9)"/>
    <rect x="9" y="3" width="3" height="10" rx="1.5" fill="rgba(255,255,255,0.9)"/>
  </svg>`;

  function createPauseButton() {
    const btn = document.createElement('div');
    btn.id = '__pause-trigger';
    btn.setAttribute('title', 'Pause — Think before you prompt');
    btn.innerHTML = BTN_SVG;
    Object.assign(btn.style, {
      position: 'fixed',
      left: '0', top: '0',          // anchor — transform does the real positioning
      width: '36px', height: '36px',
      cursor: 'pointer', zIndex: '2147483646',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      borderRadius: '50%',
      background: 'rgba(30,30,30,0.95)',
      border: '1px solid rgba(255,255,255,0.14)',
      transition: 'opacity 0.12s ease, background 0.12s ease',
      opacity: '0', pointerEvents: 'none',
      willChange: 'transform',      // hint compositor to keep this on its own layer
    });
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(40,40,40,0.98)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(20,20,20,0.92)'; });
    btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); triggerPause(); });
    document.body.appendChild(btn);
    return btn;
  }

  const BTN_SIZE = 36;

  function positionBtn(btn, inputEl) {
    if (!btn || !inputEl) return;
    // Use the visual container (pill/rounded box), not the inner editable div
    // which may have large padding causing its r.top to differ from visual top
    const container = findInputContainer(inputEl);
    const r = container.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const BTN_RIGHT_OFFSET = -6;
    const x = Math.round(r.right - BTN_SIZE - BTN_RIGHT_OFFSET);
    const y = Math.round(Math.min(r.bottom - BTN_SIZE - 10, window.innerHeight - BTN_SIZE - 14));
    btn.style.transform = `translate(${x}px,${y}px)`;
  }

  function positionBadge(badge, inputEl) {
    if (!badge || !inputEl) return;
    const container = findInputContainer(inputEl);
    const r = container.getBoundingClientRect();
    if (r.width === 0) return;
    const BADGE_LEFT_OFFSET = -4;
    const x = Math.round(r.left + BADGE_LEFT_OFFSET);
    // Always just above the visual container top, clamped to viewport
    const y = Math.round(Math.max(r.top - 40, 8));
    badge.style.left      = '0';
    badge.style.top       = '0';
    badge.style.right     = 'auto';
    badge.style.bottom    = 'auto';
    badge.style.transform = `translate(${x}px,${y}px)`;
  }

  // ─── Shadow DOM ─────────────────────────────────────────────────────────────

  const PANEL_CSS = `
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}

    /* ── Layout ── */
    .overlay{
      position:fixed;inset:0;
      background:rgba(0,0,0,0.6);
      display:flex;align-items:center;justify-content:center;
      animation:fadeIn .12s ease;
    }
    .panel{
      background:#111;
      border:1px solid rgba(255,255,255,0.08);
      border-radius:14px;
      width:90%;max-width:540px;max-height:86vh;
      display:flex;flex-direction:column;overflow:hidden;
      animation:slideUp .14s ease;
      box-shadow:0 0 0 1px rgba(255,255,255,0.04) inset,0 24px 64px rgba(0,0,0,0.8);
    }

    /* ── Animations ── */
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

    /* ── Inline button spinner ── */
    .btn-spin{
      display:inline-block;width:12px;height:12px;border-radius:50%;flex-shrink:0;
      border:1.5px solid rgba(0,0,0,0.25);border-top-color:#000;
      animation:spin .6s linear infinite;
    }
    .btn-ghost .btn-spin,.btn-spin.light{border-color:rgba(255,255,255,0.15);border-top-color:rgba(255,255,255,0.75)}

    /* ── Header ── */
    .hdr{
      padding:13px 16px 11px;
      border-bottom:1px solid rgba(255,255,255,0.05);
      display:flex;align-items:center;justify-content:space-between;
      flex-shrink:0;
    }
    .logo{display:flex;align-items:center;gap:8px}
    .logo-mark{
      width:22px;height:22px;
      background:rgba(255,255,255,0.06);
      border:1px solid rgba(255,255,255,0.1);
      border-radius:6px;
      display:flex;align-items:center;justify-content:center;
    }
    .logo-name{font-size:13px;font-weight:600;color:rgba(255,255,255,0.9);letter-spacing:-.1px}
    .logo-sub{font-size:10px;color:rgba(255,255,255,0.3);letter-spacing:.5px;text-transform:uppercase;margin-top:1px}
    .hdr-right{display:flex;align-items:center;gap:8px}
    .q-counter{font-size:11px;color:rgba(255,255,255,0.25);letter-spacing:.2px}
    .close-btn{
      width:24px;height:24px;
      background:transparent;border:none;border-radius:6px;
      color:rgba(255,255,255,0.3);cursor:pointer;
      display:flex;align-items:center;justify-content:center;
      font-size:13px;transition:color .1s,background .1s;
    }
    .close-btn:hover{background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.8)}

    /* ── Progress ── */
    .prog-track{height:1px;background:rgba(255,255,255,0.05);flex-shrink:0}
    .prog-fill{height:100%;background:rgba(255,255,255,0.5);transition:width .3s ease}

    /* ── Body ── */
    .body{padding:18px 16px;flex:1;overflow-y:auto}

    /* ── Loading ── */
    .loading-body{
      display:flex;flex-direction:column;align-items:center;
      justify-content:center;gap:14px;padding:48px 16px;
    }
    .loading-dots{display:flex;gap:6px;align-items:center}
    .loading-dot{
      width:6px;height:6px;border-radius:50%;
      background:rgba(255,255,255,0.5);
    }
    .loading-dot:nth-child(1){animation:pulse 1.1s ease-in-out infinite 0s}
    .loading-dot:nth-child(2){animation:pulse 1.1s ease-in-out infinite .18s}
    .loading-dot:nth-child(3){animation:pulse 1.1s ease-in-out infinite .36s}
    .loading-msg{font-size:13px;color:rgba(255,255,255,0.35);letter-spacing:.1px}

    /* ── Key entry ── */
    .key-title{font-size:15px;font-weight:600;color:rgba(255,255,255,0.9);margin-bottom:6px}
    .key-desc{font-size:12.5px;color:rgba(255,255,255,0.35);line-height:1.6;margin-bottom:16px}
    .key-input{
      width:100%;background:rgba(255,255,255,0.04);
      border:1px solid rgba(255,255,255,0.09);border-radius:9px;
      padding:10px 12px;color:rgba(255,255,255,0.9);font-size:13px;font-family:inherit;
      outline:none;transition:border-color .15s;letter-spacing:.5px;
    }
    .key-input:focus{border-color:rgba(255,255,255,0.3)}
    .key-input::placeholder{color:rgba(255,255,255,0.18);letter-spacing:0}
    .key-link{display:inline-block;font-size:12px;color:rgba(255,255,255,0.35);text-decoration:none;margin-top:10px;transition:color .15s}
    .key-link:hover{color:rgba(255,255,255,0.7)}

    /* ── Question ── */
    .q-text{
      font-size:17px;font-weight:600;color:rgba(255,255,255,0.92);
      line-height:1.45;letter-spacing:-.2px;margin-bottom:16px;
    }
    .multi-hint{font-size:11px;color:rgba(255,255,255,0.3);margin-bottom:10px;margin-top:-10px}
    .chips-row{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px}
    .chip{
      padding:7px 15px;border-radius:20px;font-size:12.5px;font-weight:500;
      background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);
      color:rgba(255,255,255,0.5);cursor:pointer;
      transition:background .1s,border-color .1s,color .1s;
      font-family:inherit;white-space:nowrap;user-select:none;
      min-height:36px;display:inline-flex;align-items:center;
    }
    .chip:hover{background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.85);border-color:rgba(255,255,255,0.2)}
    .chip:active{background:rgba(255,255,255,0.07)}
    .chip.on{
      background:rgba(255,255,255,0.12);
      border-color:rgba(255,255,255,0.4);
      color:rgba(255,255,255,0.95);
    }
    .chip.on::before{content:none}
    .ans-box{
      width:100%;background:rgba(255,255,255,0.03);
      border:1px solid rgba(255,255,255,0.08);border-radius:10px;
      padding:11px 13px;color:rgba(255,255,255,0.85);font-size:13px;font-family:inherit;
      resize:none;min-height:72px;outline:none;line-height:1.6;
      transition:border-color .15s,background .15s;
    }
    .ans-box:focus{border-color:rgba(255,255,255,0.22);background:rgba(255,255,255,0.05)}
    .ans-box::placeholder{color:rgba(255,255,255,0.2)}

    /* ── Results ── */
    .res-score-row{
      display:flex;align-items:center;justify-content:center;gap:24px;
      padding:22px 16px;margin-bottom:16px;
      background:rgba(255,255,255,0.02);
      border:1px solid rgba(255,255,255,0.07);border-radius:14px;
    }
    .res-circle-svg{display:block;flex-shrink:0}
    .res-arrow{font-size:22px;font-weight:300;color:rgba(255,255,255,0.5);flex-shrink:0;line-height:1}
    .res-section-lbl{
      font-size:10px;letter-spacing:.8px;text-transform:uppercase;
      color:rgba(255,255,255,0.28);font-weight:500;margin-bottom:6px;
    }
    .result-box{
      background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);
      border-radius:9px;padding:11px 13px;
      font-size:12.5px;color:rgba(255,255,255,0.4);line-height:1.65;
      white-space:pre-wrap;word-break:break-word;
      max-height:110px;overflow-y:auto;
    }
    .after-box{
      border-color:rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);
      color:rgba(255,255,255,0.82);max-height:200px;margin-bottom:10px;
    }
    .res-before-toggle{margin-top:0;display:block}
    .res-before-summary{
      font-size:10px;color:rgba(255,255,255,0.28);cursor:pointer;
      list-style:none;padding:0 0 8px 0;letter-spacing:.8px;text-transform:uppercase;font-weight:500;
      user-select:none;display:flex;align-items:center;gap:5px;
      width:100%;transition:color .15s;
    }
    .res-before-summary::before{content:'›';font-size:14px;font-weight:600;opacity:0.7;line-height:1;display:block;flex-shrink:0;transform:translateY(-2px);transition:transform .2s ease}
    details[open] .res-before-summary::before{transform:translateY(1px) rotate(90deg)}
    .res-before-summary:hover{color:rgba(255,255,255,0.55)}
    .res-before-summary::-webkit-details-marker{display:none}

    /* ── Error ── */
    .error-body{text-align:center;padding:32px 16px}
    .error-icon{font-size:24px;margin-bottom:10px}
    .error-title{font-size:14px;font-weight:600;color:rgba(255,255,255,0.85);margin-bottom:6px}
    .error-msg{font-size:12px;color:rgba(255,255,255,0.35);line-height:1.6;margin-bottom:20px}

    /* ── Footer ── */
    .ftr{
      padding:12px 16px 14px;
      border-top:1px solid rgba(255,255,255,0.05);
      display:flex;align-items:center;justify-content:space-between;
      flex-shrink:0;gap:8px;
    }
    .ftr-left{display:flex;gap:6px}
    .ftr-right{display:flex;gap:6px}

    /* ── Buttons ── */
    .btn{
      padding:8px 18px;border-radius:8px;font-size:13px;font-weight:500;
      cursor:pointer;font-family:inherit;
      transition:background .1s,opacity .1s,transform .1s;
      min-height:36px;display:inline-flex;align-items:center;gap:6px;
      letter-spacing:-.1px;
    }
    .btn-ghost{
      background:rgba(255,255,255,0.05);
      border:1px solid rgba(255,255,255,0.09);
      color:rgba(255,255,255,0.45);
    }
    .btn-ghost:hover{background:rgba(255,255,255,0.09);color:rgba(255,255,255,0.8);border-color:rgba(255,255,255,0.16)}
    .btn-ghost:active{background:rgba(255,255,255,0.06);transform:scale(0.98)}
    .btn-primary{
      background:#fff;border:none;
      color:#000;font-weight:600;font-size:13px;
      padding:9px 22px;
    }
    .btn-primary:hover{background:rgba(255,255,255,0.88)}
    .btn-primary:active{background:rgba(255,255,255,0.75);transform:scale(0.98)}
    .btn-primary:disabled{opacity:0.5;cursor:default;transform:none}

    /* ── Scrollbar ── */
    ::-webkit-scrollbar{width:3px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:2px}
  `;

  const LOGO_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <rect x="2" y="1" width="3" height="10" rx="1.5" fill="rgba(255,255,255,0.7)"/>
    <rect x="7" y="1" width="3" height="10" rx="1.5" fill="rgba(255,255,255,0.7)"/>
  </svg>`;

  function initShadow() {
    if (state.shadow) return state.shadow;
    const host = document.createElement('div');
    host.id = '__pause-root';
    document.body.appendChild(host);

    // Block keyboard/pointer events from reaching the host page's listeners
    ['keydown','keyup','keypress','input','compositionstart','compositionend'].forEach((t) => {
      host.addEventListener(t, (e) => e.stopPropagation());
    });
    ['mousedown','mouseup','click','pointerdown','pointerup'].forEach((t) => {
      host.addEventListener(t, (e) => e.stopPropagation());
    });

    const shadow = host.attachShadow({ mode: 'open' });
    const style  = document.createElement('style');
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);
    state.shadowHost = host;
    state.shadow     = shadow;
    return shadow;
  }

  // ─── Persistent panel shell ──────────────────────────────────────────────────
  // The overlay, panel, header and progress bar are created ONCE and never removed.
  // Only the body and footer content swap — this eliminates all flicker and the
  // heavy "loading → question → loading → question" navigation feel.

  let _panelShell = null; // { overlay, panel, prog, hdr, body, ftr }

  function ensureShell(shadow) {
    if (_panelShell) return _panelShell;

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closePause(); });

    const panel = document.createElement('div');
    panel.className = 'panel';

    const prog = document.createElement('div');
    prog.className = 'prog-track';
    prog.innerHTML = '<div class="prog-fill" id="p-prog-fill" style="width:0%"></div>';

    const hdr = document.createElement('div');
    hdr.id = 'p-shell-hdr';

    const body = document.createElement('div');
    body.className = 'body';
    body.id = 'p-shell-body';

    const ftr = document.createElement('div');
    ftr.className = 'ftr';
    ftr.id = 'p-shell-ftr';

    panel.appendChild(prog);
    panel.appendChild(hdr);
    panel.appendChild(body);
    panel.appendChild(ftr);
    overlay.appendChild(panel);
    shadow.appendChild(overlay);

    _panelShell = { overlay, panel, prog, hdr, body, ftr };
    return _panelShell;
  }

  function setProgress(pct) {
    const fill = _panelShell && _panelShell.prog.querySelector('#p-prog-fill');
    if (fill) fill.style.width = pct + '%';
  }

  function setHeader(subtitle, counterText) {
    if (!_panelShell) return;
    _panelShell.hdr.innerHTML = `
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
    const closeBtn = _panelShell.hdr.querySelector('#p-close');
    if (closeBtn) closeBtn.onclick = closePause;
  }

  // Swaps body content with a fast 80ms crossfade — panel shell never moves.
  // When body is empty (first render) the fade is skipped so content appears instantly.
  function setBody(html, onReady) {
    if (!_panelShell) return;
    const body = _panelShell.body;
    if (!body.innerHTML.trim()) {
      body.innerHTML = html;
      body.style.opacity = '1';
      if (onReady) onReady();
      return;
    }
    body.style.transition = 'opacity 0.06s ease';
    body.style.opacity = '0';
    setTimeout(() => {
      body.innerHTML = html;
      body.style.opacity = '1';
      if (onReady) onReady();
    }, 60);
  }

  function setFooter(html, onReady) {
    if (!_panelShell) return;
    const ftr = _panelShell.ftr;
    ftr.innerHTML = html;
    ftr.style.display = html ? 'flex' : 'none';
    if (onReady) onReady();
  }

  function showShell(shadow) {
    ensureShell(shadow);
    _panelShell.overlay.style.display = 'flex';
  }

  function hideShell() {
    if (!_panelShell) return;
    const overlay = _panelShell.overlay;
    _panelShell = null; // clear immediately so new opens don't reuse this shell
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 160);
  }

  function clearPanel(shadow) {
    hideShell();
    // Remove any leftover non-style children (e.g. from previous sessions)
    setTimeout(() => {
      [...shadow.children].forEach((c) => { if (c.tagName !== 'STYLE') c.remove(); });
    }, 160);
  }

  function escHtml(t) {
    return String(t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Message passing ─────────────────────────────────────────────────────────

  function sendToBackground(type, payload, timeoutMs = 20000) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (val) => { if (!settled) { settled = true; resolve(val); } };

      // Hard timeout — if service worker restarts mid-call (MV3 idle termination)
      // the message port closes silently and the callback never fires.
      const timer = setTimeout(() => done({ ok: false, error: 'TIMEOUT' }), timeoutMs);

      try {
        chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || '';
            const code = msg.toLowerCase().includes('message port closed') ? 'SW_TERMINATED' : 'EXTENSION_ERROR';
            done({ ok: false, error: code });
          } else {
            done(resp || { ok: false, error: 'NO_RESPONSE' });
          }
        });
      } catch (e) {
        clearTimeout(timer);
        done({ ok: false, error: 'EXTENSION_ERROR' });
      }
    });
  }

  // ─── Model profile ───────────────────────────────────────────────────────────

  function getHostname() {
    return window.location.hostname.replace(/^www\./, '');
  }

  async function ensureModelProfile() {
    const hostname = getHostname();
    const profileData = MODEL_PROFILES[hostname] || { name: 'AI Assistant', profile: 'Write a clear, well-structured, specific prompt. Include context, desired format, and intended audience.' };
    await sendToBackground('GET_OR_SET_MODEL_PROFILE', { hostname, profileData });
    return profileData.profile;
  }

  // ─── Answer block ────────────────────────────────────────────────────────────

  function buildAnswersBlock(questions, answers) {
    const filled = questions
      .map((q, i) => {
        const raw = (answers[i] || '').trim();
        const answer = raw === '__skip__' ? '(choose the most suitable option based on context)' : raw;
        return { question: q.text, answer };
      })
      .filter(({ answer }) => answer.length > 0);
    if (filled.length === 0) return '(No clarifying answers provided.)';
    return filled.map(({ question, answer }) => `Question: ${question}\nAnswer: ${answer}`).join('\n\n');
  }

  // ─── Screens — all use persistent shell, only body/footer swap ───────────────

  const LOADING_DOTS = `<div class="loading-dots">
    <div class="loading-dot"></div>
    <div class="loading-dot"></div>
    <div class="loading-dot"></div>
  </div>`;

  function showKeyEntry(shadow) {
    showShell(shadow);
    setHeader('Connect API', '');
    setProgress(0);
    setBody(`
      <div class="key-title">Connect Groq API</div>
      <div class="key-desc">Paste your free Groq API key to enable AI-powered questions. Stored locally, never shared.</div>
      <input class="key-input" id="p-key" type="password" placeholder="gsk_…" autocomplete="off" spellcheck="false"/>
      <a class="key-link" href="https://console.groq.com/keys" target="_blank" rel="noopener">Get a free key →</a>
    `, () => {
      const input = shadow.getElementById('p-key');
      setTimeout(() => input && input.focus(), 60);
      input && input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') shadow.getElementById('p-key-save') && shadow.getElementById('p-key-save').click();
        if (e.key === 'Escape') closePause();
      });
    });
    setFooter(`
      <div class="ftr-left"></div>
      <div class="ftr-right">
        <button class="btn btn-ghost" id="p-cancel">Cancel</button>
        <button class="btn btn-primary" id="p-key-save">Save & Continue</button>
      </div>
    `, () => {
      shadow.getElementById('p-cancel').onclick = closePause;
      shadow.getElementById('p-key-save').onclick = async () => {
        const input = shadow.getElementById('p-key');
        const key = (input && input.value || '').trim();
        if (!key) { input && input.focus(); return; }
        await sendToBackground('SAVE_API_KEY', { key });
        startQuestionFlow(shadow);
      };
    });
  }

  function showLoading(shadow, message) {
    showShell(shadow);
    setHeader('thinking…', '');
    setBody(`<div class="loading-body">${LOADING_DOTS}<div class="loading-msg">${escHtml(message)}</div></div>`);
    setFooter('');
  }

  function showQuestions(shadow) {
    const qs  = state.questions;
    const qi  = state.currentQ;
    const q   = qs[qi];
    const totalKnown = state.questions.length;
    const pct = Math.min(((qi + 1) / Math.max(totalKnown, 4)) * 95, 95);
    const prev = state.answers[qi] || '';

    showShell(shadow);
    setHeader('Think first', `Question ${qi + 1}`);
    setProgress(pct);

    setBody(`
      <div class="q-text">${escHtml(q.text)}</div>
      ${q.multiSelect ? '<p class="multi-hint">Select all that apply</p>' : ''}
      <div class="chips-row" id="p-chips">
        ${q.suggestions.map(s => `<button class="chip">${escHtml(s)}</button>`).join('')}
      </div>
      <textarea class="ans-box" id="p-ans" placeholder="Or type your own answer…">${escHtml(prev)}</textarea>
    `, () => {
      const body    = _panelShell.body;
      const chipsRow = body.querySelector('#p-chips');
      const ansBox   = body.querySelector('#p-ans');
      const isMulti  = !!q.multiSelect;

      function chipText(c) { return c.textContent.replace(/^✓\s*/, '').trim(); }
      function selectedChipsText() {
        return [...chipsRow.querySelectorAll('.chip.on')].map(chipText).join(', ');
      }

      if (prev) {
        const parts = isMulti ? prev.split(',').map(s => s.trim()) : [prev.trim()];
        chipsRow.querySelectorAll('.chip').forEach(c => {
          if (parts.includes(chipText(c))) c.classList.add('on');
        });
      }

      // mousedown fires before click — gives instant visual response
      chipsRow.addEventListener('mousedown', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        if (isMulti) {
          chip.classList.toggle('on');
          ansBox.value = selectedChipsText();
        } else {
          const on = chip.classList.contains('on');
          chipsRow.querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
          if (!on) { chip.classList.add('on'); ansBox.value = chipText(chip); }
          else ansBox.value = '';
        }
      });
      // click handler just refocuses textarea (mousedown handled state already)
      chipsRow.addEventListener('click', (e) => {
        if (e.target.closest('.chip')) ansBox.focus();
      });

      ansBox.addEventListener('input', () => {
        if (!isMulti) chipsRow.querySelectorAll('.chip').forEach(c =>
          c.classList.toggle('on', chipText(c) === ansBox.value));
      });

      setTimeout(() => ansBox && ansBox.focus(), 60);

      let fgTimer = null;
      ansBox.addEventListener('focusout', (e) => {
        if (state.active && !e.relatedTarget) fgTimer = setTimeout(() => ansBox && ansBox.focus(), 50);
      });
      chipsRow.addEventListener('mousedown', () => clearTimeout(fgTimer), true);

      ansBox.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (isMulti && !e.ctrlKey && !e.metaKey) return;
          if (!e.shiftKey) { e.preventDefault(); advanceQuestion(shadow, ansBox.value); }
        }
        if (e.key === 'Escape') closePause();
      });
    });

    setFooter(`
      <div class="ftr-left">
        ${qi > 0 ? '<button class="btn btn-ghost" id="p-back">Back</button>' : '<span></span>'}
      </div>
      <div class="ftr-right">
        <button class="btn btn-ghost" id="p-skip">Skip</button>
        <button class="btn btn-primary" id="p-next">Next</button>
      </div>
    `, () => {
      const ftr = _panelShell.ftr;
      ftr.querySelector('#p-next').onclick = () => {
        const box = _panelShell.body.querySelector('#p-ans');
        const ans = (box || {}).value || '';
        if (!ans.trim()) {
          if (box) { box.focus(); box.classList.add('shake'); setTimeout(() => box.classList.remove('shake'), 400); }
          return;
        }
        advanceQuestion(shadow, ans);
      };
      ftr.querySelector('#p-skip').onclick = () => advanceQuestion(shadow, '__skip__');
      const back = ftr.querySelector('#p-back');
      if (back) back.onclick = () => {
        state.currentQ--;
        state.questions = state.questions.slice(0, state.currentQ + 1);
        state.answers   = state.answers.slice(0, state.currentQ + 1);
        showQuestions(shadow);
      };
    });
  }

  // Sets the Next button into a loading state — no full-screen transition, panel stays put
  function setNextLoading() {
    if (!_panelShell) return;
    const nextBtn = _panelShell.ftr.querySelector('#p-next');
    const skipBtn = _panelShell.ftr.querySelector('#p-skip');
    const backBtn = _panelShell.ftr.querySelector('#p-back');
    if (nextBtn) { nextBtn.style.minWidth = nextBtn.offsetWidth + 'px'; nextBtn.disabled = true; nextBtn.innerHTML = '<span class="btn-spin light"></span>&nbsp;Thinking…'; nextBtn.style.opacity = '0.7'; }
    if (skipBtn) { skipBtn.disabled = true; skipBtn.style.opacity = '0.4'; }
    if (backBtn) { backBtn.disabled = true; backBtn.style.opacity = '0.4'; }
  }

  function advanceQuestion(shadow, rawAnswer) {
    state.answers[state.currentQ] = rawAnswer.trim();
    const MAX_QUESTIONS = 5;
    if (state.questions.length < MAX_QUESTIONS) {
      setNextLoading(); // keep panel, just disable buttons + show spinner in Next
      fetchNextQuestion(shadow);
    } else {
      buildImprovedPrompt(shadow);
    }
  }

  async function buildImprovedPrompt(shadow, attempt = 0) {
    showLoading(shadow, 'Building your improved prompt…');
    const answersBlock = buildAnswersBlock(state.questions, state.answers);
    const resp = await sendToBackground('GROQ_BUILD_IMPROVED_PROMPT', {
      originalText:   state.originalText,
      answersBlock,
      modelProfile:   state.modelProfile,
      answeredCount:  state.answers.filter(a => a && a.trim()).length,
      totalQuestions: state.questions.length,
    });
    if (!resp.ok) {
      if (resp.error === 'SW_TERMINATED' && attempt < 2) {
        await new Promise(r => setTimeout(r, 600));
        return buildImprovedPrompt(shadow, attempt + 1);
      }
      showError(shadow, resp.error, () => buildImprovedPrompt(shadow));
      return;
    }
    state.improvedPrompt = resp.improvedPrompt;
    showResults(shadow);
  }

  // — Results screen —
  function showResults(shadow) {
    const orig     = state.originalText.trim() || '(empty)';
    const improved = state.improvedPrompt || orig;

    const scoreBefore = scorePrompt(orig);
    const scoreAfter  = scorePrompt(improved);


    // SVG circle ring helper
    const SVG_R = 38;
    const SVG_C = +(2 * Math.PI * SVG_R).toFixed(2);
    const circleSvg = (score, color, label) => {
      const offset = +(SVG_C * (1 - score / 100)).toFixed(2);
      const ff = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
      const id = `cl${Math.random().toString(36).slice(2,7)}`;
      return `<svg class="res-circle-svg" viewBox="0 0 100 100" width="90" height="90">`
        + `<defs><clipPath id="${id}"><path d="M50,${50-SVG_R-8} A${SVG_R+8},${SVG_R+8} 0 1,1 ${50-0.001},${50-SVG_R-8} Z"/></clipPath></defs>`
        + `<circle cx="50" cy="50" r="${SVG_R}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="6"/>`
        + `<circle cx="50" cy="50" r="${SVG_R}" fill="none" stroke="${color}" stroke-width="6"`
        + ` stroke-dasharray="${SVG_C}" stroke-dashoffset="${offset}"`
        + ` stroke-linecap="round" transform="rotate(-90 50 50)"`
        + ` style="filter:drop-shadow(0 0 6px ${color}bb)" clip-path="url(#${id})"/>`
        + `<text x="50" y="48" dominant-baseline="middle" text-anchor="middle" font-size="22" font-weight="700" fill="${color}" font-family="${ff}">${score}%</text>`
        + `<text x="50" y="65" text-anchor="middle" font-size="8" fill="rgba(255,255,255,0.65)" font-family="${ff}" letter-spacing="1.5">${label}</text>`
        + `</svg>`;
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
      <div class="result-box after-box" id="p-improved">${escHtml(improved)}</div>
    `);

    // Replace + Copy always visible in footer — never need to scroll
    setFooter(`
      <div class="ftr-left">
        <button class="btn btn-ghost" id="p-redo">Redo</button>
      </div>
      <div class="ftr-right">
        <button class="btn btn-ghost" id="p-copy">Copy</button>
        <button class="btn btn-primary" id="p-replace">Use this prompt</button>
      </div>
    `, () => {
      _panelShell.ftr.querySelector('#p-replace').onclick = () => {
        setInputText(state.inputEl, improved);
        closePause();
      };
      _panelShell.ftr.querySelector('#p-copy').onclick = () => {
        navigator.clipboard.writeText(improved).catch(() => {});
        const b = _panelShell.ftr.querySelector('#p-copy');
        if (b) { b.textContent = 'Copied!'; setTimeout(() => { b.textContent = 'Copy'; }, 2000); }
      };
      _panelShell.ftr.querySelector('#p-redo').onclick = () => {
        state.answers   = [];
        state.questions = [];
        state.currentQ  = 0;
        startQuestionFlow(shadow);
      };
    });
  }

  // — Error screen —
  const ERROR_MESSAGES = {
    RATE_LIMIT:      'All AI providers are rate-limited right now. Wait a moment and try again.',
    TIMEOUT:         'Request timed out. Check your internet connection.',
    NETWORK:         'No internet connection detected.',
    BAD_RESPONSE:    'Unexpected AI response. Try again.',
    SERVER_ERROR:    'AI service error. All providers failed. Try again shortly.',
    SW_TERMINATED:   'Extension restarted mid-request. Please try again.',
    EXTENSION_ERROR: 'Extension error. Try refreshing the page.',
  };

  function showError(shadow, errorCode, onRetry) {
    const isKeyError = errorCode === 'INVALID_KEY' || errorCode === 'NO_KEY';
    const msg = ERROR_MESSAGES[errorCode] || `Something went wrong (${errorCode}).`;

    showShell(shadow);
    setHeader('Paused', '');
    setProgress(0);

    setBody(`
      <div class="error-body">
        <div class="error-icon">⚠️</div>
        <div class="error-title">Couldn't continue</div>
        <div class="error-msg">${escHtml(msg)}</div>
      </div>
    `);

    setFooter(`
      <div class="ftr-left"></div>
      <div class="ftr-right">
        <button class="btn btn-ghost" id="p-dismiss">Dismiss</button>
        <button class="btn btn-primary" id="p-action">
          ${isKeyError ? 'Re-enter API key' : 'Try again'}
        </button>
      </div>
    `, () => {
      _panelShell.ftr.querySelector('#p-dismiss').onclick = closePause;
      _panelShell.ftr.querySelector('#p-action').onclick = () => {
        if (isKeyError) showKeyEntry(shadow);
        else if (onRetry) onRetry();
        else triggerPause();
      };
    });
  }

  // ─── Main flow ──────────────────────────────────────────────────────────────

  async function startQuestionFlow(shadow) {
    showLoading(shadow, 'Thinking about your prompt…');

    const profile = await ensureModelProfile();
    state.modelProfile = profile;
    state.questions    = [];
    state.answers      = [];
    state.currentQ     = 0;

    await fetchNextQuestion(shadow);
  }

  // Fetches the next adaptive question from background, informed by all previous Q&A.
  // If the model signals done (or we hit max 5), goes straight to building the prompt.
  async function fetchNextQuestion(shadow, attempt = 0) {
    const previousQA = state.questions.map((q, i) => ({
      question: q.text,
      answer:   (state.answers[i] || '').trim(),
    }));

    const resp = await sendToBackground('GROQ_NEXT_QUESTION', {
      promptText:    state.originalText,
      modelProfile:  state.modelProfile,
      previousQA,
      questionIndex: state.questions.length,
    });

    if (!resp.ok) {
      // SW_TERMINATED means the service worker was idle and just woke up — retry once automatically
      if (resp.error === 'SW_TERMINATED' && attempt < 2) {
        await new Promise(r => setTimeout(r, 600));
        return fetchNextQuestion(shadow, attempt + 1);
      }
      showError(shadow, resp.error, () => fetchNextQuestion(shadow));
      return;
    }

    if (resp.done) {
      // Model decided no more questions needed — build prompt with what we have
      buildImprovedPrompt(shadow);
      return;
    }

    state.questions.push(resp.question);
    state.currentQ = state.questions.length - 1;
    showQuestions(shadow);
  }

  function triggerPause() {
    if (state.active) return;
    const inputEl = state.inputEl || findAIInput();
    if (!inputEl) return;

    const text = getInputText(inputEl);
    if (text.trim().length < 3) {
      // Not enough text to work with — briefly change button tooltip
      if (state.pauseBtn) {
        state.pauseBtn.setAttribute('title', 'Type something first!');
        setTimeout(() => state.pauseBtn && state.pauseBtn.setAttribute('title', 'Pause — Think before you prompt'), 2000);
      }
      return;
    }

    state.inputEl        = inputEl;
    state.originalText   = text;
    state.active         = true;
    state.answers        = [];
    state.questions      = [];
    state.currentQ       = 0;
    state.improvedPrompt = null;

    const shadow = initShadow();
    repositionPanel();
    startQuestionFlow(shadow);
  }

  function closePause() {
    state.active         = false;
    state.answers        = [];
    state.questions      = [];
    state.currentQ       = 0;
    state.improvedPrompt = null;
    if (state.shadow) clearPanel(state.shadow);
    if (state.shadowHost) Object.assign(state.shadowHost.style, { width: '0', height: '0' });
    // Re-score immediately after close so badge reflects any replaced prompt
    setTimeout(() => {
      if (state.active || !state.inputEl || !state.scoreBadge) return;
      const score = scorePrompt(getInputText(state.inputEl));
      updateScoreBadge(state.scoreBadge, state.inputEl, score);
    }, 200);
  }

  // ─── Grammarly-style positioning system ─────────────────────────────────────
  // Positioning is driven by events, not a poll loop.
  // ResizeObserver fires when the input or any ancestor resizes.
  // MutationObserver fires when the page DOM shifts (SPA navigation, layout changes).
  // scroll + resize events cover the rest.
  // The slow tick() only exists to catch the initial input detection.

  let _swWarmedUp   = false;
  let _resizeObs    = null;
  let _mutationObs  = null;
  let _trackedInput = null;

  function reposition() {
    const btn   = state.pauseBtn;
    const badge = state.scoreBadge;
    const input = state.inputEl;
    if (!btn || !input) return;
    positionBtn(btn, input);
    if (!state.active && badge && badge.style.opacity !== '0') {
      positionBadge(badge, input);
    }
    if (state.active) repositionPanel();
  }

  function attachObservers(inputEl) {
    if (inputEl === _trackedInput) return; // already watching this element
    _trackedInput = inputEl;

    // ResizeObserver: fires immediately when the input or its scroll container resizes
    if (_resizeObs) _resizeObs.disconnect();
    if (window.ResizeObserver) {
      _resizeObs = new ResizeObserver(reposition);
      _resizeObs.observe(inputEl);
      // Also observe the nearest scrollable ancestor (catches flex/grid reflows)
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

    // MutationObserver: catches SPA route changes and DOM-injected layout shifts
    if (_mutationObs) _mutationObs.disconnect();
    _mutationObs = new MutationObserver(reposition);
    _mutationObs.observe(document.body, { childList: true, subtree: false, attributes: false });
  }

  function tick() {
    const input = findAIInput();
    const btn   = state.pauseBtn;
    const badge = state.scoreBadge;
    if (!btn) return;

    if (input) {
      if (!state.active) state.inputEl = input;

      if (!_swWarmedUp) {
        _swWarmedUp = true;
        chrome.runtime.sendMessage({ type: 'PING' });
        ensureModelProfile().catch(() => {});
      }

      attachObservers(input); // no-op if already watching

      btn.style.opacity       = '0.8';
      btn.style.pointerEvents = 'auto';
      positionBtn(btn, input);

      if (state.active) {
        if (badge) badge.style.opacity = '0';
      } else if (badge) {
        const score = scorePrompt(getInputText(input));
        updateScoreBadge(badge, input, score);
      }
    } else {
      _trackedInput = null;
      if (_resizeObs)   { _resizeObs.disconnect();   _resizeObs   = null; }
      if (_mutationObs) { _mutationObs.disconnect();  _mutationObs = null; }
      btn.style.opacity       = '0';
      btn.style.pointerEvents = 'none';
      if (badge) badge.style.opacity = '0';
    }
  }

  function init() {
    state.pauseBtn   = createPauseButton();
    state.scoreBadge = createScoreBadge();

    // Score badge updates on every keystroke (debounced 350ms)
    let scoreTimer = null;
    document.addEventListener('input', () => {
      clearTimeout(scoreTimer);
      scoreTimer = setTimeout(() => {
        if (state.active || !state.inputEl) return;
        updateScoreBadge(state.scoreBadge, state.inputEl, scorePrompt(getInputText(state.inputEl)));
      }, 350);
    }, { passive: true, capture: true });

    // Reposition immediately on scroll/resize (transform makes this virtually free)
    window.addEventListener('scroll',  reposition, { passive: true });
    window.addEventListener('resize',  reposition, { passive: true });

    // Keepalive: reset MV3 service worker idle timer every 20s while panel is open
    setInterval(() => { if (state.active) chrome.runtime.sendMessage({ type: 'PING' }); }, 20000);

    // Slow tick: only needed for initial input detection and SPA navigation
    setInterval(tick, 800);
    setTimeout(tick, 300);
    setTimeout(tick, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
