import { Collection } from '../lib/collection';
import type { Conversation, Dataset, EvalRun, ModelEntry, PromptTemplate, UsageRecord } from './types';

const byUpdatedDesc = <T extends { updatedAt: number }>(a: T, b: T) => b.updatedAt - a.updatedAt;
const byCreatedDesc = <T extends { createdAt: number }>(a: T, b: T) => b.createdAt - a.createdAt;

export const conversations = new Collection<Conversation>('conversations', (a, b) => {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  return b.updatedAt - a.updatedAt;
});
export const prompts = new Collection<PromptTemplate>('prompts', byUpdatedDesc);
export const datasets = new Collection<Dataset>('datasets', byUpdatedDesc);
export const evals = new Collection<EvalRun>('evals', byCreatedDesc);
export const models = new Collection<ModelEntry>('models', byUpdatedDesc);
export const usage = new Collection<UsageRecord>('usage', (a, b) => b.ts - a.ts);

export const ALL_COLLECTIONS = { conversations, prompts, datasets, evals, models, usage } as const;
export type CollectionKey = keyof typeof ALL_COLLECTIONS;
