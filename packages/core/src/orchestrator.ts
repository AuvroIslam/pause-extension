import type {
  CallAI,
  ClarifyQuestion,
  Domain,
  QAPair,
  Verbosity,
} from './types.js';
import { detectDomain, DOMAIN_GUIDANCE } from './domain.js';
import {
  buildImprovedSystemPrompt,
  buildImprovedUserPrompt,
  buildNextQuestionSystemPrompt,
  buildNextQuestionUserPrompt,
  cleanImprovedPrompt,
} from './prompts.js';
import { sanitizeInput, safeJsonParse } from './util.js';

const MAX_Q_CONCISE = 3;
const MAX_Q_THOROUGH = 5;

export function maxQuestionsFor(verbosity: Verbosity): number {
  return verbosity === 'concise' ? MAX_Q_CONCISE : MAX_Q_THOROUGH;
}

export type NextQuestionResult =
  | { done: true }
  | { done: false; question: ClarifyQuestion };

export interface NextQuestionInput {
  promptText: string;
  modelProfileName?: string;
  previousQA: QAPair[];
  questionIndex: number;
  verbosity?: Verbosity;
  /** Override auto-detection if the host already knows the domain. */
  domain?: Domain;
}

/**
 * Ask the model for the next adaptive clarifying question (or a done signal).
 * Host-agnostic: the caller injects `callAI`. Throws on unrecoverable AI errors
 * (message = stable code); returns a done/question result otherwise.
 */
export async function nextQuestion(
  callAI: CallAI,
  input: NextQuestionInput,
): Promise<NextQuestionResult> {
  const promptText = sanitizeInput(input.promptText, 8000);
  const verbosity = input.verbosity ?? 'concise';
  const domain = input.domain ?? detectDomain(promptText).domain;
  const maxQuestions = maxQuestionsFor(verbosity);

  const raw = await callAI(
    [
      { role: 'system', content: buildNextQuestionSystemPrompt(domain, verbosity) },
      {
        role: 'user',
        content: buildNextQuestionUserPrompt({
          promptText,
          modelProfileName: input.modelProfileName,
          previousQA: input.previousQA,
          questionIndex: input.questionIndex,
          maxQuestions,
        }),
      },
    ],
    { response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 400 },
  );

  const parsed = safeJsonParse<{ done?: boolean; question?: Partial<ClarifyQuestion> }>(raw);
  if (!parsed) throw new Error('BAD_RESPONSE');
  if (parsed.done === true) return { done: true };

  const q = parsed.question;
  if (!q || typeof q.text !== 'string' || !q.text.trim()) throw new Error('BAD_RESPONSE');
  if (!Array.isArray(q.suggestions) || q.suggestions.length < 1) throw new Error('BAD_RESPONSE');

  return {
    done: false,
    question: {
      text: q.text,
      multiSelect: !!q.multiSelect,
      suggestions: q.suggestions.map((s) => String(s)),
    },
  };
}

export interface ImprovePromptInput {
  originalText: string;
  answersBlock: string;
  /** Formatting rules string for the target model (from getModelProfile().profile). */
  modelProfile: string;
  answeredCount: number;
  totalQuestions: number;
  verbosity?: Verbosity;
}

/** Build the final improved prompt. Host-agnostic; caller injects `callAI`. */
export async function improvePrompt(
  callAI: CallAI,
  input: ImprovePromptInput,
): Promise<string> {
  const originalText = sanitizeInput(input.originalText, 8000);
  const answersBlock = sanitizeInput(input.answersBlock, 3000);
  const modelProfile = sanitizeInput(input.modelProfile, 1200);
  const verbosity = input.verbosity ?? 'concise';

  const { domain, temperature } = detectDomain(originalText);
  const domainGuidance = DOMAIN_GUIDANCE[domain] || DOMAIN_GUIDANCE.general;

  const improved = await callAI(
    [
      {
        role: 'system',
        content: buildImprovedSystemPrompt({
          domainGuidance,
          modelProfile,
          answeredCount: input.answeredCount,
          totalQuestions: input.totalQuestions,
          verbosity,
        }),
      },
      { role: 'user', content: buildImprovedUserPrompt({ originalText, answersBlock }) },
    ],
    { temperature, max_tokens: 1500 },
  );

  return cleanImprovedPrompt(improved);
}
