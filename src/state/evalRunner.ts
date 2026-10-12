/**
 * Runs evaluations in the background (independent of which page is open):
 * every input × model pair is sent with bounded concurrency, scored, and
 * written back to IndexedDB in small batches.
 */
import { createStore, useStore } from '../lib/store';
import { buildJudgePrompt, parseJudgeScore, scoreSync, scorerKey } from '../lib/scoring';
import { modelKey, runChat } from '../providers';
import { anthropicSupportsAdaptive } from '../providers/anthropic';
import { evals } from './collections';
import { getProvider } from './settings';
import type { ChatParams, EvalCell, EvalRun, ModelRef } from './types';
import { BudgetExceededError } from './usage';
import { VaultLockedError } from './vault';

/** Live copies of running evaluations (the UI prefers these over the stored copy). */
export const liveRuns = createStore<Record<string, EvalRun>>({});
const controllers = new Map<string, AbortController>();

export function useLiveRun(id: string | undefined): EvalRun | undefined {
  const live = useStore(liveRuns);
  return id ? live[id] : undefined;
}

export function isRunning(id: string): boolean {
  return controllers.has(id);
}

export function cancelEval(id: string) {
  controllers.get(id)?.abort();
}

/** Short, cheap grading calls: low effort where supported, room for reasoning tokens. */
function judgeParams(ref: ModelRef): ChatParams {
  const provider = getProvider(ref.providerId);
  if (provider?.kind === 'anthropic') {
    return anthropicSupportsAdaptive(ref.model) ? { maxTokens: 8000, effort: 'low' } : { maxTokens: 2000, temperature: 0 };
  }
  return { maxTokens: 4000 };
}

/** Errors that will fail every remaining request, so the run stops early. */
function isFatal(err: unknown): boolean {
  if (err instanceof BudgetExceededError || err instanceof VaultLockedError) return true;
  const msg = err instanceof Error ? err.message : '';
  return /vault is locked|No API key set|Unknown provider|is disabled/i.test(msg);
}

export async function startEval(initial: EvalRun): Promise<void> {
  const controller = new AbortController();
  controllers.set(initial.id, controller);
  const state: { run: EvalRun; fatal: string | null; dirty: boolean } = {
    run: { ...initial, status: 'running', error: undefined },
    fatal: null,
    dirty: false,
  };

  const publish = () => liveRuns.set((prev) => ({ ...prev, [state.run.id]: state.run }));
  const flush = async () => {
    if (!state.dirty) return;
    state.dirty = false;
    await evals.put(state.run);
  };
  const flushTimer = setInterval(() => void flush(), 1500);

  publish();
  await evals.put(state.run);

  const { inputs, config } = state.run;
  const done = new Set(state.run.cells.map((c) => `${c.rowIndex}|${c.modelKey}`));
  const tasks: { inputIndex: number; ref: ModelRef }[] = [];
  inputs.forEach((input, inputIndex) => {
    for (const ref of config.models) {
      if (!done.has(`${input.rowIndex}|${modelKey(ref)}`)) tasks.push({ inputIndex, ref });
    }
  });
  const judges = config.scorers.map((s, i) => ({ s, key: scorerKey(s, i) })).filter((x) => x.s.type === 'judge' && x.s.judge);

  const worker = async () => {
    for (let task = tasks.shift(); task; task = tasks.shift()) {
      if (controller.signal.aborted || state.fatal) return;
      const input = inputs[task.inputIndex];
      const cell: EvalCell = { rowIndex: input.rowIndex, modelKey: modelKey(task.ref), output: '', scores: {} };
      try {
        const r = await runChat({
          providerId: task.ref.providerId,
          model: task.ref.model,
          system: input.system ?? config.system,
          messages: [{ role: 'user', content: input.prompt }],
          params: config.params,
          source: 'eval',
          signal: controller.signal,
        });
        if (r.aborted) return;
        cell.output = r.text;
        cell.latencyMs = Math.round(r.latencyMs);
        cell.usage = r.usage;
        cell.costUsd = r.costUsd;
        config.scorers.forEach((s, i) => {
          const score = scoreSync(s, r.text, input.expected);
          if (score != null) cell.scores[scorerKey(s, i)] = score;
        });
        for (const { s, key } of judges) {
          try {
            const j = await runChat({
              providerId: s.judge!.providerId,
              model: s.judge!.model,
              messages: [{ role: 'user', content: buildJudgePrompt(s.rubric ?? '', input.prompt, r.text, input.expected) }],
              params: judgeParams(s.judge!),
              source: 'judge',
              signal: controller.signal,
            });
            const parsed = parseJudgeScore(j.text);
            if (parsed) {
              cell.scores[key] = parsed.score;
              if (parsed.reason) cell.judgeNotes = parsed.reason;
            } else {
              cell.judgeNotes = `Unparseable judge output: ${j.text.slice(0, 200)}`;
            }
          } catch (err) {
            if (controller.signal.aborted) return;
            cell.judgeNotes = `Judge failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (isFatal(err)) {
          state.fatal = err instanceof Error ? err.message : String(err);
          controller.abort();
          return;
        }
        cell.error = err instanceof Error ? err.message : String(err);
      }
      state.run = { ...state.run, cells: [...state.run.cells, cell] };
      state.dirty = true;
      publish();
    }
  };

  try {
    const n = Math.max(1, Math.min(config.concurrency || 1, 16));
    await Promise.all(Array.from({ length: n }, worker));
  } finally {
    clearInterval(flushTimer);
    state.run = {
      ...state.run,
      status: state.fatal ? 'error' : controller.signal.aborted ? 'cancelled' : 'done',
      error: state.fatal ?? undefined,
      finishedAt: Date.now(),
    };
    await evals.put(state.run);
    controllers.delete(state.run.id);
    liveRuns.set((prev) => {
      const next = { ...prev };
      delete next[state.run.id];
      return next;
    });
  }
}
