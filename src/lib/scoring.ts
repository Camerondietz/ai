/** Scorers for evaluation runs. Every scorer returns a value in [0, 1]. */
import type { ScorerConfig } from '../state/types';
import { tryParseJSON } from './jsonl';

export function normalizeAnswer(text: string, caseSensitive = false): string {
  let t = text.trim().replace(/\s+/g, ' ');
  t = t.replace(/^["'`]+|["'`.!?]+$/g, '');
  return caseSensitive ? t : t.toLowerCase();
}

export function exactMatch(output: string, expected: string, caseSensitive = false): number {
  return normalizeAnswer(output, caseSensitive) === normalizeAnswer(expected, caseSensitive) ? 1 : 0;
}

export function containsMatch(output: string, expected: string, caseSensitive = false): number {
  const o = caseSensitive ? output : output.toLowerCase();
  const e = (caseSensitive ? expected : expected.toLowerCase()).trim();
  return e && o.includes(e) ? 1 : 0;
}

export function regexMatch(output: string, pattern: string, caseSensitive = false): number {
  try {
    return new RegExp(pattern, caseSensitive ? '' : 'i').test(output) ? 1 : 0;
  } catch {
    return 0;
  }
}

export function validJSON(output: string): number {
  return tryParseJSON(output).ok ? 1 : 0;
}

function tokens(text: string): string[] {
  return normalizeAnswer(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** SQuAD-style token-overlap F1. */
export function tokenF1(output: string, expected: string): number {
  const pred = tokens(output);
  const gold = tokens(expected);
  if (!pred.length || !gold.length) return pred.length === gold.length ? 1 : 0;
  const counts = new Map<string, number>();
  for (const t of gold) counts.set(t, (counts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of pred) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      overlap++;
      counts.set(t, c - 1);
    }
  }
  if (!overlap) return 0;
  const precision = overlap / pred.length;
  const recall = overlap / gold.length;
  return (2 * precision * recall) / (precision + recall);
}

export function scorerLabel(s: ScorerConfig): string {
  switch (s.type) {
    case 'exact':
      return 'exact';
    case 'contains':
      return 'contains';
    case 'regex':
      return `regex`;
    case 'json':
      return 'valid JSON';
    case 'f1':
      return 'token F1';
    case 'judge':
      return 'LLM judge';
  }
}

export function scorerKey(s: ScorerConfig, index: number): string {
  return `${s.type}#${index}`;
}

/** Deterministic scorers (the LLM judge runs separately because it is async). */
export function scoreSync(s: ScorerConfig, output: string, expected: string | undefined): number | null {
  switch (s.type) {
    case 'exact':
      return expected == null ? null : exactMatch(output, expected, s.caseSensitive);
    case 'contains':
      return expected == null ? null : containsMatch(output, expected, s.caseSensitive);
    case 'regex':
      return s.pattern ? regexMatch(output, s.pattern, s.caseSensitive) : null;
    case 'json':
      return validJSON(output);
    case 'f1':
      return expected == null ? null : tokenF1(output, expected);
    case 'judge':
      return null;
  }
}

export const DEFAULT_RUBRIC =
  'Score how well the response answers the task. 5 = fully correct, complete and well-formatted; 3 = partially correct or missing details; 1 = wrong, irrelevant or harmful.';

export function buildJudgePrompt(rubric: string, input: string, output: string, expected?: string): string {
  return [
    'You are grading a model response. Be strict and consistent.',
    '',
    `Rubric:\n${rubric || DEFAULT_RUBRIC}`,
    '',
    `<task>\n${input}\n</task>`,
    expected ? `\n<reference_answer>\n${expected}\n</reference_answer>` : '',
    `\n<response>\n${output}\n</response>`,
    '',
    'Reply with only a JSON object: {"score": <integer 1-5>, "reason": "<one sentence>"}',
  ].join('\n');
}

/** Parse a 1–5 judge score and normalize to [0, 1]. */
export function parseJudgeScore(text: string): { score: number; reason?: string } | null {
  const parsed = tryParseJSON(text);
  if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
    const v = parsed.value as { score?: unknown; reason?: unknown };
    const n = Number(v.score);
    if (Number.isFinite(n) && n >= 1 && n <= 5) {
      return { score: (n - 1) / 4, reason: typeof v.reason === 'string' ? v.reason : undefined };
    }
  }
  const m = /"?score"?\s*[:=]\s*([1-5])\b/i.exec(text) ?? /\b([1-5])\s*\/\s*5\b/.exec(text);
  if (m) return { score: (Number(m[1]) - 1) / 4 };
  return null;
}

export function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
