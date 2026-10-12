import { describe, expect, it } from 'vitest';
import { createSSEParser } from './sse';

describe('SSE parser', () => {
  it('parses events split across chunks', () => {
    const p = createSSEParser();
    expect(p.push('data: {"a"')).toEqual([]);
    expect(p.push(':1}\n\ndata: [DO')).toEqual([{ event: undefined, data: '{"a":1}' }]);
    expect(p.push('NE]\n\n')).toEqual([{ event: undefined, data: '[DONE]' }]);
  });

  it('handles event names, comments and multi-line data', () => {
    const p = createSSEParser();
    const events = p.push(': keep-alive\n\nevent: message_start\ndata: line1\ndata: line2\n\n');
    expect(events).toEqual([{ event: 'message_start', data: 'line1\nline2' }]);
  });

  it('handles CRLF split between chunks', () => {
    const p = createSSEParser();
    expect(p.push('data: x\r')).toEqual([]);
    expect(p.push('\n\r\n')).toEqual([{ event: undefined, data: 'x' }]);
  });

  it('flushes a trailing event without blank line', () => {
    const p = createSSEParser();
    p.push('data: tail');
    expect(p.flush()).toEqual([{ event: undefined, data: 'tail' }]);
  });
});
