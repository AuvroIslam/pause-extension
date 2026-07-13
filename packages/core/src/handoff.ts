import type { CallAI, TranscriptTurn, Verbosity } from './types.js';
import { getModelProfile, getModelName } from './modelProfiles.js';
import { sanitizeInput } from './util.js';

/**
 * Flatten a captured conversation into a readable, size-capped transcript.
 * Keeps the MOST RECENT turns (they matter most for continuation) by trimming
 * from the front when over budget.
 */
export function transcriptToText(
  transcript: TranscriptTurn[],
  maxChars = 6000,
): string {
  const lines = transcript.map(
    (t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text.trim()}`,
  );
  let text = lines.join('\n\n');
  if (text.length > maxChars) {
    // Drop oldest turns until under budget.
    while (lines.length > 1 && lines.join('\n\n').length > maxChars) lines.shift();
    text = '[…earlier conversation trimmed…]\n\n' + lines.join('\n\n');
  }
  return text;
}

function buildHandoffSystemPrompt(
  targetModelName: string,
  targetModelProfile: string,
  verbosity: Verbosity,
): string {
  const length =
    verbosity === 'concise'
      ? 'Keep it tight — a few short paragraphs at most.'
      : 'Be as complete as needed to fully preserve context.';

  return `You are a context-handoff specialist. A user has been chatting with one AI assistant and hit a usage limit. They want to CONTINUE the exact same task on a DIFFERENT AI assistant.

Your job: read the conversation so far and write a single self-contained "continuation prompt" that the user can paste into the new assistant to pick up EXACTLY where they left off — as if the new assistant had been part of the whole conversation.

━━━ THE CONTINUATION PROMPT MUST ━━━
1. Briefly summarise what the task/goal is and the relevant decisions or facts established so far.
2. Preserve any critical specifics verbatim — code, error messages, names, numbers, constraints, file/variable names.
3. Restate the LAST open question or the next step the user was waiting on, so the new assistant knows exactly what to produce next.
4. Read as the user's own message to a fresh assistant — first person, natural. Do NOT narrate ("the user asked…"); write as the user.
5. NOT invent facts that weren't in the conversation.

━━━ TARGET MODEL FORMATTING ━━━
The new assistant is ${targetModelName}. Apply these formatting conventions to the continuation prompt.
${targetModelProfile}

━━━ LENGTH ━━━
${length}

━━━ OUTPUT ━━━
Output ONLY the continuation prompt text. No preamble, no explanation, no quotes, no code fences.`;
}

export interface HandoffInput {
  transcript: TranscriptTurn[];
  /** Hostname of the AI the user is moving TO (e.g. "claude.ai"). */
  targetHostname: string;
  verbosity?: Verbosity;
  /** Optional: what the user still wants, if captured from the input box. */
  pendingUserText?: string;
}

/**
 * Produce a portable continuation prompt for a different AI. Host-agnostic;
 * caller injects `callAI`. The transcript never leaves the user's machine except
 * as this summary, sent only to the user-selected target.
 */
export async function buildHandoffContext(
  callAI: CallAI,
  input: HandoffInput,
): Promise<string> {
  const verbosity = input.verbosity ?? 'concise';
  const targetProfile = getModelProfile(input.targetHostname);
  const transcriptText = transcriptToText(input.transcript);
  const pending = sanitizeInput(input.pendingUserText, 2000);

  const userMsg = `Here is the conversation so far with the previous assistant:

"""
${transcriptText}
"""
${pending ? `\nThe user was about to send this next message when they hit the limit:\n"""\n${pending}\n"""\n` : ''}
Write the continuation prompt for ${targetProfile.name} now.`;

  const raw = await callAI(
    [
      {
        role: 'system',
        content: buildHandoffSystemPrompt(targetProfile.name, targetProfile.profile, verbosity),
      },
      { role: 'user', content: userMsg },
    ],
    { temperature: 0.2, max_tokens: 1500 },
  );

  return String(raw || '')
    .trim()
    .replace(/^```[a-z]*\n?|\n?```$/g, '')
    .trim();
}

/** Convenience for UI copy: "Continue on Claude". */
export function handoffTargetLabel(hostname: string): string {
  return getModelName(hostname);
}
