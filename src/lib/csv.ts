import type { Row } from '../state/types';
import { cellText } from './format';

export interface ParsedTable {
  columns: string[];
  rows: Row[];
}

/** Pick the most likely delimiter from the first line. */
export function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** RFC 4180 tokenizer: quoted fields, escaped quotes, embedded newlines. */
export function parseCSVRecords(text: string, delimiter = detectDelimiter(text)): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      record.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      record.push(field);
      records.push(record);
      field = '';
      record = [];
      if (ch === '\r' && src[i + 1] === '\n') i++;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }
  // Drop fully empty trailing lines.
  return records.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function parseCSV(text: string, delimiter?: string): ParsedTable {
  const records = parseCSVRecords(text, delimiter ?? detectDelimiter(text));
  if (!records.length) return { columns: [], rows: [] };
  const seen = new Map<string, number>();
  const columns = records[0].map((raw, idx) => {
    let name = raw.trim() || `column_${idx + 1}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n > 0) name = `${name}_${n + 1}`;
    return name;
  });
  const rows = records.slice(1).map((rec) => {
    const row: Row = {};
    columns.forEach((col, i) => {
      row[col] = rec[i] ?? '';
    });
    return row;
  });
  return { columns, rows };
}

/**
 * Neutralize spreadsheet formula injection: cells starting with = + - @ are
 * executed by Excel/Sheets when the CSV is opened. Numbers are left alone.
 */
function neutralizeFormula(value: string): string {
  if (/^[=+\-@\t\r]/.test(value) && !/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value)) return `'${value}`;
  return value;
}

export function toCSV(columns: string[], rows: Row[], options: { delimiter?: string; safe?: boolean } = {}): string {
  const delimiter = options.delimiter ?? ',';
  const safe = options.safe ?? true;
  const escape = (raw: unknown) => {
    let value = cellText(raw);
    if (safe && typeof raw === 'string') value = neutralizeFormula(value);
    if (value.includes('"') || value.includes(delimiter) || value.includes('\n') || value.includes('\r')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };
  const lines = [columns.map(escape).join(delimiter)];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c])).join(delimiter));
  return lines.join('\r\n');
}
