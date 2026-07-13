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

/**
 * Drop text into VS Code's built-in chat input. Only the native chat (Copilot) can be
 * driven this way — other agents (Claude Code, Codex, …) render their own webviews, which
 * VS Code sandboxes, so no extension can type into them. Those rely on the clipboard.
 */
async function sendToChat(text: string): Promise<boolean> {
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: text });
    return true;
  } catch {
    return false;
  }
}

/** Command entry: refine, then let the user send / insert / paste the result. */
export async function refineAndDeliver(seed?: string): Promise<void> {
  const improved = await runRefineFlow(seed);
  if (!improved) return;

  // Always copy first: the refined prompt is the whole point of the flow, and pasting is
  // the only way into non-native agent panels. Every path below is then a shortcut.
  await vscode.env.clipboard.writeText(improved);

  const SEND = 'Send to Chat';
  const INSERT = 'Insert at cursor';
  const choice = await vscode.window.showInformationMessage(
    'Pause improved your prompt — copied, ready to paste.',
    { modal: false, detail: improved },
    SEND,
    INSERT,
  );

  if (choice === SEND) {
    const sent = await sendToChat(improved);
    if (!sent) {
      void vscode.window.showInformationMessage(
        'No built-in chat available — the prompt is on your clipboard, paste it into your agent.',
      );
    }
  } else if (choice === INSERT) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await editor.edit((b) => b.replace(editor.selection, improved));
    } else {
      void vscode.window.showInformationMessage('No active editor — the prompt is on your clipboard.');
    }
  }
}
