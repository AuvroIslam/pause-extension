import type { ScoreLabel } from './types.js';

// ─── Tunable weights ───────────────────────────────────────────────────────────
// Each dimension's max contribution. Extracted into a named config so scoring can
// be tuned / A-B tested without touching the logic, and asserted in unit tests.

export interface ScoreWeights {
  lengthTiers: [number, number, number, number]; // >25, >80, >200, >400
  actionVerb: number;
  audience: number;
  context: number;
  outputFormat: number;
  lengthConstraint: number;
  tone: number;
  rolePersona: number;
  sectionHeaderEach: number;
  sectionHeaderMax: number;
  chainOfThought: number;
  examples: number;
  techTermEach: number;
  techTermMax: number;
  properNounEach: number;
  numberEach: number;
  specificityMax: number;
  shortPenalty: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  lengthTiers: [3, 4, 4, 4],
  actionVerb: 10,
  audience: 10,
  context: 10,
  outputFormat: 10,
  lengthConstraint: 8,
  tone: 8,
  rolePersona: 8,
  sectionHeaderEach: 4,
  sectionHeaderMax: 8,
  chainOfThought: 5,
  examples: 5,
  techTermEach: 4,
  techTermMax: 10,
  properNounEach: 1.5,
  numberEach: 1.5,
  specificityMax: 6,
  shortPenalty: 8,
};

