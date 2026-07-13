import type { Domain, DomainInfo } from './types.js';

// Detects the prompt's domain so we can apply appropriate temperature and
// domain-specific construction rules. Order matters — more specific noun-based
// domains (communication, creative) are checked before generic verb-based ones
// (coding, research) because "write a story" and "write an email" both start
// with the generic verb "write".

export function detectDomain(text: string): DomainInfo {
  const t = (text || '').toLowerCase();

  // Communication FIRST — specific nouns (email, letter, memo) beat generic "write"
  if (
    /\b(email|letter|cover letter|resignation|memo|announcement|apology|reply|respond to|follow.?up|message to|write to|slack message|linkedin|cold outreach|proposal to|recommendation letter)\b/.test(t)
  ) {
    return { domain: 'communication', temperature: 0.35 };
  }

  // Creative — before coding because "write a story/poem" starts with "write"
  if (
    /\b(story|poem|essay|blog post|article|creative|fiction|narrative|character|plot|chapter|screenplay|song|lyrics|haiku|sonnet|short story|write about|write a (poem|story|essay|song|letter to santa))\b/.test(t)
  ) {
    return { domain: 'creative', temperature: 0.5 };
  }

  // Debugging — very specific signals, safe to check anywhere
  if (
    /\b(fix (this|the|my|a) (bug|error|issue|code|function)|debug|exception|traceback|stack trace|not working|failing|broken|undefined is not|null pointer|type error|syntax error|runtime error|why (does|is|isn't|doesn't)|error:|Error:)\b/.test(t)
  ) {
    return { domain: 'debugging', temperature: 0.15 };
  }

  // Coding — only after communication/creative ruled out; needs technical signals
  if (
    // The `(\w+[- ]){0,4}` before each noun lets modifiers sit between the article and
    // the noun — "build a todo app", "create an ecommerce website" — not just "build an app".
    /\b(function|class|component|api|endpoint|refactor|optimize|implement|code|script|program|algorithm|database|query|backend|frontend|full.?stack|build (a |an |the )?(\w+[- ]){0,4}(app|website|tool|bot|cli|server|api|component|feature)|create (a |an |the )?(\w+[- ]){0,4}(app|website|tool|bot|script|function|class|api)|develop)\b/.test(t)
  ) {
    return { domain: 'coding', temperature: 0.15 };
  }

  // Planning
  if (
    /\b(plan|strategy|roadmap|steps to|process for|workflow|framework|approach|checklist|outline|how (should|do) i|action items)\b/.test(t)
  ) {
    return { domain: 'planning', temperature: 0.3 };
  }

  // Research / explanation
  if (
    /\b(explain|what is|what are|how does|how do|compare|summarize|analyze|research|review|difference between|pros and cons|overview of|define|tell me about|give me an overview)\b/.test(t)
  ) {
    return { domain: 'research', temperature: 0.2 };
  }

  return { domain: 'general', temperature: 0.25 };
}

export const DOMAIN_GUIDANCE: Record<Domain, string> = {
  debugging: `This is a DEBUGGING prompt.
- Preserve exact error messages, code snippets, and stack traces verbatim.
- The improved prompt should ask for: root cause identification, step-by-step diagnosis, and a concrete fix with explanation.
- Do not simplify technical details — precision is critical here.`,

  coding: `This is a CODE GENERATION prompt.
- Preserve the exact language, framework, and architectural requirements.
- The improved prompt should specify: language/version, coding style, error handling expectations, whether tests are needed, and output format (complete file vs snippet).
- Do not add features or requirements the user didn't mention.`,

  creative: `This is a CREATIVE WRITING prompt.
- Preserve the creative freedom — do not over-constrain the output.
- The improved prompt should clarify: genre/form, tone/mood, POV, target length, and any stylistic preferences the user stated.
- Leave intentional ambiguity — good creative prompts suggest, they don't dictate every detail.`,

  communication: `This is a COMMUNICATION/DRAFTING prompt.
- The improved prompt should specify: recipient relationship, desired tone (formal/casual/warm), key message to convey, desired length, and any specific call-to-action.
- Preserve the user's voice — don't make it sound like a template.`,

  planning: `This is a PLANNING/STRATEGY prompt.
- The improved prompt should specify: the goal/outcome, constraints (time, budget, resources), stakeholders, and desired output format (numbered steps, flowchart description, table).
- Include the specific context the user provided about their situation.`,

  research: `This is a RESEARCH/EXPLANATION prompt.
- The improved prompt should specify: audience expertise level, desired depth (quick overview vs comprehensive analysis), preferred format (bullet summary, essay, comparison table), and any scope constraints.
- If the user wants citations or sources, include that explicitly.`,

  general: `This is a GENERAL prompt.
- Structure it clearly with: a role/context framing, a precise task statement, the relevant context the user provided, and an explicit output format.`,
};
