# Pause — Privacy Policy

_Last updated: 2026-07-03_

Pause is designed to be private by default. This policy explains exactly what data
the extension touches and where it goes.

## What Pause processes

**Your prompt text and clarifying answers.** When you click ⏸ (or use `@pause` in
VS Code), the draft prompt and the answers you give to clarifying questions are sent
to the Pause proxy, which forwards them to an AI provider (Groq, Mistral, or DeepSeek)
solely to generate clarifying questions and the improved prompt. They are used for
that request only and are not stored by Pause.

**Conversation text (handoff feature only).** If you hit an AI's usage limit and
choose to continue on another AI, Pause reads the visible conversation from the page
to build a short continuation summary. This is sent to the Pause proxy only to
generate that summary. The raw conversation:

- stays on your device except for the summary request you explicitly trigger,
- is sent only when **you** click a "Continue on …" button,
- is written to `chrome.storage.local` briefly (max 5 minutes) so the target tab can
  auto-insert it, then deleted.

## What Pause never does

- **No account credentials.** Pause never reads, stores, or transmits your logins,
  cookies, or session tokens. The handoff feature only works with accounts you are
  already signed into; it never switches or rotates accounts.
- **No API keys on your device.** All AI calls route through a proxy that holds the
  keys server-side.
- **No tracking, ads, or analytics** are bundled. Pause does not sell or share data.
- **No background collection.** Pause only sends data when you actively trigger it.

## Settings storage

Your preferences (enabled sites, clarification depth, handoff targets) are stored via
`chrome.storage.sync` / VS Code settings so they follow your profile. They contain no
prompt content.

## Third parties

Prompt/answer/summary text is processed by whichever provider the proxy uses for that
request (Groq, Mistral, or DeepSeek) under their respective terms. The proxy is the
only network endpoint Pause contacts.

## Contact

Questions: open an issue on the project repository.
