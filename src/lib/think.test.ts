import { describe, expect, it } from 'vitest';
import { createThinkSplitter, splitThink } from './think';

function run(chunks: string[]) {
  let text = '';
  let thinking = '';
  const push = createThinkSplitter(
    (t) => (text += t),
    (t) => (thinking += t),
  );
  chunks.forEach(push);
  return { text, thinking };
}

describe('think splitter', () => {
  it('passes plain text through', () => {
    expect(run(['Hello', ' world'])).toEqual({ text: 'Hello world', thinking: '' });
  });

  it('separates a think block split across chunks', () => {
    const r = run(['<thi', 'nk>step 1, ', 'step 2</th', 'ink>\n\nAnswer: 42']);
    expect(r.thinking).toBe('step 1, step 2');
    expect(r.text).toBe('Answer: 42');
  });

  it('splits complete responses', () => {
    expect(splitThink('<think>why</think>\nbecause')).toEqual({ content: 'because', thinking: 'why' });
    expect(splitThink('no tags')).toEqual({ content: 'no tags' });
  });
});
