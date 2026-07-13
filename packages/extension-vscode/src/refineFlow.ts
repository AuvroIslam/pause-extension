import * as vscode from 'vscode';
import {
  buildAnswersBlock,
  getModelName,
  getModelProfile,
  improvePrompt,
  maxQuestionsFor,
  nextQuestion,
  scoreLabel,
  scorePrompt,
  type ClarifyQuestion,
} from '@pause/core';
import { friendlyError, getConfig, makeCallAI } from './ai.js';

const SKIP = '__skip__';

/**
 * Run the full adaptive clarify → improve flow using native VS Code UI
 * (InputBox + QuickPick). Returns the improved prompt, or undefined if cancelled.
 */
export async function runRefineFlow(seed?: string): Promise<string | undefined> {
  const { verbosity, proxyUrl, targetModel } = getConfig();
  const callAI = makeCallAI(proxyUrl);
  const modelName = getModelName(targetModel);
  const modelProfile = getModelProfile(targetModel).profile;

  // 1. Get the rough prompt.
  const originalText =
    seed ??
    (await vscode.window.showInputBox({
      title: 'Pause — Refine a Prompt',
      prompt: `What do you want to ask the AI? Pause will clarify it and format it for ${modelName}.`,
      placeHolder: 'e.g. write a function to sort users',
      ignoreFocusOut: true,
    }));
  if (!originalText || originalText.trim().length < 3) return undefined;

  const questions: ClarifyQuestion[] = [];
  const answers: string[] = [];
  const maxQ = maxQuestionsFor(verbosity);

  // 2. Adaptive question loop.
  try {
    const improved = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Pause', cancellable: true },
      async (progress, token) => {
        while (questions.length < maxQ) {
          if (token.isCancellationRequested) return undefined;
          progress.report({ message: 'Thinking about your prompt…' });

          const previousQA = questions.map((q, i) => ({
            question: q.text,
            answer: (answers[i] || '').trim(),
          }));
          const res = await nextQuestion(callAI, {
            promptText: originalText,
            modelProfileName: modelName,
            previousQA,
            questionIndex: questions.length,
            verbosity,
          });
          if (res.done) break;

          questions.push(res.question);
          const answer = await askQuestion(res.question, questions.length, maxQ);
          if (answer === undefined) return undefined; // user escaped
          answers.push(answer);
        }

        progress.report({ message: `Formatting for ${modelName}…` });
        return improvePrompt(callAI, {
          originalText,
          answersBlock: buildAnswersBlock(questions, answers),
          modelProfile,
          answeredCount: answers.filter((a) => a && a.trim() && a !== SKIP).length,
          totalQuestions: questions.length,
          verbosity,
        });
      },
    );

    if (!improved) return undefined;

    const before = scorePrompt(originalText);
    const after = scorePrompt(improved);
    void vscode.window.setStatusBarMessage(
      `Pause: ${before}% ${scoreLabel(before)} → ${after}% ${scoreLabel(after)}`,
      6000,
    );
    return improved;
  } catch (err) {
    void vscode.window.showErrorMessage(`Pause: ${friendlyError(err)}`);
    return undefined;
  }
}

/** Present one clarifying question as a QuickPick with a free-text escape hatch. */
async function askQuestion(
  q: ClarifyQuestion,
  index: number,
  total: number,
): Promise<string | undefined> {
  const CUSTOM = '$(edit) Type my own answer…';
  const SKIP_LABEL = '$(debug-step-over) Skip this question';

  const picked = await vscode.window.showQuickPick(
    [...q.suggestions, CUSTOM, SKIP_LABEL],
    {
      title: `Pause — Question ${index} of up to ${total}`,
      placeHolder: q.text + (q.multiSelect ? '  (pick the closest; refine after)' : ''),
      ignoreFocusOut: true,
    },
  );
  if (picked === undefined) return undefined;
  if (picked === SKIP_LABEL) return SKIP;
  if (picked === CUSTOM) {
    const typed = await vscode.window.showInputBox({
      title: q.text,
      prompt: 'Your answer',
      ignoreFocusOut: true,
    });
    return typed ?? undefined;
  }
  return picked;
}

/** Command entry: refine, then let the user insert / copy the result. */
export async function refineAndDeliver(seed?: string): Promise<void> {
  const improved = await runRefineFlow(seed);
  if (!improved) return;

  const INSERT = 'Insert at cursor';
  const COPY = 'Copy to clipboard';
  const choice = await vscode.window.showInformationMessage(
    'Pause improved your prompt.',
    { modal: false, detail: improved },
    INSERT,
    COPY,
  );

  if (choice === COPY) {
    await vscode.env.clipboard.writeText(improved);
    void vscode.window.setStatusBarMessage('Pause: improved prompt copied', 3000);
  } else if (choice === INSERT) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await editor.edit((b) => b.replace(editor.selection, improved));
    } else {
      await vscode.env.clipboard.writeText(improved);
      void vscode.window.showInformationMessage('No active editor — copied to clipboard instead.');
    }
  }
}
