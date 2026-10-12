import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCSV, toCSV } from './csv';

describe('CSV', () => {
  it('parses quoted fields with commas, quotes and newlines', () => {
    const text = 'q,a\n"Hello, world","He said ""hi"""\n"multi\nline",x\n';
    const { columns, rows } = parseCSV(text);
    expect(columns).toEqual(['q', 'a']);
    expect(rows).toEqual([
      { q: 'Hello, world', a: 'He said "hi"' },
      { q: 'multi\nline', a: 'x' },
    ]);
  });

  it('detects tab and semicolon delimiters', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b;c')).toBe(';');
  });

  it('dedupes and fills header names', () => {
    const { columns } = parseCSV('a,a,\n1,2,3');
    expect(columns).toEqual(['a', 'a_2', 'column_3']);
  });

  it('handles CRLF and BOM', () => {
    const { rows } = parseCSV('﻿x,y\r\n1,2\r\n');
    expect(rows).toEqual([{ x: '1', y: '2' }]);
  });

  it('round-trips and neutralizes formulas', () => {
    const csv = toCSV(['a', 'b'], [{ a: '=SUM(A1)', b: '-5' }, { a: 'x,y', b: 3 }]);
    expect(csv).toBe("a,b\r\n'=SUM(A1),-5\r\n\"x,y\",3");
    const back = parseCSV(toCSV(['t'], [{ t: 'line "1"\nline 2' }], { safe: false }));
    expect(back.rows[0].t).toBe('line "1"\nline 2');
  });
});
