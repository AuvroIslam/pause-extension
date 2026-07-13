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

/** Messages the webview sends to the extension host. */
type InboundMessage =
  | { type: 'score'; text: string }
  | { type: 'start'; text: string }
  | { type: 'answer'; value: string }
  | { type: 'cancel' }
  | { type: 'reset' }
  | { type: 'action'; action: 'copy' | 'send' | 'insert'; text: string };

/**
 * The Pause chat panel. Runs the same adaptive clarify → improve flow as the QuickPick
 * command, but as a conversation: the questions and the rewrite render as chat turns,
 * and suggestions are clickable chips.
 */
export class PauseChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'pause.chatView';

  private view?: vscode.WebviewView;
  /** Resolves the answer the flow is currently waiting on. */
  private pendingAnswer?: (answer: string | undefined) => void;
  private running = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg: InboundMessage) => {
      switch (msg.type) {
        case 'score': {
          const score = scorePrompt(msg.text);
          this.post({ type: 'score', score, label: scoreLabel(score) });
          break;
        }
        case 'start':
          void this.run(msg.text);
          break;
        case 'answer':
          this.pendingAnswer?.(msg.value);
          this.pendingAnswer = undefined;
          break;
        case 'cancel':
          this.pendingAnswer?.(undefined);
          this.pendingAnswer = undefined;
          break;
        case 'reset':
          this.pendingAnswer?.(undefined);
          this.pendingAnswer = undefined;
          this.running = false;
          break;
        case 'action':
          void this.deliver(msg.action, msg.text);
          break;
      }
    });
  }

  /** Focus the panel and, if given, seed the composer with text. */
  public async focus(seed?: string): Promise<void> {
    await vscode.commands.executeCommand(`${PauseChatViewProvider.viewType}.focus`);
    if (seed) this.post({ type: 'seed', text: seed });
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  /** Wait for the user to answer the question currently on screen. */
  private waitForAnswer(): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.pendingAnswer = resolve;
    });
  }

  private async run(originalText: string): Promise<void> {
    if (this.running || originalText.trim().length < 3) return;
    this.running = true;

    const { verbosity, proxyUrl, targetModel } = getConfig();
    const callAI = makeCallAI(proxyUrl);
    const modelName = getModelName(targetModel);
    const modelProfile = getModelProfile(targetModel).profile;
    const maxQ = maxQuestionsFor(verbosity);

    const questions: ClarifyQuestion[] = [];
    const answers: string[] = [];

    try {
      while (questions.length < maxQ) {
        this.post({ type: 'thinking', label: 'Thinking about your prompt…' });

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
        this.post({
          type: 'question',
          text: res.question.text,
          suggestions: res.question.suggestions,
          index: questions.length,
          total: maxQ,
        });

        const answer = await this.waitForAnswer();
        if (answer === undefined) {
          this.post({ type: 'cancelled' });
          return;
        }
        answers.push(answer);
      }

      this.post({ type: 'thinking', label: `Formatting for ${modelName}…` });
      const improved = await improvePrompt(callAI, {
        originalText,
        answersBlock: buildAnswersBlock(questions, answers),
        modelProfile,
        answeredCount: answers.filter((a) => a && a.trim() && a !== SKIP).length,
        totalQuestions: questions.length,
        verbosity,
      });

      // Copy on completion: pasting is the only way into agent panels VS Code sandboxes.
      await vscode.env.clipboard.writeText(improved);
      const score = scorePrompt(improved);
      this.post({
        type: 'result',
        text: improved,
        score,
        label: scoreLabel(score),
        model: modelName,
      });
    } catch (err) {
      this.post({ type: 'error', message: friendlyError(err) });
    } finally {
      this.running = false;
    }
  }

  private async deliver(action: 'copy' | 'send' | 'insert', text: string): Promise<void> {
    if (action === 'copy') {
      await vscode.env.clipboard.writeText(text);
      void vscode.window.setStatusBarMessage('Pause: prompt copied', 2000);
      return;
    }
    if (action === 'send') {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: text });
      } catch {
        void vscode.window.showInformationMessage(
          'No built-in chat available — the prompt is on your clipboard, paste it into your agent.',
        );
      }
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await editor.edit((b) => b.replace(editor.selection, text));
    } else {
      void vscode.window.showInformationMessage('No active editor — the prompt is on your clipboard.');
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2) + Date.now().toString(36);
    // Strict CSP: no remote anything, and only our nonce'd inline script may run.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
    display: flex; flex-direction: column; height: 100vh;
  }
  #log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }

  .turn { display: flex; flex-direction: column; gap: 6px; }
  .bubble {
    padding: 8px 10px; border-radius: 6px; line-height: 1.45;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editorWidget-background);
    white-space: pre-wrap; word-break: break-word;
  }
  .bubble.user {
    background: var(--vscode-textBlockQuote-background);
    border-color: var(--vscode-focusBorder);
    align-self: flex-end; max-width: 88%;
  }
  .meta { font-size: 0.85em; opacity: 0.7; }
  .thinking { display: flex; align-items: center; gap: 6px; opacity: 0.75; font-style: italic; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100% { opacity: 0.3 } 50% { opacity: 1 } }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    padding: 4px 10px; border-radius: 12px; cursor: pointer; font: inherit;
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .chip:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .chip.skip { opacity: 0.7; font-style: italic; }

  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
  .btn {
    padding: 5px 10px; border-radius: 4px; cursor: pointer; font: inherit; border: none;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.ghost {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .err { color: var(--vscode-errorForeground); }

  /* Score meter */
  #meter { display: flex; align-items: center; gap: 8px; padding: 0 12px 6px; font-size: 0.85em; opacity: 0.9; }
  #track { flex: 1; height: 3px; border-radius: 2px; background: var(--vscode-panel-border); overflow: hidden; }
  #fill { height: 100%; width: 0%; background: var(--vscode-charts-red); transition: width .2s, background .2s; }

  #composer { display: flex; gap: 6px; padding: 8px 12px 12px; border-top: 1px solid var(--vscode-panel-border); }
  #input {
    flex: 1; resize: none; min-height: 54px; padding: 6px 8px; border-radius: 4px; font: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  }
  #input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .empty { opacity: 0.6; padding: 16px 4px; line-height: 1.5; }
</style>
</head>
<body>
  <div id="log">
    <div class="empty" id="empty">
      Type a rough prompt below. Pause scores it, asks a question or two, then rewrites it
      for your target model — and copies the result so you can paste it into any agent.
    </div>
  </div>

  <div id="meter" hidden>
    <span id="scoreText">0</span>
    <div id="track"><div id="fill"></div></div>
  </div>

  <div id="composer">
    <textarea id="input" placeholder="e.g. build a todo app&#10;Ctrl+Enter to refine"></textarea>
    <button class="btn" id="go">Refine</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const go = document.getElementById('go');
  const meter = document.getElementById('meter');
  const fill = document.getElementById('fill');
  const scoreText = document.getElementById('scoreText');
  const empty = document.getElementById('empty');
  let thinkingEl = null;
  // The score meter describes the PROMPT. While the flow is running, the composer holds
  // answers, not prompts — scoring those is meaningless, so the meter stays hidden.
  let awaitingAnswer = false;

  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const hideMeter = () => { meter.hidden = true; };
  const clearThinking = () => { if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } };

  function bubble(text, cls) {
    empty.hidden = true;
    const turn = document.createElement('div');
    turn.className = 'turn';
    const b = document.createElement('div');
    b.className = 'bubble ' + (cls || '');
    b.textContent = text;
    turn.appendChild(b);
    log.appendChild(turn);
    scroll();
    return turn;
  }

  function colorFor(score) {
    if (score >= 67) return 'var(--vscode-charts-green)';
    if (score >= 34) return 'var(--vscode-charts-yellow)';
    return 'var(--vscode-charts-red)';
  }

  // Live local scoring as you type (no network).
  input.addEventListener('input', () => {
    const text = input.value.trim();
    if (!text || awaitingAnswer) { hideMeter(); return; }
    vscode.postMessage({ type: 'score', text });
  });

  function start() {
    const text = input.value.trim();
    if (text.length < 3) return;
    bubble(text, 'user');
    input.value = '';
    hideMeter();
    go.disabled = true;
    vscode.postMessage({ type: 'start', text });
  }

  go.addEventListener('click', start);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); start(); }
  });

  function answer(value, label) {
    document.querySelectorAll('.chips').forEach((c) => c.remove());
    awaitingAnswer = false;
    hideMeter();
    bubble(label, 'user');
    vscode.postMessage({ type: 'answer', value });
  }

  window.addEventListener('message', (event) => {
    const m = event.data;

    if (m.type === 'seed') { input.value = m.text; input.focus(); vscode.postMessage({ type: 'score', text: m.text }); return; }

    if (m.type === 'score') {
      meter.hidden = false;
      fill.style.width = m.score + '%';
      fill.style.background = colorFor(m.score);
      scoreText.textContent = m.score + ' · ' + m.label;
      return;
    }

    if (m.type === 'thinking') {
      clearThinking();
      thinkingEl = document.createElement('div');
      thinkingEl.className = 'thinking';
      const dot = document.createElement('span');
      dot.className = 'dot';
      thinkingEl.appendChild(dot);
      thinkingEl.appendChild(document.createTextNode(m.label));
      log.appendChild(thinkingEl);
      scroll();
      return;
    }

    if (m.type === 'question') {
      clearThinking();
      awaitingAnswer = true;
      hideMeter();
      const turn = bubble(m.text);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = 'Question ' + m.index + ' of up to ' + m.total;
      turn.insertBefore(meta, turn.firstChild);

      const chips = document.createElement('div');
      chips.className = 'chips';
      (m.suggestions || []).forEach((s) => {
        const c = document.createElement('button');
        c.className = 'chip';
        c.textContent = s;
        c.addEventListener('click', () => answer(s, s));
        chips.appendChild(c);
      });
      const skip = document.createElement('button');
      skip.className = 'chip skip';
      skip.textContent = 'Skip';
      skip.addEventListener('click', () => answer('__skip__', 'Skipped'));
      chips.appendChild(skip);
      turn.appendChild(chips);

      // Typing a custom answer instead of picking a chip.
      const onKey = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && input.value.trim()) {
          e.preventDefault();
          const v = input.value.trim();
          input.value = '';
          input.removeEventListener('keydown', onKey);
          answer(v, v);
        }
      };
      input.addEventListener('keydown', onKey);
      input.placeholder = 'Pick an option, or type your own answer…';
      input.focus();
      scroll();
      return;
    }

    if (m.type === 'result') {
      clearThinking();
      go.disabled = false;
      awaitingAnswer = false;
      hideMeter();
      input.placeholder = 'e.g. build a todo app\\nCtrl+Enter to refine';

      const turn = bubble(m.text);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = 'Rewritten for ' + m.model + ' · score ' + m.score + ' · ' + m.label + ' · copied to clipboard';
      turn.insertBefore(meta, turn.firstChild);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const mk = (label, action, cls) => {
        const b = document.createElement('button');
        b.className = 'btn ' + (cls || '');
        b.textContent = label;
        b.addEventListener('click', () => vscode.postMessage({ type: 'action', action, text: m.text }));
        return b;
      };
      actions.appendChild(mk('Send to Chat', 'send'));
      actions.appendChild(mk('Copy', 'copy', 'ghost'));
      actions.appendChild(mk('Insert at cursor', 'insert', 'ghost'));
      turn.appendChild(actions);
      scroll();
      return;
    }

    if (m.type === 'error') {
      clearThinking();
      go.disabled = false;
      awaitingAnswer = false;
      const turn = bubble(m.message);
      turn.querySelector('.bubble').classList.add('err');
      return;
    }

    if (m.type === 'cancelled') {
      clearThinking();
      go.disabled = false;
      awaitingAnswer = false;
    }
  });
</script>
</body>
</html>`;
  }
}
