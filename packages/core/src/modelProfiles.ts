import type { ModelProfile } from './types.js';

// Formatting rules derived from each platform's official prompting documentation.
// These are passed to the LLM so the improved prompt is structured the way the
// target model actually responds best to.
//
// Defined once per canonical model, then mapped from every hostname that serves it —
// this removes the duplicated ChatGPT / DeepSeek / Grok entries the prototype had.

const CANONICAL: Record<string, ModelProfile> = {
  chatgpt: {
    name: 'ChatGPT (GPT-4o)',
    profile:
      'Apply OpenAI best practices: (1) Open with a role assignment: "You are an expert [role]." (2) Use triple-quote or markdown delimiters to separate instructions from content. (3) State the exact output format (bullet list, numbered steps, JSON, table, prose). (4) Specify length and audience ("in 3 paragraphs", "for a non-technical reader"). (5) For multi-step tasks add "Think step by step" or list the steps explicitly. (6) Prefer active, direct instructions over vague requests.',
  },
  claude: {
    name: 'Claude',
    profile:
      'Apply Anthropic best practices: (1) Wrap distinct sections in XML tags, e.g. <context>…</context> <task>…</task> <format>…</format>. (2) Be direct — state exactly what you want without hinting. (3) Specify explicit constraints: what to include, what to avoid, tone, length. (4) For reasoning tasks prepend "Think through this step by step before answering." (5) Provide a concrete example of the ideal output when format matters.',
  },
  gemini: {
    name: 'Gemini',
    profile:
      'Apply Google PTCF framework: Persona ("You are a…"), Task (clear action verb), Context (background, constraints, audience), Format (bullet list / table / paragraph count / JSON). Be specific about the desired output structure. For complex tasks break into numbered sub-steps. End with the exact format line: "Format your response as [format]."',
  },
  grok: {
    name: 'Grok',
    profile:
      'Apply Grok best practices: (1) Ask directly — Grok prefers sharp, opinionated questions over open-ended ones. (2) For real-time topics, include "using the latest available information". (3) Use comparative framing: "Compare X and Y" or "What is the best X for Y use case". (4) Technical depth is welcome — include relevant stack/version details. (5) Avoid filler — every sentence should carry a concrete constraint or requirement.',
  },
  perplexity: {
    name: 'Perplexity',
    profile:
      'Apply Perplexity best practices: (1) Scope the search domain explicitly ("in peer-reviewed papers", "on official documentation sites", "from news after 2024"). (2) Ask for citations or sources inline. (3) Use research framing: "Provide an evidence-based summary of…". (4) Specify recency: "as of [year]" or "most recent developments". (5) Comparative and "pros/cons" questions surface Perplexity\'s citation strength best.',
  },
  copilot: {
    name: 'Microsoft Copilot',
    profile:
      'Apply Microsoft Copilot best practices: (1) Set clear Goal, Context, Source, Expectation (GCSE structure). (2) Be concise and task-oriented — one clear ask per prompt. (3) Specify output format: action items, email draft, summary table, meeting agenda. (4) Add business context (role, team, deadline) to get work-appropriate output. (5) Reference specific documents or data sources when available.',
  },
  mistral: {
    name: 'Mistral',
    profile:
      'Apply Mistral best practices: (1) Use a clear system-style opener: "You are a [role]. Your task is to [task].". (2) Be unambiguous — Mistral follows instructions literally, so vague wording produces vague output. (3) Specify output format explicitly (JSON schema, markdown table, numbered list, prose paragraphs). (4) For code tasks, state language, version, and style guide. (5) Multilingual instructions are fine — match the language of the desired output.',
  },
  deepseek: {
    name: 'DeepSeek',
    profile:
      'Apply DeepSeek best practices: (1) State the task clearly and provide complete context in the prompt. (2) Specify output structure explicitly (bullets, table, JSON, or sections). (3) Include constraints like length, tone, and must-include points. (4) For technical prompts, include stack/version and expected behavior. (5) Ask for concise reasoning and a final answer format line.',
  },
  poe: {
    name: 'Poe',
    profile:
      'Apply Poe multi-model best practices: (1) Make the prompt fully self-contained — no implicit context. (2) State role, task, constraints, and output format explicitly since different underlying models are available. (3) Avoid model-specific syntax (no XML tags, no triple-quote delimiters) to stay portable. (4) Specify the exact output structure with an example if possible. (5) Keep instructions short and unambiguous.',
  },
};

/** Maps a (www-stripped) hostname to its canonical model key. */
const HOST_TO_MODEL: Record<string, keyof typeof CANONICAL> = {
  'chatgpt.com': 'chatgpt',
  'chat.openai.com': 'chatgpt',
  'claude.ai': 'claude',
  'gemini.google.com': 'gemini',
  'grok.com': 'grok',
  'x.ai': 'grok',
  'perplexity.ai': 'perplexity',
  'copilot.microsoft.com': 'copilot',
  'chat.mistral.ai': 'mistral',
  'chat.deepseek.com': 'deepseek',
  'deepseek.com': 'deepseek',
  'poe.com': 'poe',
};

const FALLBACK_PROFILE: ModelProfile = {
  name: 'AI Assistant',
  profile:
    'Write a clear, well-structured, specific prompt. Include context, desired format, and intended audience.',
};

/** Strip a leading "www." so lookups are canonical. */
export function canonicalHostname(hostname: string): string {
  return hostname.replace(/^www\./, '');
}

/** Look up the formatting profile for a hostname; never returns null. */
export function getModelProfile(hostname: string): ModelProfile {
  const host = canonicalHostname(hostname);
  const key = HOST_TO_MODEL[host];
  return (key && CANONICAL[key]) || FALLBACK_PROFILE;
}

/** The human-facing model name for a hostname (e.g. "Claude"), for UI copy. */
export function getModelName(hostname: string): string {
  return getModelProfile(hostname).name;
}

/** All hostnames Pause knows how to format for — used by handoff target lists. */
export function knownHostnames(): string[] {
  return Object.keys(HOST_TO_MODEL);
}

export { CANONICAL as MODEL_PROFILES_BY_MODEL, HOST_TO_MODEL };
