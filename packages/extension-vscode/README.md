# Pause — Think & Refine Prompts

**Stop firing off vague prompts.** Pause adds a moment of intentional friction: it scores
your prompt, asks one adaptive clarifying question at a time, and rewrites it using the
target model's own prompting conventions.

> `build a todo app` → score **2/100** → two questions → a rewritten prompt scoring **69/100**

## What it does

- **Live prompt scoring** — instant, local, zero latency.
- **Adaptive clarification** — one question at a time, each informed by your previous
  answers. Not a single-shot rewrite: it stops early when your prompt is already strong.
- **Per-model formatting** — the same intent, rewritten the way ChatGPT, Claude, Gemini,
  Grok, Perplexity, DeepSeek, or Mistral each respond best.

## Usage

Open the **⏸ Pause** panel from the activity bar (or the status bar item, or `Ctrl+Alt+P`)
and type a rough prompt. The panel is a chat: it scores your prompt as you type, asks its
clarifying questions as chat turns with clickable suggestions, and returns the rewrite with
**Send to Chat**, **Copy**, and **Insert at cursor** buttons.

Every rewrite is copied to your clipboard automatically, so pasting into any AI panel —
including ones VS Code sandboxes, like Claude Code or Codex — is a single `Ctrl+V`.

| How | What happens |
|---|---|
| **⏸ Pause panel** (`Ctrl+Alt+P`) | The chat box — the main way to use Pause. |
| Select text → **Pause: Refine Selected Text as Prompt** | Opens the panel seeded with your selection. |
| **`@pause`** in Copilot Chat | Refines your prompt inside the chat, then hands it to the model. |
| **Pause: Refine a Prompt (Quick Pick)** | The keyboard-only flow, if you prefer no panel. |

## Settings

- `pause.verbosity` — `concise` (up to 3 questions, default) or `thorough` (up to 5).
- `pause.targetModel` — which AI's conventions to format the rewritten prompt for.
- `pause.proxyUrl` — endpoint AI calls route through.

## Privacy

**No API keys are stored in the extension**, and your code is never uploaded. Only the
prompt text and your answers to the clarifying questions are sent, and only to the proxy
that performs the rewrite. See [PRIVACY.md](https://github.com/AuvroIslam/pause-extension/blob/main/PRIVACY.md).

## Requirements

The `@pause` chat participant requires an editor with the VS Code Chat API and a chat
provider (e.g. GitHub Copilot Chat). The `Refine Prompt` commands work without it.

---

Pause also ships as a **Chrome extension** that adds prompt refinement to the AI sites you
already use — and hands your conversation off to another AI when you hit a rate limit.
[pause-murex.vercel.app](https://pause-murex.vercel.app/)