const RE = {
  actionVerb:
    /\b(write|build|create|make|explain|summarize|analyze|fix|debug|generate|design|implement|compare|list|describe|draft|plan|review|translate|convert|refactor|optimize|find|suggest|recommend|help me|evaluate|assess|identify)\b/,
  audience:
    /\b(for (a |an |the |my )?(beginner|expert|student|senior|junior|team|client|customer|non.technical|technical|manager|developer|designer|child|adult|supervisor|colleague|boss|professor|recruiter|hiring manager)|audience|reader|recipient|aimed at|targeted at|formal recipient|informal recipient)\b/,
  outputFormat:
    /\b(as a (list|table|json|markdown|bullet|numbered|outline|summary|essay|email|report|paragraph|function|class|script)|in (bullet|table|json|markdown|prose|steps|paragraphs?)|format[: ]|output format|step.by.step|numbered list|bullet point|paragraph form|prose form)\b/,
  lengthConstraint:
    /\b(under|within|max(imum)?|at most|no more than|minimum|at least|exactly|approximately|around|roughly|\d+[\-–]\d+ (words?|sentences?|lines?|paragraphs?|pages?)|\d+ (words?|sentences?|lines?|paragraphs?|pages?)|short|brief|concise|detailed|comprehensive|in depth)\b/,
  tone:
    /\b(formal|informal|casual|professional|friendly|apologetic|assertive|empathetic|neutral|persuasive|diplomatic|concise|verbose|technical|simple|humorous|serious|warm|cold|polite|respectful|urgent|enthusiastic|tone should|writing style|in a .{0,20} tone)\b/,
  rolePersona:
    /\b(you are (a |an |the |an? )|act as (a |an |the )|as a |assume (you are|the role)|imagine you('?re| are)|pretend|take the role|i('?m| am) a |expert in|specialist in)\b/,
  context:
    /\b(because|since|currently|i('?m| am) (working|building|trying|writing|unable|sick|ill|away)|context[: ]|background[: ]|situation[: ]|the goal is|trying to|need to|i have|i('?ve| have) already|due to|as a result of|inform(ing)? (him|her|them|you)|unable to (attend|make it|be there)|health issue|personal reason)\b/,
  sectionHeaders:
    /\b(Instructions?|Context|Background|Output( Format)?|Format|Constraints?|Requirements?|Task|Goal|Example|Note|Steps?)[:\n]/g,
  chainOfThought:
    /\b(think step by step|step by step|reason through|think through|let'?s think|before (answering|responding|writing)|first .{0,30} then|chain of thought|work through)\b/,
  examples:
    /\b(for example|e\.g\.|such as|like (this|the following)|similar to|inspired by|based on|following (this|the)|here('?s| is) an example)\b/,
  techTerms:
    /\b(react|next\.?js|vue|angular|svelte|python|javascript|typescript|node\.?js|django|flask|fastapi|java|spring|kotlin|swift|flutter|dart|rust|go(lang)?|c\+\+|c#|\.net|php|laravel|ruby|rails|postgres|mysql|mongodb|redis|docker|kubernetes|aws|gcp|azure|graphql|rest|sql|html|css|tailwind|bootstrap|firebase|supabase)\b/g,
  properNoun: /\b[A-Z][a-z]{2,}\b/g,
  numbers: /\d+/g,
} as const;

const IGNORE_WORDS = new Set([
  'The', 'This', 'That', 'When', 'What', 'How', 'Why', 'Who', 'Where', 'Which',
  'Please', 'Write', 'Create', 'Build', 'Make', 'Help', 'Can', 'Should', 'Would',
  'Could', 'Instructions', 'Output', 'Format', 'Content', 'Note', 'Think', 'First', 'Then',
]);

// Words that both look like proper nouns AND are already counted as tech terms —
// excluded from the specificity dimension so a stack mention isn't double-scored.
const TECH_PROPER_NOUNS = new Set([
  'React', 'Vue', 'Angular', 'Svelte', 'Python', 'Javascript', 'Typescript',
  'Django', 'Flask', 'Java', 'Spring', 'Kotlin', 'Swift', 'Flutter', 'Dart',
  'Rust', 'Laravel', 'Ruby', 'Rails', 'Postgres', 'Mysql', 'Mongodb', 'Redis',
  'Docker', 'Kubernetes', 'Firebase', 'Supabase', 'Tailwind', 'Bootstrap',
]);

/**
 * Heuristic prompt-quality scorer — no API, instant, safe to run on every keystroke.
 * 13 weighted dimensions. Returns 0–100.
 */
export function scorePrompt(text: string, weights: ScoreWeights = DEFAULT_WEIGHTS): number {
  const t = (text || '').trim();
  if (t.length < 5) return 0;
  const lo = t.toLowerCase();
  let score = 0;

  // 1. Length / richness
  const len = t.length;
  const [l1, l2, l3, l4] = weights.lengthTiers;
  score += len > 25 ? l1 : 0;
  score += len > 80 ? l2 : 0;
  score += len > 200 ? l3 : 0;
  score += len > 400 ? l4 : 0;

  // 2–8: single-signal dimensions
  if (RE.actionVerb.test(lo)) score += weights.actionVerb;
  if (RE.audience.test(lo)) score += weights.audience;
  if (RE.outputFormat.test(lo)) score += weights.outputFormat;
  if (RE.lengthConstraint.test(lo)) score += weights.lengthConstraint;
  if (RE.tone.test(lo)) score += weights.tone;
  if (RE.rolePersona.test(lo)) score += weights.rolePersona;
  if (RE.context.test(lo)) score += weights.context;

  // 9. Structured section headers
  const sectionHeaders = (t.match(RE.sectionHeaders) || []).length;
  score += Math.min(sectionHeaders * weights.sectionHeaderEach, weights.sectionHeaderMax);

  // 10. Chain-of-thought instructions
  if (RE.chainOfThought.test(lo)) score += weights.chainOfThought;

  // 11. Examples / references
  if (RE.examples.test(lo)) score += weights.examples;

  // 12. Technical specificity (stack mentions)
  const techTerms = (lo.match(RE.techTerms) || []).length;
  score += Math.min(techTerms * weights.techTermEach, weights.techTermMax);

  // 13. Specificity via proper nouns + numbers.
  // Exclude proper nouns already counted as tech terms to avoid double-scoring.
  const properNouns = (t.match(RE.properNoun) || []).filter(
    (w) => !IGNORE_WORDS.has(w) && !TECH_PROPER_NOUNS.has(w),
  ).length;
  const numbers = (t.match(RE.numbers) || []).length;
  score += Math.min(
    properNouns * weights.properNounEach + numbers * weights.numberEach,
    weights.specificityMax,
  );

  // Penalty: very short with no specifics
  if (len < 30 && score < 25) score = Math.max(score - weights.shortPenalty, 0);

  return Math.min(Math.round(score), 100);
}

export function scoreLabel(s: number): ScoreLabel {
  if (s >= 80) return 'Excellent';
  if (s >= 60) return 'Good';
  if (s >= 40) return 'Fair';
  if (s >= 20) return 'Weak';
  return 'Vague';
}

// Brand palette: #A80038 red · #FFDB00 yellow · #1C352D green
export function scoreColor(s: number): string {
  if (s >= 80) return '#4d8c6f';
  if (s >= 60) return '#7aaa90';
  if (s >= 40) return '#FFDB00';
  if (s >= 20) return '#A80038';
  return '#7a0028';
}

export function scorePillStyle(s: number): string {
  if (s >= 60) return 'background:#1C352D;color:rgba(255,255,255,0.85)';
  if (s >= 40) return 'background:#3a3000;color:#FFDB00';
  return 'background:#3a0018;color:#A80038';
}
