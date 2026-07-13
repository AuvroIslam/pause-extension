import { describe, expect, it } from 'vitest';
import { detectDomain } from './domain.js';
import type { Domain } from './types.js';

const CASES: Array<[string, Domain]> = [
  ['write an email to my professor about an extension', 'communication'],
  ['draft a resignation letter', 'communication'],
  ['write a short story about a lonely lighthouse', 'creative'],
  ['compose a poem about autumn', 'creative'],
  ['fix this bug in my python function', 'debugging'],
  ['why does my app keep failing on startup', 'debugging'],
  ['build a react component for a todo list', 'coding'],
  ['implement a binary search algorithm', 'coding'],
  ['make a plan to launch my startup in 3 months', 'planning'],
  ['what is the difference between TCP and UDP', 'research'],
  ['explain how photosynthesis works', 'research'],
  ['give me some ideas for dinner', 'general'],
];

describe('detectDomain', () => {
  it.each(CASES)('classifies %j as %s', (text, expected) => {
    expect(detectDomain(text).domain).toBe(expected);
  });

  it('assigns lower temperature to precise domains than creative', () => {
    expect(detectDomain('fix this bug').temperature).toBeLessThan(
      detectDomain('write a poem').temperature,
    );
  });

  it('prefers communication over coding for "write an email API key request"', () => {
    // "email" (communication noun) must win over "api" (coding signal).
    expect(detectDomain('write an email to get an api key').domain).toBe('communication');
  });

  it.each([
    'build a todo app',
    'build an ecommerce website',
    'create a chat bot',
    'build a real-time collaborative editor tool',
  ])('detects coding when modifiers sit between the article and the noun: %j', (text) => {
    // Regression: the pattern used to require the noun immediately after the article,
    // so "build an app" matched but "build a todo app" fell through to 'general'.
    expect(detectDomain(text).domain).toBe('coding');
  });
});
