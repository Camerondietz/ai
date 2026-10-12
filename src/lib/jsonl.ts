import type { Row } from '../state/types';

export interface ParseResult {
  rows: Row[];
  errors: { line: number; message: string }[];
}

export function parseJSONL(text: string): ParseResult {
  const rows: Row[] = [];
  const errors: ParseResult['errors'] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const value: unknown = JSON.parse(line);
      rows.push(isPlainObject(value) ? value : { value });
    } catch (err) {
      errors.push({ line: i + 1, message: err instanceof Error ? err.message : String(err) });
    }
  });
  return { rows, errors };
}

export function toJSONL(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Accepts a JSON array, an object wrapping an array (e.g. {"data": [...]}),
 * a single object, or JSONL.
 */
export function parseJSONAuto(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { rows: [], errors: [] };
  try {
    const value: unknown = JSON.parse(trimmed);
    if (Array.isArray(value)) return { rows: value.map((v) => (isPlainObject(v) ? v : { value: v })), errors: [] };
    if (isPlainObject(value)) {
      const arrayKey = Object.keys(value).find((k) => Array.isArray(value[k]));
      if (arrayKey) {
        const arr = value[arrayKey] as unknown[];
        return { rows: arr.map((v) => (isPlainObject(v) ? v : { value: v })), errors: [] };
      }
      return { rows: [value], errors: [] };
    }
    return { rows: [{ value }], errors: [] };
  } catch {
    return parseJSONL(text);
  }
}

/** Union of keys across rows (first-seen order), scanning up to `limit` rows. */
export function inferColumns(rows: Row[], limit = 2000): string[] {
  const cols = new Set<string>();
  for (const row of rows.slice(0, limit)) for (const k of Object.keys(row)) cols.add(k);
  return [...cols];
}

/** Remove a surrounding ```json fence that models often add. */
export function stripCodeFences(text: string): string {
  const m = /^\s*```[\w-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1] : text.trim();
}

export function tryParseJSON(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(stripCodeFences(text)) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
