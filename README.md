# Pause — Stop rushing. Think first.

**Website:** [pause-tau-blue.vercel.app](https://pause-tau-blue.vercel.app)

A Chrome extension (Manifest V3) that adds intentional cognitive friction to AI prompting. Instead of letting you fire off a vague question, Pause intercepts it, asks you adaptive clarifying questions one at a time, and then rewrites your prompt — tailored to the specific AI model you're using.

---

## What it does

1. **Live prompt score badge** — appears above the ⏸ button as you type. Shows a score like `67% Fair` with a color bar (red → yellow → green), updating every 350 ms. Entirely local, no API call.
2. **⏸ button injected into the chat input** — Grammarly-style, sits inside the input box on every supported site.
3. **Adaptive clarifying questions** — one question at a time, each informed by every previous answer (AT-CoT method, SIGIR 2025). Covers the WHO / WHAT / HOW / WHY / SCOPE gap checklist.
4. **Clickable answer chips + free-text** — chips cover the most common answers; you can always type your own.
5. **Back button** — change a previous answer; all subsequent questions regenerate from the updated context.
6. **Improved prompt generation** — rewritten using the official prompting best practices for the target model:
   - ChatGPT → role assignment + triple-quote delimiters + format/length spec
   - Claude → XML tags (`<context>`, `<task>`, `<format>`)
   - Gemini → Google PTCF framework (Persona, Task, Context, Format)
   - Grok → sharp, direct, comparative framing
   - Copilot → GCSE structure (Goal, Context, Source, Expectation)
   - Perplexity → search-domain scoping + citation requests
   - Mistral → explicit system-style opener + output schema
   - DeepSeek → structured sections + constraint line
   - Poe → portable, model-agnostic structure
7. **Before / After score comparison** — e.g. `42% Weak → 89% Excellent  +47 pts`
8. **One-click replace** — writes the improved prompt directly into the chat input, compatible with React, ProseMirror, and Quill.

---

## Supported sites

| Site | Selector strategy |
|------|-------------------|
| ChatGPT (`chatgpt.com`, `chat.openai.com`) | `#prompt-textarea` (ProseMirror) |
| Claude (`claude.ai`) | `div[data-testid="chat-input"]` (ProseMirror) |
| Gemini (`gemini.google.com`) | `div.ql-editor` inside `<rich-textarea>` shadow root |
| Grok (`grok.com`, `x.ai`) | generic contenteditable fallback |
| Microsoft Copilot (`copilot.microsoft.com`) | textarea / contenteditable |
| Perplexity (`perplexity.ai`) | textarea / contenteditable |
| Mistral (`chat.mistral.ai`) | textarea / contenteditable |
| Poe (`poe.com`) | textarea / contenteditable |
| DeepSeek (`chat.deepseek.com`, `deepseek.com`) | textarea / contenteditable |

---

## Architecture

```
pause-extension/
├── manifest.json      # MV3 — permissions: storage, activeTab
├── background.js      # Service worker — calls the Vercel proxy, caches model profiles
├── content.js         # Injected into AI sites — button, scoring, panel, prompt rewrite
└── icons/             # 16 / 48 / 128 px PNGs
```

### Data flow

```
User types → content.js scores prompt (local heuristic)
User clicks ⏸ → content.js sends prompt to background.js via chrome.runtime.sendMessage
background.js → POST /api/ai on Vercel proxy
Vercel proxy → Groq (llama-3.3-70b) → Mistral (mistral-small) → DeepSeek (fallback)
Response → back to content.js → next question rendered in Shadow DOM panel
(repeat up to 5 questions)
Final answer set → background.js generates improved prompt → injected into chat input
```

### Why a proxy?

No API keys are stored in the extension. The service worker calls `https://pause-proxy.vercel.app/api/ai`, which fans out to AI providers using server-side env vars (`GROQ_KEY`, `MISTRAL_KEY`, `DEEPSEEK_KEY`). See the [`/proxy`](../proxy) folder for the serverless function.

---

## Prompt quality scorer (local, zero latency)

13 heuristic dimensions, each weighted:

| Dimension | Max pts |
|-----------|---------|
| Length / richness | 15 |
| Clear action verb | 10 |
| Audience / recipient | 10 |
| Output format specified | 10 |
| Context / purpose | 10 |
| Length constraint | 8 |
| Tone / style | 8 |
| Role / persona framing | 8 |
| Structured section headers | 8 |
| Technical specificity (stack mentions) | 10 |
| Chain-of-thought instructions | 5 |
| Examples / references | 5 |
| Proper nouns + numbers | 6 |

Score → label: **Vague** (0–19) · **Weak** (20–39) · **Fair** (40–59) · **Good** (60–79) · **Excellent** (80–100)

---

## Domain detection

Before generating questions, the extension classifies the prompt into one of seven domains and adjusts both the question priority order and the LLM temperature:

| Domain | Temperature | First-priority gap |
|--------|-------------|-------------------|
| Debugging | 0.15 | Exact error → environment → what was tried |
| Coding | 0.15 | Stack / language (always first if missing) |
| Creative | 0.50 | Tone/register → target reader → length/form |
| Communication | 0.35 | Sender identity → recipient relationship → tone |
| Planning | 0.30 | Hard constraints → audience expertise → output format |
| Research | 0.20 | Audience level → depth → output format |
| General | 0.25 | End-use purpose → audience → format |

---

## Reliability details

- **MV3 service worker keepalive** — content script sends a `PING` every 20 s while the panel is open; prevents the SW from going idle and silently dropping in-flight requests.
- **3-provider fallback** — Groq → Mistral → DeepSeek. Groq is skipped for payloads > 3 500 chars (rate-limit threshold). Retriable error codes: `TIMEOUT`, `RATE_LIMIT`, `SERVER_ERROR`, `NETWORK`.
- **Shadow DOM isolation** — the entire panel lives in a shadow root; AI sites cannot steal focus from the answer textarea or inject styles.
- **React / ProseMirror / Quill compatible input writing** — uses the native `HTMLTextAreaElement` value setter + `execCommand('insertText')` so React and framework state stay in sync after the prompt is replaced.
- **Zero-polling button positioning** — `position:fixed` + `getBoundingClientRect` recalculated on `ResizeObserver` and `MutationObserver` callbacks only.
- **Persistent panel shell** — overlay and panel are created once; only inner content is swapped with a 60 ms crossfade to eliminate flicker.
- **Model profile cache** — platform-specific prompting rules are cached in `chrome.storage.local` with a 7-day TTL so the improved-prompt call always has the right profile without an extra round-trip.

---

## Load unpacked (development)

1. Clone / download this repo.
2. Open `chrome://extensions` → enable **Developer mode**.
3. Click **Load unpacked** → select the `pause-extension/` folder.
4. Open ChatGPT, Claude, or any supported site and start typing.

> The extension calls the live Vercel proxy at `https://pause-proxy.vercel.app/api/ai` by default. If you're running the proxy locally, update `PROXY_URL` in `background.js`.

---

## Self-hosting the proxy

See [`/proxy/README.md`](../proxy) (or the Vercel dashboard) for deployment steps. Set three environment variables:

| Variable | Provider |
|----------|----------|
| `GROQ_KEY` | [console.groq.com](https://console.groq.com) |
| `MISTRAL_KEY` | [console.mistral.ai](https://console.mistral.ai) |
| `DEEPSEEK_KEY` | [platform.deepseek.com](https://platform.deepseek.com) |

---

## Tech stack

- **Chrome Extension Manifest V3** — service worker + content script
- **Vanilla JS** — no build step, no bundler, ships directly to the browser
- **Shadow DOM** — style + event isolation for the injected panel
- **Vercel Serverless Functions** (Node 18+) — proxy with IP-based rate limiting (20 req / min / IP)
- **AI providers** — Groq (`llama-3.3-70b-versatile`), Mistral (`mistral-small-latest`), DeepSeek (`deepseek-chat`)
