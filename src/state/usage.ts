import { uid } from '../lib/id';
import { usage } from './collections';
import { computeCost, getSettings } from './settings';
import type { TokenUsage, UsageRecord, UsageSource } from './types';

export class BudgetExceededError extends Error {
  constructor(spent: number, budget: number) {
    super(`Monthly budget reached ($${spent.toFixed(2)} of $${budget.toFixed(2)}). Raise it or disable the hard stop in Settings → Budget.`);
    this.name = 'BudgetExceededError';
  }
}

export function monthStart(ts = Date.now()): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function spendSince(records: UsageRecord[], since: number): number {
  let total = 0;
  for (const r of records) if (r.ts >= since) total += r.costUsd;
  return total;
}

/** Throws if the hard budget stop is on and this month's spend is at or over budget. */
export async function assertWithinBudget(providerKind: string): Promise<void> {
  const { budget } = getSettings();
  if (!budget.hardStop || budget.monthlyUsd <= 0 || providerKind === 'local') return;
  const spent = spendSince(await usage.all(), monthStart());
  if (spent >= budget.monthlyUsd) throw new BudgetExceededError(spent, budget.monthlyUsd);
}

export async function recordUsage(entry: {
  providerId: string;
  model: string;
  source: UsageSource;
  usage?: TokenUsage;
  latencyMs: number;
  ok: boolean;
}): Promise<number> {
  const costUsd = computeCost(entry.providerId, entry.model, entry.usage);
  if (!getSettings().recordUsage) return costUsd;
  const record: UsageRecord = {
    id: uid(),
    ts: Date.now(),
    providerId: entry.providerId,
    model: entry.model,
    source: entry.source,
    inputTokens: entry.usage?.inputTokens ?? 0,
    outputTokens: entry.usage?.outputTokens ?? 0,
    estimated: entry.usage?.estimated,
    costUsd,
    latencyMs: Math.round(entry.latencyMs),
    ok: entry.ok,
  };
  await usage.put(record);
  return costUsd;
}
