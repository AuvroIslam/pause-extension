# Pause — Think before you prompt. Never lose context.

**Live site: https://pause-murex.vercel.app/**

Pause makes you a better prompter and rescues you when you hit a wall:

1. **Before you send** — it adds intentional friction. Instead of firing off a vague
   question, Pause scores your prompt live, asks adaptive clarifying questions one at a
   time, and rewrites it using the target model's own prompting conventions.
2. **When you hit a limit** — the moment an AI says *"you've reached your limit,"* Pause
   captures the conversation, builds a portable continuation summary, and hands it off to
   another AI you're already signed into. No copy-paste, no lost context.

It ships as a **Chrome extension** (works inside ChatGPT, Claude, Gemini, Grok, Perplexity,
Copilot, DeepSeek, Mistral, Poe) and a **VS Code extension** (`@pause` chat participant +
a `Refine Prompt` command).

---

## Why Pause is different

The prompt-optimizer space is crowded (one-click rewriters) and the context-transfer space
exists too — but nobody ties them together at the moment of friction. Pause's wedges:

- **Adaptive, one-question-at-a-time clarification** (not a single-shot rewrite) — each
  question is informed by every previous answer, and it stops early when your prompt is
  already strong.
- **Limit-aware handoff** — the only tool that offers a context-preserving jump to another
  AI *exactly when you get rate-limited.*
- **Per-model formatting** — the same intent, rewritten the way ChatGPT / Claude / Gemini /
  etc. each respond best.

---

## Monorepo layout

```
pause/
├── packages/
│   ├── core/               @pause/core — shared brain (scoring, domain detection,
│   │                       prompt building, handoff summarizer). Zero host deps. Tested.
│   ├── extension-chrome/    MV3 extension — thin adapter over core.
│   ├── extension-vscode/    VS Code extension — @pause participant + refine command.
│   └── proxy/               Deployable Vercel proxy (Groq → Mistral → DeepSeek).
├── tsconfig.base.json
└── package.json            npm workspaces
```

**Guiding rule:** all pure logic lives in `@pause/core` and is imported by every target.
Only DOM / `chrome.*` / `vscode.*` glue lives in the adapters.

---

## Develop

```bash
npm install
npm run build          # builds core + Chrome extension
npm test               # runs the core Vitest suite (31 tests)
npm run build:vscode   # builds the VS Code extension
npm run typecheck      # tsc across core + Chrome
```

### Load the Chrome extension
1. `npm run build:chrome` → outputs `packages/extension-chrome/dist/`
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select that `dist/` folder.
3. Open any supported AI site and start typing.

### Run the VS Code extension
1. `npm run build:vscode`
2. Open `packages/extension-vscode` in VS Code and press **F5** (Extension Development Host).
3. Try `@pause write a function to sort users` in Copilot Chat, or run **Pause: Refine a Prompt**
   (Ctrl/Cmd+Alt+P).

### Deploy the proxy
See [`packages/proxy/README.md`](packages/proxy/README.md). Set `GROQ_KEY` / `MISTRAL_KEY` /
`DEEPSEEK_KEY`, then point the clients at your deployment.

---

## How it works

```
You type            → core.scorePrompt() shows a live quality badge (local, zero latency)
Click ⏸ / @pause    → core.nextQuestion() asks one adaptive question at a time (via proxy)
Answer / skip       → core.improvePrompt() rewrites it for the target model
Hit a usage limit   → limitWatch detects the banner → core.buildHandoffContext()
                       summarizes the chat → opens your chosen AI → auto-injects the summary
```

- **Privacy:** conversations stay on your device; only prompts/answers/summaries are sent,
  and the handoff summary is sent only to the target *you* pick. No credentials, no API keys
  client-side, no tracking. See [PRIVACY.md](PRIVACY.md).
- **Reliability:** MV3 keepalive pings, 3-provider fallback, Shadow-DOM isolation, and a
  React/ProseMirror/Quill-safe input writer.

---

## Tech
TypeScript · npm workspaces · esbuild · Vitest · Chrome MV3 · VS Code Chat API · Vercel functions.
