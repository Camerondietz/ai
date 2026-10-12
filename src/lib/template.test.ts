import { describe, expect, it } from 'vitest';
import { extractVariables, renderTemplate } from './template';

describe('templates', () => {
  it('extracts unique variables in order', () => {
    expect(extractVariables('Q: {{question}} {{ context }} again {{question}} {{meta.src}}')).toEqual([
      'question',
      'context',
      'meta.src',
    ]);
  });

  it('renders values, nested paths and reports missing', () => {
    const r = renderTemplate('{{a}} / {{meta.src}} / {{n}} / {{missing}}', { a: 'x', meta: { src: 'web' }, n: 3 });
    expect(r.text).toBe('x / web / 3 / {{missing}}');
    expect(r.missing).toEqual(['missing']);
  });

  it('serializes objects as JSON', () => {
    expect(renderTemplate('{{o}}', { o: { k: 1 } }).text).toBe('{\n  "k": 1\n}');
  });
});
