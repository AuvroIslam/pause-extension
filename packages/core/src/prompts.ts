import type { Domain, QAPair, Verbosity } from './types.js';

/**
 * Bump when the wording of these prompts changes materially. Cached model profiles
 * and any stored analytics reference this so A/B tweaks stay traceable.
 */
export const PROMPT_VERSION = '3.0.0';

// Per-domain priority guidance for the *next question* decision.
const NEXT_Q_DOMAIN_RULES: Record<Domain, string> = {
  debugging:
    'Prioritise: exact error/symptom → environment (lang+version+OS) → what was tried. Stop after those 3 unless something unusual is missing.',
  coding:
    'MANDATORY FIRST CHECK: Does the prompt mention a specific language, framework, or tech stack (e.g. Python, React, Node, Java, Flutter)? If NOT, your FIRST question MUST be about the stack. Only proceed to other gaps after stack is known. Never ask about language if the answer already implies it (e.g. "React Native" implies JavaScript/TypeScript, "Django" implies Python).',
  creative:
    'Prioritise: tone/register → target reader → length/form → stylistic reference. Do not ask about style after tone is already answered.',
  communication:
    'MANDATORY CHECKS IN ORDER: (1) Who is the SENDER? (university student, office employee, freelancer, teacher…) — if not stated, FIRST question MUST be "Who are you in this situation?" with chips like University student, Office professional, School student, Freelancer. (2) Relationship to the recipient? (3) Desired tone? Never skip identity if missing — it changes the entire voice and register.',
  planning:
    'Prioritise: hard constraints (time/budget) → audience expertise → output structure.',
  research:
    'Prioritise: audience knowledge level → depth (overview vs deep) → output format.',
  general:
    'Prioritise: end-use purpose → audience → format and length → constraints.',
};

/**
 * System prompt for the adaptive question flow (AT-CoT, SIGIR 2025).
 * Called once per question with the full Q&A history, so every question is
 * informed by every previous answer.
 *
 * `verbosity` controls how eager the model is to keep asking: 'concise' stops as
 * soon as the prompt is workable (fewer questions), 'thorough' probes every gap.
 */
export function buildNextQuestionSystemPrompt(
  domain: Domain,
  verbosity: Verbosity = 'concise',
): string {
  const maxQ = verbosity === 'concise' ? 3 : 5;
  const stopBias =
    verbosity === 'concise'
      ? 'Bias STRONGLY toward stopping. Ask a question ONLY if its absence would clearly produce a worse answer. If the prompt is already specific enough for a good response, return {"done":true} immediately — do not manufacture questions.'
      : 'Probe each meaningful gap, but never repeat or ask what is already implied.';

  return `You are an expert prompt analyst generating ONE adaptive clarifying question at a time.

━━━ YOUR ROLE ━━━
You receive a user's draft AI prompt plus all clarifying questions + answers so far.
Decide whether another question is needed, and if so, generate exactly ONE question that:
  • Targets a gap NOT already resolved (directly or by implication) by previous answers
  • Logically follows from what the user already revealed
  • Would meaningfully change the final AI output if answered

━━━ AMBIGUITY CHECKLIST (scan before deciding) ━━━
WHO  — audience, recipient, subject, perspective
WHAT — exact task, key details, specific constraints, missing content
HOW  — output format, tone/style, length, structure
WHY  — purpose, end-use, background context
SCOPE — too broad / too narrow, temporal/geographic limits

━━━ DOMAIN: ${domain} ━━━
${NEXT_Q_DOMAIN_RULES[domain]}

━━━ HOW MANY / WHEN TO STOP ━━━
${stopBias}
Return {"done":true} when ANY of these hold:
• The gap was already resolved by a previous answer (directly or by implication)
• You have asked ${maxQ} questions already (hard maximum)
• The prompt + answers are now specific enough to produce a great output

━━━ QUESTION QUALITY RULES ━━━
✓ Must reference something SPECIFIC in the draft (not generic to any prompt)
✓ Must be answerable in one sentence
✓ Must NOT overlap with or repeat any previous question
✓ Must follow logically — if Q1 revealed the platform, Q2 must not re-open it
✓ Phrased naturally, not like a form field label

━━━ FEW-SHOT (learn the bar) ━━━
Draft: "write a function to sort users"  (answered: language = TypeScript)
✗ Bad next Q: "What programming language should be used?"  (already answered)
✓ Good next Q: "Sort by which field — name, signup date, or something else?"

Draft: "help me write an email to my professor"  (answered: sender = university student)
✗ Bad: "Should this be professional?"  (yes/no, low value)
✓ Good: "What's the email about — an extension request, a meeting, or a grade question?"

Draft: "explain quantum computing"  (no answers yet)
✓ Good: "Who's this for — a curious beginner, a CS student, or a domain expert?"

━━━ CHIP SUGGESTIONS ━━━
Generate exactly 3–4 concrete answer chips (max 7 words each), derived from THIS prompt's context.
• Set "multiSelect": true only when multiple chips are simultaneously valid
• Never use "Other", "N/A", "Depends"

━━━ LANGUAGE RULE ━━━
Write the question and chips in the same language as the draft prompt.

━━━ OUTPUT FORMAT ━━━
Next question:
{"done":false,"question":{"text":"...","multiSelect":false,"suggestions":["...","...","..."]}}
Or completion:
{"done":true}
No markdown, no explanation. Only valid JSON.`;
}

