import { useEffect, useMemo, useState } from 'react';
import { DataTable, type Column } from '../components/DataTable';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { ModelPicker } from '../components/ModelPicker';
import { PushToHubDialog } from '../components/PushToHubDialog';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, Notice, NumberInput, PageHeader, Progress, Select, Textarea } from '../components/ui';
import { useCollection } from '../lib/collection';
import { toCSV } from '../lib/csv';
import { downloadJSON, downloadText, timestampSlug } from '../lib/download';
import { cellText, formatCompact, formatDateTime, formatMs, formatPercent, formatRelative, formatUSD, slugify, truncate } from '../lib/format';
import { uid } from '../lib/id';
import { toJSONL } from '../lib/jsonl';
import { DEFAULT_RUBRIC, mean, scorerKey, scorerLabel } from '../lib/scoring';
import { extractVariables, renderTemplate } from '../lib/template';
import { estimateTokens } from '../lib/tokens';
import { modelKey } from '../providers';
import { navigate, useRoute } from '../router';
import { datasets, evals, prompts } from '../state/collections';
import { cancelEval, isRunning, startEval, useLiveRun } from '../state/evalRunner';
import { getProvider, getSettings, priceFor } from '../state/settings';
import { toast } from '../state/toast';
import type { ChatParams, Dataset, EvalCell, EvalInput, EvalRun, ModelRef, Row, ScorerConfig, ScorerType } from '../state/types';

