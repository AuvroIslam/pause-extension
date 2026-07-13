import * as vscode from 'vscode';
import {
  buildAnswersBlock,
  getModelName,
  getModelProfile,
  improvePrompt,
  nextQuestion,
  scoreLabel,
  scorePrompt,
} from '@pause/core';
import { friendlyError, getConfig, makeCallAI } from './ai.js';

/**
 * @pause chat participant. One-shot: scores the draft, rewrites it for the target
 * model, and surfaces the top clarifying questions the user could answer to sharpen
 * it further. Buttons let them insert the result or launch the full interactive flow.
 */
export function makeChatHandler(): vscode.ChatRequestHandler {
  return async (request, _context, stream, token) => {
    const draft = request.prompt.trim();
    if (!draft) {
      stream.markdown(
        'Give me a rough prompt and I’ll sharpen it — e.g. `@pause write a function to sort users`.',
      );
      return;
    }

    const { verbosity, proxyUrl, targetModel } = getConfig();
    const callAI = makeCallAI(proxyUrl);
    const modelName = getModelName(targetModel);
    const modelProfile = getModelProfile(targetModel).profile;

    const before = scorePrompt(draft);
    stream.progress(`Refining for ${modelName}…`);

    try {
      // Improve in one shot (no interactive answers — still restructures well).
      const improved = await improvePrompt(callAI, {
        originalText: draft,
        answersBlock: buildAnswersBlock([], []),
        modelProfile,
        answeredCount: 0,
        totalQuestions: 0,
        verbosity,
      });
      if (token.isCancellationRequested) return;

      const after = scorePrompt(improved);
      stream.markdown(`**Prompt quality:** ${before}% ${scoreLabel(before)} → **${after}% ${scoreLabel(after)}**\n\n`);
      stream.markdown(`**Improved prompt** (formatted for ${modelName}):\n\n`);
      stream.markdown('```text\n' + improved + '\n```\n');

      // Surface the single most useful clarifying question so the user knows what
      // would sharpen it further, without a full interactive loop.
      try {
        const q = await nextQuestion(callAI, {
          promptText: draft,
          modelProfileName: modelName,
          previousQA: [],
          questionIndex: 0,
          verbosity,
        });
        if (!q.done) {
          stream.markdown(`\n💡 *To sharpen it further:* ${q.question.text}\n`);
        }
      } catch {
        /* non-fatal — the improved prompt already streamed */
      }

      stream.button({
        command: 'pause.insertText',
        title: 'Insert at cursor',
        arguments: [improved],
      });
      stream.button({
        command: 'pause.refinePrompt',
        title: 'Run full refinement…',
        arguments: [draft],
      });
    } catch (err) {
      stream.markdown(`⚠️ ${friendlyError(err)}`);
    }
  };
}
