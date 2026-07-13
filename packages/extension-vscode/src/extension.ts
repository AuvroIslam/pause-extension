import * as vscode from 'vscode';
import { makeChatHandler } from './chatParticipant.js';
import { refineAndDeliver } from './refineFlow.js';

export function activate(context: vscode.ExtensionContext): void {
  // Command: interactive refine flow (optionally seeded with text).
  context.subscriptions.push(
    vscode.commands.registerCommand('pause.refinePrompt', (seed?: string) => {
      void refineAndDeliver(typeof seed === 'string' ? seed : undefined);
    }),
  );

  // Command: refine the current editor selection.
  context.subscriptions.push(
    vscode.commands.registerCommand('pause.refineSelection', () => {
      const editor = vscode.window.activeTextEditor;
      const selected = editor?.document.getText(editor.selection).trim();
      void refineAndDeliver(selected || undefined);
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
