import { describe, expect, it } from 'vitest';
import { containsMatch, exactMatch, parseJudgeScore, regexMatch, tokenF1, validJSON } from './scoring';

describe('scorers', () => {
  it('exact match normalizes whitespace, case and trailing punctuation', () => {
    expect(exactMatch('  Paris. ', 'paris')).toBe(1);
    expect(exactMatch('Paris', 'paris', true)).toBe(0);
    expect(exactMatch('London', 'Paris')).toBe(0);
  });

  it('contains and regex', () => {
    expect(containsMatch('The answer is 42.', '42')).toBe(1);
    expect(containsMatch('anything', '')).toBe(0);
    expect(regexMatch('Order #123', '#\\d+')).toBe(1);
    expect(regexMatch('x', '(')).toBe(0);
  });

  it('valid JSON accepts fenced output', () => {
    expect(validJSON('```json\n{"a":1}\n```')).toBe(1);
    expect(validJSON('{a:1}')).toBe(0);
  });

  it('token F1', () => {
    expect(tokenF1('the cat sat', 'the cat sat')).toBe(1);
    expect(tokenF1('cat', 'the cat sat')).toBeCloseTo(0.5);
    expect(tokenF1('dog', 'cat')).toBe(0);
  });

  it('parses judge scores', () => {
    expect(parseJudgeScore('{"score": 5, "reason": "good"}')).toEqual({ score: 1, reason: 'good' });
    expect(parseJudgeScore('Score: 3')).toEqual({ score: 0.5 });
    expect(parseJudgeScore('I give it 1/5')).toEqual({ score: 0 });
    expect(parseJudgeScore('no idea')).toBeNull();
  });
});
