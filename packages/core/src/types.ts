// Shared types for the Pause core. No DOM / chrome / vscode dependencies here.

export type Domain =
  | 'debugging'
  | 'coding'
  | 'creative'
  | 'communication'
  | 'planning'
  | 'research'
  | 'general';

export interface DomainInfo {
  domain: Domain;
  /** Sampling temperature to use when building the improved prompt for this domain. */
  temperature: number;
}

export type ScoreLabel = 'Vague' | 'Weak' | 'Fair' | 'Good' | 'Excellent';

/** How verbose the improved prompt / clarification flow should be. */
export type Verbosity = 'concise' | 'thorough';

/** One clarifying question produced by the model. */
export interface ClarifyQuestion {
  text: string;
  multiSelect: boolean;
  suggestions: string[];
}

/** A previously asked question + the user's answer, fed back for the next question. */
export interface QAPair {
  question: string;
  answer: string;
}

/** Formatting profile for a target AI, derived from its official prompting docs. */
export interface ModelProfile {
  /** Human-facing model name, e.g. "Claude". */
  name: string;
  /** Formatting instructions passed to the LLM when rewriting the prompt. */
  profile: string;
}

/** A single message in a chat-completions style request. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Extra params forwarded to the provider (temperature, response_format, etc.). */
export interface CallParams {
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' | 'text' };
}

/**
 * Provider-agnostic AI call. Each host (Chrome SW, VSCode host) supplies its own
 * implementation that routes to the Vercel proxy. Returns the assistant text.
 * Should throw an Error whose message is a stable code (TIMEOUT, RATE_LIMIT,
 * SERVER_ERROR, NETWORK, BAD_RESPONSE) so the UI can map it to a friendly message.
 */
export type CallAI = (messages: ChatMessage[], params?: CallParams) => Promise<string>;

/** One turn of a captured conversation, used for the handoff feature. */
export interface TranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
}
