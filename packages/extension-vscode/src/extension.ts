import * as vscode from 'vscode';
import { makeChatHandler } from './chatParticipant.js';
import { PauseChatViewProvider } from './chatView.js';
import { refineAndDeliver } from './refineFlow.js';

export function activate(context: vscode.ExtensionContext): void {
  // The chat panel is the primary UI; the QuickPick flow remains for keyboard-only use.
  const chatView = new PauseChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PauseChatViewProvider.viewType, chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pause.openChat', (seed?: string) => {
      void chatView.focus(typeof seed === 'string' ? seed : undefined);
    }),
  );

  // Command: QuickPick refine flow (optionally seeded with text).
  context.subscriptions.push(
    vscode.commands.registerCommand('pause.refinePrompt', (seed?: string) => {
      void refineAndDeliver(typeof seed === 'string' ? seed : undefined);
    }),
  );

  // Command: refine the current editor selection — seeds the chat panel.
  context.subscriptions.push(
    vscode.commands.registerCommand('pause.refineSelection', () => {
      const editor = vscode.window.activeTextEditor;
      const selected = editor?.document.getText(editor.selection).trim();
      void chatView.focus(selected || undefined);
    }),
  );

  // Command: insert text at cursor (used by chat participant buttons).
  context.subscriptions.push(
    vscode.commands.registerCommand('pause.insertText', async (text: string) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && typeof text === 'string') {
        await editor.edit((b) => b.replace(editor.selection, text));
      } else if (typeof text === 'string') {
        await vscode.env.clipboard.writeText(text);
        void vscode.window.showInformationMessage('No active editor — copied to clipboard instead.');
      }
    }),
  );

  // Status bar entry — the always-visible entry point, next to the other agent items.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(debug-pause) Pause';
  status.tooltip = 'Pause: refine a prompt before you send it (Ctrl+Alt+P)';
  status.command = 'pause.openChat';
  status.show();
  context.subscriptions.push(status);

  // Chat participant: @pause
  try {
    const participant = vscode.chat.createChatParticipant('pause.assistant', makeChatHandler());
    participant.iconPath = new vscode.ThemeIcon('debug-pause');
    context.subscriptions.push(participant);
  } catch {
    // Chat API unavailable in this VS Code build — commands still work.
  }
}

export function deactivate(): void {
  /* no-op */
}