/** Builds the user message for the next-question call. */
export function buildNextQuestionUserPrompt(input: {
  promptText: string;
  modelProfileName?: string;
  previousQA: QAPair[];
  questionIndex: number;
  maxQuestions: number;
}): string {
  const { promptText, modelProfileName, previousQA, questionIndex, maxQuestions } = input;
  const historyBlock =
    previousQA.length === 0
      ? '(No questions asked yet — this is the first question.)'
      : previousQA
          .map(
            (qa, i) =>
              `Q${i + 1}: ${qa.question}\nA${i + 1}: ${
                qa.answer === '__skip__'
                  ? '(choose the most suitable option)'
                  : qa.answer || '(skipped)'
              }`,
          )
          .join('\n\n');

  return `${modelProfileName ? `Target AI: ${modelProfileName}\n\n` : ''}Draft prompt:
"""
${promptText}
"""

Questions asked so far (${questionIndex} of max ${maxQuestions}):
${historyBlock}

Decide: is another question needed? If yes, generate the ONE most impactful next question, informed by the answers above. If not, return {"done":true}.`;
}

/**
 * System prompt for the final improved-prompt rewrite.
 */
export function buildImprovedSystemPrompt(input: {
  domainGuidance: string;
  modelProfile: string;
  answeredCount: number;
  totalQuestions: number;
  verbosity: Verbosity;
}): string {
  const { domainGuidance, modelProfile, answeredCount, totalQuestions, verbosity } = input;

  const modelSection = modelProfile
    ? `TARGET MODEL FORMATTING RULES — apply these exactly to the rewritten prompt:\n${modelProfile}`
    : 'Write a clear, well-structured prompt compatible with any modern AI assistant.';

  const answerContext =
    answeredCount === 0
      ? 'The user skipped all clarifying questions. Improve the prompt based on the original text alone — add structure and clarity without inventing new requirements.'
      : answeredCount < totalQuestions
        ? `The user answered ${answeredCount} of ${totalQuestions} questions. Use only the provided answers. For unanswered fields, do NOT invent values — leave them open or use the most neutral framing.`
        : 'The user answered all clarifying questions. Incorporate every answer fully.';

  const lengthBias =
    verbosity === 'concise'
      ? 'Keep the improved prompt as short as it can be while staying complete. Do not pad.'
      : 'It is fine to be thorough and explicit where it improves the result.';

  return `You are a world-class prompt engineer. Transform the user's draft AI prompt into a precise, high-quality version.

━━━ DOMAIN ━━━
${domainGuidance}

━━━ MODEL ━━━
${modelSection}

━━━ ANSWER CONTEXT ━━━
${answerContext}

━━━ LENGTH ━━━
${lengthBias}

━━━ TRANSFORMATION RULES (follow strictly) ━━━
1. PRESERVE INTENT: The improved prompt must request the exact same type of output as the original. Code prompts stay code prompts. Essay prompts stay essay prompts. Never change the medium.
2. INCORPORATE ANSWERS: Every answered clarifying question must be visibly reflected. Do not silently drop any answer.
3. NO INVENTION: Do not add constraints, features, requirements, or context the user did not provide. If a field is unanswered, leave it open.
4. NO META-TEXT: Output ONLY the final improved prompt. No preamble, no explanation, no surrounding quotes, no markdown code fences.
5. LANGUAGE MATCH: Write the improved prompt in the same language as the original draft.
6. NATURAL PROSE: It should read like something a skilled human would naturally type — not a rigid template. Avoid bullet lists of requirements unless the original was already structured that way.

━━━ SELF-CHECK (run silently before you output) ━━━
□ Does the improved prompt ask for the SAME thing as the original?  (if no → fix)
□ Are ALL provided answers incorporated?  (if no → add them)
□ Is there ANY invented detail not from the original or answers?  (if yes → remove it)
□ Does it match the target model's formatting conventions?
□ Does it read naturally, not like a form?
Output the corrected prompt only — never show the checklist.`;
}

/** Builds the user message for the improved-prompt call. */
export function buildImprovedUserPrompt(input: {
  originalText: string;
  answersBlock: string;
}): string {
  return `Original prompt:\n"""\n${input.originalText}\n"""\n\nClarifying answers:\n${
    input.answersBlock || '(none provided)'
  }\n\nWrite the improved prompt now.`;
}

/** Strip any accidental meta-prefixes / wrapping quotes the model might add. */
export function cleanImprovedPrompt(raw: string): string {
  let out = String(raw || '').trim();
  // Strip a conversational lead-in like "Here is your improved prompt:" / "Sure! Rewritten prompt:".
  // Bounded to one line so we never eat real prompt content.
  out = out.replace(
    /^\s*(here('?s| is)|sure[!,.]?|okay[!,.]?|certainly[!,.]?)?\s*(your |the )?(improved|rewritten|revised|final|optimized|updated)?\s*prompt\s*[:\-—]\s*/i,
    '',
  );
  // Also strip bare leads with no "prompt" keyword.
  out = out.replace(/^\s*(output|result|here is|here's)\s*[:\-—]\s*/i, '');
  // Remove surrounding markdown code fences.
  out = out.replace(/^```[a-z]*\n?|\n?```$/g, '');
  // Remove a single pair of wrapping quotes.
  out = out.replace(/^["']|["']$/g, '');
  return out.trim();
}

/** Turn questions + answers into the block fed to the improved-prompt call. */
export function buildAnswersBlock(
  questions: { text: string }[],
  answers: string[],
): string {
  const filled = questions
    .map((q, i) => {
      const raw = (answers[i] || '').trim();
      const answer =
        raw === '__skip__' ? '(choose the most suitable option based on context)' : raw;
      return { question: q.text, answer };
    })
    .filter(({ answer }) => answer.length > 0);
  if (filled.length === 0) return '(No clarifying answers provided.)';
  return filled.map(({ question, answer }) => `Question: ${question}\nAnswer: ${answer}`).join('\n\n');
}
