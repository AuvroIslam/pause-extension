# Store listing content

Everything you paste into the Chrome Web Store and VS Code Marketplace forms.

## Assets in this folder

| File | Use |
|---|---|
| `4-question.png` | **Primary screenshot** — the adaptive question with suggestion chips. Lead with this. |
| `2-handoff.png` | The limit-detection handoff offer. This is the differentiator. |
| `1-score-badge.png` | Live prompt scoring on the composer. |
| `3-settings.png` | The settings page. |

All are 1280×800 and captured from the real extension running in Chrome — no mockups.
Chrome requires at least one 1280×800 or 640×400 screenshot; up to five are allowed.

Upload zip: `packages/extension-chrome/pause-chrome-3.0.0.zip`

---

## Privacy policy URL

```
https://pause-murex.vercel.app/privacy
```

## Homepage URL

```
https://pause-murex.vercel.app/
```

---

## Single purpose (Chrome requires one sentence)

> Pause helps users write better AI prompts and, when they hit a usage limit, carry their
> conversation to another AI they are already signed into.

## Short description (132 char max — current: 128)

> Think before you prompt: adaptive clarification, live scoring, and one-click context
> handoff to another AI when you hit a limit.

## Detailed description

> **Pause makes you a better prompter — and rescues you when you hit a wall.**
>
> **Before you send.** Pause scores your prompt live as you type, then asks adaptive
> clarifying questions one at a time — each one informed by your previous answers, not a
> fixed checklist. It stops early when your prompt is already strong. Then it rewrites your
> prompt using the target model's own prompting conventions.
>
> **When you hit a limit.** The moment an AI says "you've reached your limit," Pause offers
> to carry the conversation onward. It captures the visible chat, builds a portable
> continuation summary, opens another AI you're already signed into, and inserts the
> context automatically. No copy-paste. No lost thread.
>
> **Works on:** ChatGPT, Claude, Gemini, Grok, Perplexity, Copilot, DeepSeek, Mistral, Poe.
>
> **Private by design.** No account credentials are ever read or stored. No API keys live in
> the extension. No tracking, no ads, no analytics. Your conversation stays on your device
> except for the summary you explicitly ask for.

---

## Permission justifications (Chrome review form)

**`storage`**
> Stores the user's own settings (which sites Pause runs on, how many clarifying questions
> to ask, preferred handoff targets). It also briefly holds the handoff summary — for at
> most five minutes — so the destination tab can insert it after the user clicks
> "Continue on …". No prompt or conversation content is retained beyond that.

**Host permission — `https://pause-proxy-seven.vercel.app/*`**
> The extension's only network endpoint. AI provider keys are held server-side in this proxy
> so they never ship inside the extension. The prompt text and clarifying answers are sent
> here to generate the questions and the rewritten prompt.

**Content script host access (chatgpt.com, claude.ai, gemini.google.com, grok.com, x.ai,
perplexity.ai, copilot.microsoft.com, chat.deepseek.com, deepseek.com, chat.mistral.ai,
poe.com)**
> Pause must run on the AI chat sites themselves to do its job: read the prompt the user is
> typing in order to score it, inject the ⏸ button next to the composer, detect the site's
> "usage limit reached" banner, and insert the continuation summary into the destination
> site's input box after a handoff. Access is limited to this explicit list of AI chat
> hosts — there is no broad `<all_urls>` permission — and nothing is read from any other
> site.

**Remote code**
> None. All code is bundled in the package. The extension makes network requests only to the
> proxy endpoint above, and only for text completions.

**Data usage disclosures (tick these):**
- Personally identifiable information — **No**
- Health / financial / authentication information — **No**
- Personal communications — **Yes.** Prompt text and, only when the user triggers a handoff,
  the visible conversation, are transmitted to the proxy to generate the rewrite/summary.
- Location, web history, user activity — **No**
- Website content — **Yes.** The visible conversation text, only on user-triggered handoff.

Certify: not sold to third parties; not used for unrelated purposes; not used for
creditworthiness.

---

## VS Code Marketplace

Upload `packages/extension-vscode/pause-vscode-3.1.1.vsix` at
https://marketplace.visualstudio.com/manage — publisher **MdNafizAhmed** → New extension →
Visual Studio Code. No Azure DevOps token needed for web upload.

The listing page is generated from `packages/extension-vscode/README.md`, and the icon and
categories come from its `package.json`. Nothing else to fill in.