export function EvalsPage() {
  const route = useRoute();
  const { items, loaded } = useCollection(evals);
  const id = route.segments[1];
  const isNew = route.query.get('new') === '1';

  if (isNew) {
    return (
      <div className="page">
        <PageHeader title="New evaluation" description="Run a prompt template over a dataset with one or more models, then score the outputs." />
        <NewEvalForm datasetId={route.query.get('dataset') ?? undefined} promptId={route.query.get('prompt') ?? undefined} />
      </div>
    );
  }

  const active = id ? items.find((r) => r.id === id) : undefined;
  if (id) {
    return (
      <div className="page">
        {active ? <EvalResults run={active} /> : loaded ? <EmptyState title="Evaluation not found" /> : null}
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Evaluations"
        description="Measure prompt and model quality on real data before you ship. Results stay local unless you export or push them."
        actions={
          <Button variant="primary" icon="plus" onClick={() => navigate('evals', { new: '1' })}>
            New evaluation
          </Button>
        }
      />
      {loaded && !items.length ? (
        <Card>
          <EmptyState title="No evaluations yet" action={<Button variant="primary" onClick={() => navigate('evals', { new: '1' })}>Create an evaluation</Button>}>
            You need a dataset (import one or pull from Hugging Face) and at least one model. Start with 20–50 rows to keep costs low.
          </EmptyState>
        </Card>
      ) : (
        <DataTable<EvalRun>
          columns={[
            { key: 'name', label: 'Name', render: (r) => <strong>{r.name}</strong> },
            { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'dataset', label: 'Dataset', render: (r) => r.config.datasetName },
            { key: 'models', label: 'Models', render: (r) => r.config.models.map((m) => m.model).join(', ') },
            { key: 'rows', label: 'Rows', num: true, render: (r) => r.inputs.length },
            { key: 'cost', label: 'Cost', num: true, render: (r) => formatUSD(r.cells.reduce((s, c) => s + (c.costUsd ?? 0), 0)) },
            { key: 'created', label: 'Created', render: (r) => formatRelative(r.createdAt) },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`evals/${r.id}`)}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: EvalRun['status'] }) {
  const tone = status === 'done' ? 'ok' : status === 'running' ? 'accent' : status === 'error' ? 'err' : 'warn';
  return <Badge tone={tone}>{status}</Badge>;
}

// ---------------------------------------------------------------------------
// Builder

const SCORER_OPTIONS: { type: ScorerType; label: string; needsExpected: boolean; hint: string }[] = [
  { type: 'exact', label: 'Exact match', needsExpected: true, hint: 'Normalized string equality with the expected column' },
  { type: 'contains', label: 'Contains expected', needsExpected: true, hint: 'Output includes the expected answer' },
  { type: 'f1', label: 'Token F1', needsExpected: true, hint: 'Word-overlap F1 (SQuAD-style)' },
  { type: 'json', label: 'Valid JSON', needsExpected: false, hint: 'Output parses as JSON (code fences allowed)' },
  { type: 'regex', label: 'Regex', needsExpected: false, hint: 'Output matches a pattern' },
  { type: 'judge', label: 'LLM judge (1–5)', needsExpected: false, hint: 'A model grades each output against a rubric' },
];

function NewEvalForm({ datasetId, promptId }: { datasetId?: string; promptId?: string }) {
  const { items: dsList } = useCollection(datasets);
  const { items: promptList } = useCollection(prompts);
  const settings = getSettings();
  const [name, setName] = useState(`Eval ${new Date().toLocaleDateString()}`);
  const [dsId, setDsId] = useState(datasetId ?? '');
  const [pId, setPId] = useState(promptId ?? '');
  const [system, setSystem] = useState('');
  const [template, setTemplate] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [expected, setExpected] = useState('');
  const [models, setModels] = useState<(ModelRef | undefined)[]>([settings.defaultModel]);
  const [scorers, setScorers] = useState<ScorerConfig[]>([]);
  const [params, setParams] = useState<ChatParams>({ temperature: 0 });
  const [concurrency, setConcurrency] = useState<number | undefined>(3);
  const [limit, setLimit] = useState<number | undefined>(25);

  const dataset = dsList.find((d) => d.id === dsId);
  const prompt = promptList.find((p) => p.id === pId);

  useEffect(() => {
    if (!dsId && dsList.length) setDsId(datasetId ?? dsList[0].id);
  }, [dsList, dsId, datasetId]);

  useEffect(() => {
    if (!prompt) return;
    const v = prompt.versions[prompt.versions.length - 1];
    if (v) {
      setSystem(v.system);
      setTemplate(v.template);
    }
  }, [prompt?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dataset) return;
    const cols = dataset.columns;
    setExpected((e) => e || cols.find((c) => /^(expected|answer|output|label|target|solution)$/i.test(c)) || '');
    if (!template) {
      const inputCol = cols.find((c) => /^(input|question|prompt|query|instruction|text)$/i.test(c)) ?? cols[0];
      if (inputCol) setTemplate(`{{${inputCol}}}`);
    }
  }, [dataset?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const variables = useMemo(() => [...new Set([...extractVariables(system), ...extractVariables(template)])], [system, template]);

  useEffect(() => {
    if (!dataset) return;
    setMapping((prev) => {
      const next: Record<string, string> = {};
      for (const v of variables) next[v] = prev[v] ?? (dataset.columns.includes(v) ? v : '');
      return next;
    });
  }, [variables, dataset]);

  const chosenModels = models.filter((m): m is ModelRef => !!m);
  const rowsToUse = dataset ? dataset.rows.slice(0, limit ?? dataset.rows.length) : [];

  const buildInputs = (): EvalInput[] => {
    const systemHasVars = extractVariables(system).length > 0;
    return rowsToUse.map((row, rowIndex) => {
      const vars: Record<string, unknown> = { ...row };
      for (const [v, col] of Object.entries(mapping)) if (col) vars[v] = row[col];
      return {
        rowIndex,
        prompt: renderTemplate(template, vars).text,
        system: systemHasVars ? renderTemplate(system, vars).text : undefined,
        expected: expected ? cellText(row[expected]) : undefined,
      };
    });
  };

  const estimate = useMemo(() => {
    if (!dataset || !chosenModels.length) return null;
    const sample = buildInputs();
    const inTok = sample.reduce((s, i) => s + estimateTokens(i.prompt) + estimateTokens(i.system ?? system), 0);
    const outPerRow = Math.min(params.maxTokens ?? 400, 400);
    let cost = 0;
    let unpriced = 0;
    for (const m of chosenModels) {
      if (getProvider(m.providerId)?.kind === 'local') continue;
      const price = priceFor(m.model);
      if (!price) {
        unpriced++;
        continue;
      }
      cost += (inTok * price.input + sample.length * outPerRow * price.output) / 1e6;
    }
    const judges = scorers.filter((s) => s.type === 'judge' && s.judge).length;
    return { calls: sample.length * chosenModels.length * (1 + judges), inTok, cost, unpriced };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, chosenModels.map(modelKey).join(), template, system, mapping, limit, params.maxTokens, scorers]);

  const needsExpected = scorers.some((s) => SCORER_OPTIONS.find((o) => o.type === s.type)?.needsExpected);
  const unmapped = variables.filter((v) => !mapping[v]);
  const problems = [
    !dataset && 'Choose a dataset.',
    !template.trim() && 'Write a prompt template.',
    !chosenModels.length && 'Add at least one model.',
    unmapped.length && `Map variables to columns: ${unmapped.join(', ')}.`,
    needsExpected && !expected && 'The selected scorers need an expected-answer column.',
    scorers.some((s) => s.type === 'judge' && !s.judge) && 'Choose a judge model.',
    scorers.some((s) => s.type === 'regex' && !s.pattern) && 'Enter a regex pattern.',
  ].filter(Boolean) as string[];

  const toggleScorer = (type: ScorerType, on: boolean) => {
    setScorers((prev) => (on ? [...prev, { type, rubric: type === 'judge' ? DEFAULT_RUBRIC : undefined, judge: type === 'judge' ? settings.defaultModel : undefined }] : prev.filter((s) => s.type !== type)));
  };
  const patchScorer = (type: ScorerType, patch: Partial<ScorerConfig>) => setScorers((prev) => prev.map((s) => (s.type === type ? { ...s, ...patch } : s)));

  const start = async () => {
    if (problems.length || !dataset) return;
    const run: EvalRun = {
      id: uid(),
      name: name.trim() || 'Untitled evaluation',
      createdAt: Date.now(),
      status: 'running',
      config: {
        datasetId: dataset.id,
        datasetName: dataset.name,
        promptId: prompt?.id,
        promptVersion: prompt?.versions[prompt.versions.length - 1]?.version,
        system,
        template,
        models: chosenModels,
        expectedColumn: expected || undefined,
        scorers,
        params,
        concurrency: concurrency ?? 3,
        limit,
      },
      inputs: buildInputs(),
      cells: [],
    };
    await evals.put(run);
    void startEval(run);
    navigate(`evals/${run.id}`);
  };

  if (!dsList.length) {
    return (
      <Card>
        <EmptyState title="You need a dataset first" action={<Button variant="primary" onClick={() => navigate('datasets', { import: '1' })}>Import a dataset</Button>}>
          Import a CSV/JSONL file or pull rows from a Hugging Face dataset.
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="stack lg">
      <Card title="1. Data">
        <div className="grid cols-3">
          <Field label="Evaluation name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Dataset">
            <Select value={dsId} onChange={(e) => setDsId(e.target.value)}>
              {dsList.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.rows.length.toLocaleString()} rows)
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Rows to use" hint={dataset ? `of ${dataset.rows.length.toLocaleString()} (from the top)` : undefined}>
            <NumberInput value={limit} min={1} max={dataset?.rows.length} onChange={setLimit} />
          </Field>
        </div>
      </Card>

      <Card title="2. Prompt">
        <div className="stack">
          <Field label="Start from prompt library (optional)">
            <Select value={pId} onChange={(e) => setPId(e.target.value)}>
              <option value="">— inline prompt —</option>
              {promptList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (v{p.versions.length})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="System prompt">
            <Textarea rows={3} className="mono" value={system} onChange={(e) => setSystem(e.target.value)} />
          </Field>
          <Field label="User message template" hint={dataset ? `Columns: ${dataset.columns.map((c) => `{{${c}}}`).join(' ')}` : undefined}>
            <Textarea rows={5} className="mono" value={template} onChange={(e) => setTemplate(e.target.value)} />
          </Field>
          {variables.length && dataset ? (
            <div className="grid cols-3">
              {variables.map((v) => (
                <Field key={v} label={`{{${v}}} ←`}>
                  <Select value={mapping[v] ?? ''} onChange={(e) => setMapping({ ...mapping, [v]: e.target.value })}>
                    <option value="">(choose column)</option>
                    {dataset.columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
          ) : null}
          <Field label="Expected answer column (for reference-based scorers)">
            <Select value={expected} onChange={(e) => setExpected(e.target.value)}>
              <option value="">(none)</option>
              {dataset?.columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          {dataset && rowsToUse.length ? (
            <details>
              <summary>Preview first rendered prompt</summary>
              <pre className="plain mono small">{buildInputs()[0]?.prompt}</pre>
            </details>
          ) : null}
        </div>
      </Card>

      <Card title="3. Models">
        <div className="stack">
          {models.map((m, i) => (
            <div key={i} className="row nowrap">
              <div className="flex-1">
                <ModelPicker value={m} allowEmpty onChange={(ref) => setModels(models.map((x, j) => (j === i ? ref : x)))} />
              </div>
              {models.length > 1 ? <Button variant="ghost" iconOnly icon="x" aria-label="Remove model" onClick={() => setModels(models.filter((_, j) => j !== i))} /> : null}
            </div>
          ))}
          <div className="row">
            <Button icon="plus" onClick={() => setModels([...models, undefined])}>
              Add model
            </Button>
          </div>
          <div className="grid cols-3">
            <Field label="Temperature" hint="0 for reproducibility (ignored by models with fixed sampling)">
              <NumberInput value={params.temperature} min={0} max={2} step={0.1} placeholder="default" onChange={(v) => setParams({ ...params, temperature: v })} />
            </Field>
            <Field label="Max output tokens">
              <NumberInput value={params.maxTokens} min={1} step={256} placeholder="default" onChange={(v) => setParams({ ...params, maxTokens: v })} />
            </Field>
            <Field label="Concurrency" hint="Parallel requests (mind provider rate limits)">
              <NumberInput value={concurrency} min={1} max={16} onChange={setConcurrency} />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="4. Scoring">
        <div className="stack">
          {SCORER_OPTIONS.map((o) => {
            const s = scorers.find((x) => x.type === o.type);
            return (
              <div key={o.type} className="stack sm">
                <Checkbox
                  checked={!!s}
                  onChange={(on) => toggleScorer(o.type, on)}
                  label={
                    <>
                      <strong>{o.label}</strong> <span className="small subtle">— {o.hint}</span>
                    </>
                  }
                />
                {s && (o.type === 'exact' || o.type === 'contains' || o.type === 'regex') ? (
                  <div style={{ marginLeft: 24 }}>
                    <Checkbox checked={!!s.caseSensitive} onChange={(v) => patchScorer(o.type, { caseSensitive: v })} label="Case sensitive" />
                  </div>
                ) : null}
                {s && o.type === 'regex' ? (
                  <div style={{ marginLeft: 24 }}>
                    <Input className="mono" placeholder="e.g. ^\{.*\}$ or \bAnswer: [A-D]\b" value={s.pattern ?? ''} onChange={(e) => patchScorer('regex', { pattern: e.target.value })} />
                  </div>
                ) : null}
                {s && o.type === 'judge' ? (
                  <div className="stack sm" style={{ marginLeft: 24 }}>
                    <Field label="Judge model">
                      <ModelPicker value={s.judge} onChange={(ref) => patchScorer('judge', { judge: ref })} />
                    </Field>
                    <Field label="Rubric">
                      <Textarea rows={3} value={s.rubric ?? ''} onChange={(e) => patchScorer('judge', { rubric: e.target.value })} />
                    </Field>
                  </div>
                ) : null}
              </div>
            );
          })}
          {!scorers.length ? <span className="small subtle">No scorers: outputs are collected for manual review only.</span> : null}
        </div>
      </Card>

      <Card>
        <div className="row between">
          <div className="stack sm">
            {estimate ? (
              <span>
                <strong>{estimate.calls.toLocaleString()}</strong> requests · ~{formatCompact(estimate.inTok)} input tokens per model · estimated{' '}
                <strong>{formatUSD(estimate.cost)}</strong>
                {estimate.unpriced ? <span className="subtle"> (+{estimate.unpriced} unpriced model{estimate.unpriced > 1 ? 's' : ''})</span> : null}
                <span className="subtle"> (judge calls not included)</span>
              </span>
            ) : null}
            {problems.map((p) => (
              <span key={p} className="small err-text">
                {p}
              </span>
            ))}
          </div>
          <Button variant="primary" icon="play" disabled={!!problems.length} onClick={start}>
            Run evaluation
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results

interface ModelSummary {
  key: string;
  label: string;
  n: number;
  errors: number;
  latency: number | null;
  tokens: number;
  cost: number;
  scores: Record<string, number | null>;
}

function summarize(run: EvalRun): ModelSummary[] {
  return run.config.models.map((m) => {
    const key = modelKey(m);
    const cells = run.cells.filter((c) => c.modelKey === key);
    const ok = cells.filter((c) => !c.error);
    const scores: Record<string, number | null> = {};
    run.config.scorers.forEach((s, i) => {
      const k = scorerKey(s, i);
      scores[k] = mean(ok.map((c) => c.scores[k]).filter((v): v is number => typeof v === 'number'));
    });
    return {
      key,
      label: m.model,
      n: cells.length,
      errors: cells.length - ok.length,
      latency: mean(ok.map((c) => c.latencyMs ?? 0)),
      tokens: cells.reduce((s, c) => s + (c.usage?.inputTokens ?? 0) + (c.usage?.outputTokens ?? 0), 0),
      cost: cells.reduce((s, c) => s + (c.costUsd ?? 0), 0),
      scores,
    };
  });
}

function longRows(run: EvalRun): Row[] {
  const inputs = new Map(run.inputs.map((i) => [i.rowIndex, i]));
  return run.cells.map((c) => {
    const input = inputs.get(c.rowIndex);
    const row: Row = {
      row: c.rowIndex,
      model: c.modelKey.split('::')[1] ?? c.modelKey,
      provider: c.modelKey.split('::')[0],
      prompt: input?.prompt ?? '',
      expected: input?.expected ?? '',
      output: c.output,
      error: c.error ?? '',
      latency_ms: c.latencyMs ?? '',
      input_tokens: c.usage?.inputTokens ?? '',
      output_tokens: c.usage?.outputTokens ?? '',
      cost_usd: c.costUsd ?? '',
    };
    run.config.scorers.forEach((s, i) => {
      row[`score_${s.type}${run.config.scorers.filter((x) => x.type === s.type).length > 1 ? `_${i}` : ''}`] = c.scores[scorerKey(s, i)] ?? '';
    });
    if (c.judgeNotes) row.judge_notes = c.judgeNotes;
    return row;
  });
}

function scoreTone(v: number | undefined): 'ok' | 'warn' | 'err' | undefined {
  if (v == null) return undefined;
  return v >= 0.8 ? 'ok' : v >= 0.5 ? 'warn' : 'err';
}

function EvalResults({ run: stored }: { run: EvalRun }) {
  const live = useLiveRun(stored.id);
  const run = live ?? stored;
  const [detail, setDetail] = useState<number | null>(null);
  const [push, setPush] = useState(false);
  const [onlyFailures, setOnlyFailures] = useState(false);
  const running = !!live || (run.status === 'running' && isRunning(run.id));
  const total = run.inputs.length * run.config.models.length;
  const summaries = useMemo(() => summarize(run), [run]);
  const scorerKeys = run.config.scorers.map((s, i) => ({ key: scorerKey(s, i), label: scorerLabel(s) }));
  const byCell = useMemo(() => {
    const m = new Map<string, EvalCell>();
    for (const c of run.cells) m.set(`${c.rowIndex}|${c.modelKey}`, c);
    return m;
  }, [run.cells]);
  const modelKeys = run.config.models.map(modelKey);
  const base = `${slugify(run.name)}-${timestampSlug(run.createdAt)}`;

  const visibleInputs = onlyFailures
    ? run.inputs.filter((i) =>
        modelKeys.some((k) => {
          const c = byCell.get(`${i.rowIndex}|${k}`);
          return c && (c.error || Object.values(c.scores).some((v) => v < 1));
        }),
      )
    : run.inputs;

  const resume = () => {
    void startEval(run);
  };

  const rerun = async () => {
    const copy: EvalRun = { ...run, id: uid(), name: `${run.name} (re-run)`, createdAt: Date.now(), finishedAt: undefined, status: 'running', cells: [], error: undefined };
    await evals.put(copy);
    void startEval(copy);
    navigate(`evals/${copy.id}`);
  };

  const saveAsDataset = async () => {
    const columns = ['input', ...(run.config.expectedColumn ? ['expected'] : []), ...run.config.models.map((m) => `output_${m.model}`)];
    const rows: Row[] = run.inputs.map((i) => {
      const r: Row = { input: i.prompt };
      if (run.config.expectedColumn) r.expected = i.expected ?? '';
      run.config.models.forEach((m) => {
        r[`output_${m.model}`] = byCell.get(`${i.rowIndex}|${modelKey(m)}`)?.output ?? '';
      });
      return r;
    });
    const now = Date.now();
    const ds: Dataset = { id: uid(), name: `${run.name} outputs`, description: `Outputs from evaluation "${run.name}"`, source: `eval:${run.id}`, columns, rows, createdAt: now, updatedAt: now };
    await datasets.put(ds);
    toast('Saved outputs as a dataset', 'success', { label: 'Open', run: () => navigate(`datasets/${ds.id}`) });
  };

  const columns: Column<EvalRun['inputs'][number]>[] = [
    { key: '#', label: '#', num: true, render: (i) => i.rowIndex + 1 },
    { key: 'prompt', label: 'Input', render: (i) => <div className="cell">{truncate(i.prompt, 220)}</div> },
    ...(run.config.expectedColumn ? [{ key: 'expected', label: 'Expected', render: (i: EvalInput) => <div className="cell">{truncate(i.expected ?? '', 120)}</div> }] : []),
    ...run.config.models.map((m) => {
      const key = modelKey(m);
      return {
        key,
        label: m.model,
        render: (i: EvalInput) => {
          const c = byCell.get(`${i.rowIndex}|${key}`);
          if (!c) return running ? <span className="spinner" /> : <span className="subtle">—</span>;
          return (
            <div className="stack sm">
              {c.error ? <span className="err-text small">{truncate(c.error, 160)}</span> : <div className="cell">{truncate(c.output, 220)}</div>}
              <div className="row">
                {scorerKeys.map((s) =>
                  c.scores[s.key] != null ? (
                    <Badge key={s.key} tone={scoreTone(c.scores[s.key])} title={s.label}>
                      {s.label}: {formatPercent(c.scores[s.key])}
                    </Badge>
                  ) : null,
                )}
              </div>
            </div>
          );
        },
      };
    }),
  ];

  const detailInput = detail != null ? run.inputs.find((i) => i.rowIndex === detail) : undefined;

  return (
    <div className="stack lg">
      <PageHeader
        title={
          <span className="row">
            {run.name} <StatusBadge status={running ? 'running' : run.status} />
          </span>
        }
        description={`${run.config.datasetName} · ${run.inputs.length} rows × ${run.config.models.length} models · created ${formatDateTime(run.createdAt)}`}
        actions={
          <>
            {running ? (
              <Button variant="danger" icon="stop" onClick={() => cancelEval(run.id)}>
                Cancel
              </Button>
            ) : run.cells.length < total ? (
              <Button icon="play" onClick={resume}>
                Resume
              </Button>
            ) : null}
            <Button icon="refresh" disabled={running} onClick={rerun}>
              Re-run
            </Button>
            <Button icon="download" disabled={!run.cells.length} onClick={() => downloadText(toCSV(Object.keys(longRows(run)[0] ?? {}), longRows(run)), `${base}.csv`, 'text/csv')}>
              CSV
            </Button>
            <Button icon="download" disabled={!run.cells.length} onClick={() => downloadJSON(run, `${base}.json`)}>
              JSON
            </Button>
            <Button icon="table" disabled={running || !run.cells.length} onClick={saveAsDataset}>
              Save as dataset
            </Button>
            <Button icon="upload" disabled={running || !run.cells.length} onClick={() => setPush(true)}>
              Push to HF
            </Button>
            <Button
              variant="ghost"
              iconOnly
              icon="trash"
              aria-label="Delete evaluation"
              disabled={running}
              onClick={async () => {
                if (!confirm(`Delete evaluation "${run.name}"?`)) return;
                await evals.remove(run.id);
                navigate('evals');
              }}
            />
          </>
        }
      />

      {running || run.cells.length < total ? (
        <div className="stack sm">
          <Progress value={total ? run.cells.length / total : 0} />
          <span className="small subtle">
            {run.cells.length} / {total} completed{running ? ' — you can leave this page; the run continues in this tab.' : ''}
          </span>
        </div>
      ) : null}
      {run.error ? <Notice tone="err">Stopped early: {run.error}</Notice> : null}
      {run.status === 'interrupted' ? <Notice tone="warn">This run was interrupted (the tab closed). Resume to finish the remaining items.</Notice> : null}

      <Card title="Summary by model" bodyClassName="">
        <div className="table-wrap" style={{ border: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Model</th>
                {scorerKeys.map((s) => (
                  <th key={s.key} className="num">
                    {s.label}
                  </th>
                ))}
                <th className="num">Done</th>
                <th className="num">Errors</th>
                <th className="num">Avg latency</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => (
                <tr key={s.key}>
                  <td>
                    <strong>{s.label}</strong>
                  </td>
                  {scorerKeys.map((k) => (
                    <td key={k.key} className="num">
                      {s.scores[k.key] != null ? <Badge tone={scoreTone(s.scores[k.key] ?? undefined)}>{formatPercent(s.scores[k.key], 1)}</Badge> : '—'}
                    </td>
                  ))}
                  <td className="num">
                    {s.n}/{run.inputs.length}
                  </td>
                  <td className="num">{s.errors || '—'}</td>
                  <td className="num">{formatMs(s.latency)}</td>
                  <td className="num">{formatCompact(s.tokens)}</td>
                  <td className="num">{formatUSD(s.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Results"
        actions={<Checkbox checked={onlyFailures} onChange={setOnlyFailures} label="Only rows with errors or imperfect scores" />}
      >
        <DataTable columns={columns} rows={visibleInputs} rowKey={(i) => i.rowIndex} onRowClick={(i) => setDetail(i.rowIndex)} pageSize={25} />
      </Card>

      <details>
        <summary>Configuration</summary>
        <pre className="plain mono small">{JSON.stringify(run.config, null, 2)}</pre>
      </details>

      {detailInput ? (
        <Modal title={`Row ${detailInput.rowIndex + 1}`} onClose={() => setDetail(null)} wide>
          <div className="stack">
            <Field label="Prompt">
              <pre className="plain mono small">{(detailInput.system ? `[system]\n${detailInput.system}\n\n` : '') + detailInput.prompt}</pre>
            </Field>
            {detailInput.expected != null ? (
              <Field label="Expected">
                <pre className="plain mono small">{detailInput.expected}</pre>
              </Field>
            ) : null}
            {run.config.models.map((m) => {
              const c = byCell.get(`${detailInput.rowIndex}|${modelKey(m)}`);
              return (
                <Card
                  key={modelKey(m)}
                  title={<h3>{m.model}</h3>}
                  actions={
                    c ? (
                      <span className="small subtle">
                        {formatMs(c.latencyMs)} · {c.usage ? `${c.usage.inputTokens}→${c.usage.outputTokens} tok` : ''} · {formatUSD(c.costUsd)}
                      </span>
                    ) : null
                  }
                >
                  {!c ? (
                    <span className="subtle">Not run yet</span>
                  ) : c.error ? (
                    <Notice tone="err">{c.error}</Notice>
                  ) : (
                    <div className="stack sm">
                      <div className="row">
                        {scorerKeys.map((s) =>
                          c.scores[s.key] != null ? (
                            <Badge key={s.key} tone={scoreTone(c.scores[s.key])}>
                              {s.label}: {formatPercent(c.scores[s.key])}
                            </Badge>
                          ) : null,
                        )}
                      </div>
                      {c.judgeNotes ? <Notice>Judge: {c.judgeNotes}</Notice> : null}
                      <Markdown text={c.output || '(empty)'} />
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </Modal>
      ) : null}

      {push ? (
        <PushToHubDialog
          type="dataset"
          defaultName={slugify(run.name)}
          describe={`${run.cells.length} evaluation results (prompts, outputs, scores) as results.jsonl plus a README`}
          buildFiles={async () => {
            const summaryTable = [
              `| Model | ${scorerKeys.map((s) => s.label).join(' | ')} | Avg latency | Cost |`,
              `|---|${scorerKeys.map(() => '---:').join('|')}|---:|---:|`,
              ...summaries.map((s) => `| ${s.label} | ${scorerKeys.map((k) => formatPercent(s.scores[k.key], 1)).join(' | ')} | ${formatMs(s.latency)} | ${formatUSD(s.cost)} |`),
            ].join('\n');
            const readme = `---\npretty_name: ${JSON.stringify(run.name)}\nconfigs:\n- config_name: default\n  data_files:\n  - split: train\n    path: results.jsonl\n---\n\n# ${run.name}\n\nEvaluation of ${run.config.models.length} model(s) on ${run.inputs.length} rows of "${run.config.datasetName}".\n\n${summaryTable}\n\n_Published from AI Workbench._\n`;
            return [
              { path: 'results.jsonl', content: new Blob([toJSONL(longRows(run))], { type: 'application/jsonl' }) },
              { path: 'README.md', content: new Blob([readme], { type: 'text/markdown' }) },
            ];
          }}
          onClose={() => setPush(false)}
        />
      ) : null}
    </div>
  );
}
