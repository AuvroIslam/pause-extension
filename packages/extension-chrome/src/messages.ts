import type { ClarifyQuestion, QAPair, TranscriptTurn, Verbosity } from '@pause/core';

// ─── Content → Background request/response contracts ────────────────────────────

export interface NextQuestionReq {
  type: 'NEXT_QUESTION';
  promptText: string;
  modelProfileName?: string;
  previousQA: QAPair[];
  questionIndex: number;
  verbosity: Verbosity;
}
export type NextQuestionRes =
  | { ok: true; done: true }
  | { ok: true; done: false; question: ClarifyQuestion }
  | { ok: false; error: string };

export interface ImprovePromptReq {
  type: 'IMPROVE_PROMPT';
  originalText: string;
  answersBlock: string;
  modelProfile: string;
  answeredCount: number;
  totalQuestions: number;
  verbosity: Verbosity;
}
export type ImprovePromptRes =
  | { ok: true; improvedPrompt: string }
  | { ok: false; error: string };

export interface BuildHandoffReq {
  type: 'BUILD_HANDOFF';
  transcript: TranscriptTurn[];
  targetHostname: string;
  pendingUserText?: string;
  verbosity: Verbosity;
}
export type BuildHandoffRes =
  | { ok: true; continuationPrompt: string }
  | { ok: false; error: string };

export interface PingReq {
  type: 'PING';
}

export type PauseRequest = NextQuestionReq | ImprovePromptReq | BuildHandoffReq | PingReq;
