import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, scoreLabel, scorePrompt } from './scoring.js';

describe('scorePrompt', () => {
  it('returns 0 for empty / trivial input', () => {
    expect(scorePrompt('')).toBe(0);
    expect(scorePrompt('   ')).toBe(0);
    expect(scorePrompt('hi')).toBe(0);
  });

  it('scores a vague one-liner low', () => {
    expect(scorePrompt('fix my code')).toBeLessThan(40);
  });

  it('scores a rich, specific prompt high', () => {
    const good =
      'You are an expert TypeScript engineer. Refactor this React component for a senior developer audience. ' +
      'Output the complete file as a code block, under 80 lines, with error handling. Context: I am building a Next.js dashboard. ' +
      'Think step by step. For example, extract the fetch logic into a hook.';
    expect(scorePrompt(good)).toBeGreaterThanOrEqual(70);
  });

  it('never exceeds 100 or drops below 0', () => {
    const huge = 'You are an expert. '.repeat(200) + 'React TypeScript Python Django AWS Docker';
    const s = scorePrompt(huge);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });

  it('rewards adding structure and specificity (monotonic-ish)', () => {
    const vague = 'write an email';
    const better =
      'You are a university student. Write a formal email to my professor requesting a 3-day extension, ' +
      'polite tone, under 150 words, ending with a clear ask.';
    expect(scorePrompt(better)).toBeGreaterThan(scorePrompt(vague));
  });

  it('does not double-count a stack mention as both tech term and proper noun', () => {
    // "React" should count toward tech terms but not also inflate the specificity band.
    const withStack = scorePrompt('Build a React app that lists users');
    const withoutStack = scorePrompt('Build a mobile app that lists users');
    // The difference should be roughly the tech-term weight, not tech + proper-noun.
    expect(withStack - withoutStack).toBeLessThanOrEqual(DEFAULT_WEIGHTS.techTermEach + 1);
  });
});

describe('scoreLabel', () => {
  it('maps score bands to labels', () => {
    expect(scoreLabel(0)).toBe('Vague');
    expect(scoreLabel(25)).toBe('Weak');
    expect(scoreLabel(50)).toBe('Fair');
    expect(scoreLabel(70)).toBe('Good');
    expect(scoreLabel(90)).toBe('Excellent');
  });
});
