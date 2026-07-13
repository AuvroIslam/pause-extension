// Pause — MV3 service worker (thin adapter over @pause/core).
// All AI reasoning lives in core; this file only wires Chrome messaging → core,
// injects the proxy-backed CallAI, and keeps the worker alive during sessions.

import {
  buildHandoffContext,
  createProxyClient,
  improvePrompt,
  nextQuestion,
} from '@pause/core';
import type {
  BuildHandoffReq,
  BuildHandoffRes,
  ImprovePromptReq,
  ImprovePromptRes,
  NextQuestionReq,
  NextQuestionRes,
  PauseRequest,
} from './messages.js';

// All AI calls route through the Vercel proxy — no API keys in the extension.
const PROXY_URL = 'https://pause-proxy.vercel.app/api/ai';

const callAI = createProxyClient({ proxyUrl: PROXY_URL, fetchImpl: fetch, timeoutMs: 20000 });

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html?welcome=1') }).catch(() => {});
  }
});

// ─── Handlers ──────────────────────────────────────────────────────────────────

async function handleNextQuestion(
  msg: NextQuestionReq,
  send: (r: NextQuestionRes) => void,
): Promise<void> {
  try {
    const res = await nextQuestion(callAI, {
      promptText: msg.promptText,
      modelProfileName: msg.modelProfileName,
      previousQA: msg.previousQA,
      questionIndex: msg.questionIndex,
      verbosity: msg.verbosity,
    });
    send(res.done ? { ok: true, done: true } : { ok: true, done: false, question: res.question });
  } catch (err) {
    send({ ok: false, error: errMessage(err) });
  }
}

async function handleImprovePrompt(
  msg: ImprovePromptReq,
  send: (r: ImprovePromptRes) => void,
): Promise<void> {
  try {
    const improvedPrompt = await improvePrompt(callAI, {
      originalText: msg.originalText,
      answersBlock: msg.answersBlock,
      modelProfile: msg.modelProfile,
      answeredCount: msg.answeredCount,
      totalQuestions: msg.totalQuestions,
      verbosity: msg.verbosity,
    });
    send({ ok: true, improvedPrompt });
  } catch (err) {
    send({ ok: false, error: errMessage(err) });
  }
}

async function handleBuildHandoff(
  msg: BuildHandoffReq,
  send: (r: BuildHandoffRes) => void,
): Promise<void> {
  try {
    const continuationPrompt = await buildHandoffContext(callAI, {
      transcript: msg.transcript,
      targetHostname: msg.targetHostname,
      pendingUserText: msg.pendingUserText,
      verbosity: msg.verbosity,
    });
    send({ ok: true, continuationPrompt });
  } catch (err) {
    send({ ok: false, error: errMessage(err) });
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'UNKNOWN';
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: PauseRequest, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  switch (msg.type) {
    case 'PING':
      return false; // just resets the idle timer
    case 'NEXT_QUESTION':
      handleNextQuestion(msg, sendResponse);
      return true;
    case 'IMPROVE_PROMPT':
      handleImprovePrompt(msg, sendResponse);
      return true;
    case 'BUILD_HANDOFF':
      handleBuildHandoff(msg, sendResponse);
      return true;
    default:
      return false;
  }
});
