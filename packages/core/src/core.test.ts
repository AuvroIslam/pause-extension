import { describe, expect, it, vi } from 'vitest';
import { getModelName, getModelProfile } from './modelProfiles.js';
import { buildAnswersBlock, cleanImprovedPrompt } from './prompts.js';
import { transcriptToText, buildHandoffContext } from './handoff.js';
import { improvePrompt, nextQuestion } from './orchestrator.js';
import type { CallAI } from './types.js';

describe('modelProfiles', () => {
  it('maps hostnames (incl. www) to canonical models', () => {
    expect(getModelName('claude.ai')).toBe('Claude');
    expect(getModelName('www.deepseek.com')).toBe('DeepSeek');
    expect(getModelName('chat.openai.com')).toBe('ChatGPT (GPT-4o)');
  });
  it('falls back for unknown hosts', () => {
    expect(getModelProfile('example.com').name).toBe('AI Assistant');
  });
});

describe('prompts helpers', () => {
  it('cleanImprovedPrompt strips meta prefixes, quotes, fences', () => {
    expect(cleanImprovedPrompt('Here is your improved prompt: "Do the thing"')).toBe('Do the thing');
    expect(cleanImprovedPrompt('```\nDo the thing\n```')).toBe('Do the thing');
  });
  it('buildAnswersBlock skips empties and maps __skip__', () => {
    const block = buildAnswersBlock(
      [{ text: 'Q1' }, { text: 'Q2' }, { text: 'Q3' }],
      ['TypeScript', '', '__skip__'],
    );
    expect(block).toContain('Q1');
    expect(block).toContain('TypeScript');
    expect(block).not.toContain('Q2');
    expect(block).toContain('choose the most suitable');
  });
});

describe('transcriptToText', () => {
  it('trims oldest turns when over budget', () => {
    const turns = Array.from({ length: 50 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `message number ${i} `.repeat(20),
    }));
    const out = transcriptToText(turns, 1000);
    expect(out.length).toBeLessThanOrEqual(1200);
    expect(out).toContain('trimmed');
    // Most recent turn must survive.
    expect(out).toContain('message number 49');
  });
});

describe('orchestrator.nextQuestion', () => {
  it('returns done when the model says so', async () => {
    const callAI: CallAI = vi.fn(async () => JSON.stringify({ done: true }));
    const res = await nextQuestion(callAI, { promptText: 'x', previousQA: [], questionIndex: 0 });
    expect(res.done).toBe(true);
  });
  it('parses a valid question', async () => {
    const callAI: CallAI = vi.fn(async () =>
      JSON.stringify({
        done: false,
        question: { text: 'Which language?', multiSelect: false, suggestions: ['TS', 'Py'] },
      }),
    );
    const res = await nextQuestion(callAI, {
      promptText: 'build an app',
      previousQA: [],
      questionIndex: 0,
    });
    expect(res.done).toBe(false);
    if (!res.done) {
      expect(res.question.text).toBe('Which language?');
      expect(res.question.suggestions).toHaveLength(2);
    }
  });
  it('throws BAD_RESPONSE on malformed JSON', async () => {
    const callAI: CallAI = vi.fn(async () => 'not json');
    await expect(
      nextQuestion(callAI, { promptText: 'x', previousQA: [], questionIndex: 0 }),
    ).rejects.toThrow('BAD_RESPONSE');
  });
});

describe('orchestrator.improvePrompt + handoff wiring', () => {
  it('improvePrompt cleans the model output', async () => {
    const callAI: CallAI = vi.fn(async () => 'Improved prompt: Do X for Y.');
    const out = await improvePrompt(callAI, {
      originalText: 'do x',
      answersBlock: '(none)',
      modelProfile: '',
      answeredCount: 0,
      totalQuestions: 0,
    });
    expect(out).toBe('Do X for Y.');
  });

  it('buildHandoffContext sends target-formatted request and returns text', async () => {
    const callAI: CallAI = vi.fn(async () => 'Continuing our chat: I need the next step.');
    const out = await buildHandoffContext(callAI, {
      transcript: [
        { role: 'user', text: 'help me build a CLI' },
        { role: 'assistant', text: 'sure, what language?' },
      ],
      targetHostname: 'claude.ai',
    });
    expect(out).toContain('Continuing our chat');
    // The system prompt must mention the target model name.
    const firstCall = (callAI as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const messages = firstCall[0] as { content: string }[];
    expect(messages[0].content).toContain('Claude');
  });
});
