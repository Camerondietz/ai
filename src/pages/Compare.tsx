import { useRef, useState } from 'react';
import { Markdown } from '../components/Markdown';
import { ModelPicker } from '../components/ModelPicker';
import { Badge, Button, Card, Field, Notice, NumberInput, PageHeader, Textarea } from '../components/ui';
import { toCSV } from '../lib/csv';
import { downloadJSON, downloadText, timestampSlug } from '../lib/download';
import { formatCompact, formatMs, formatUSD } from '../lib/format';
import { uid } from '../lib/id';
import { describeError, modelKey, runChat } from '../providers';
import { datasets } from '../state/collections';
import { getSettings } from '../state/settings';
import { toast } from '../state/toast';
import type { ChatParams, Dataset, ModelRef, Row, TokenUsage } from '../state/types';

interface Slot {
  id: string;
  ref?: ModelRef;
}

interface SlotResult {
  text: string;
  thinking?: string;
  running: boolean;
  error?: string;
  latencyMs?: number;
  firstTokenMs?: number;
  usage?: TokenUsage;
  costUsd?: number;
  rating?: number;
}

function initialSlots(): Slot[] {
  const s = getSettings();
  const refs: ModelRef[] = [];
  for (const p of s.providers) {
    if (!p.enabled || p.kind === 'local') continue;
    for (const m of p.models.slice(0, 2)) refs.push({ providerId: p.id, model: m });
  }
  const first = s.defaultModel ? [s.defaultModel] : [];
  const unique = [...first, ...refs].filter((r, i, arr) => arr.findIndex((x) => modelKey(x) === modelKey(r)) === i);
  return [0, 1].map((i) => ({ id: uid(), ref: unique[i] }));
}

const COMPARISON_DATASET = 'Model comparisons';

export function ComparePage() {
  const [system, setSystem] = useState('');
  const [prompt, setPrompt] = useState('');
  const [params, setParams] = useState<ChatParams>({});
  const [slots, setSlots] = useState<Slot[]>(initialSlots);
  const [results, setResults] = useState<Record<string, SlotResult>>({});
  const controllers = useRef<AbortController[]>([]);
  const running = Object.values(results).some((r) => r.running);

  const patch = (slotId: string, p: Partial<SlotResult>) =>
    setResults((prev) => ({ ...prev, [slotId]: { ...(prev[slotId] ?? { text: '', running: false }), ...p } }));

  const run = async () => {
    const active = slots.filter((s) => s.ref);
    if (!prompt.trim() || !active.length) return;
    controllers.current = [];
    setResults({});
    await Promise.all(
      active.map(async (slot) => {
        const ref = slot.ref!;
        const controller = new AbortController();
        controllers.current.push(controller);
        let text = '';
        let thinking = '';
        patch(slot.id, { text: '', running: true });
        try {
          const r = await runChat({
            providerId: ref.providerId,
            model: ref.model,
            system,
            messages: [{ role: 'user', content: prompt }],
            params,
            source: 'compare',
            signal: controller.signal,
            onDelta: (t) => {
              text += t;
              patch(slot.id, { text });
            },
            onThinking: (t) => {
              thinking += t;
              patch(slot.id, { thinking });
            },
          });
          patch(slot.id, {
            text: r.text,
            thinking: r.thinking || thinking || undefined,
            running: false,
            latencyMs: r.latencyMs,
            firstTokenMs: r.firstTokenMs,
            usage: r.usage,
            costUsd: r.costUsd,
          });
        } catch (err) {
          patch(slot.id, { running: false, error: describeError(err) });
        }
      }),
    );
  };

  const rows = (): Row[] =>
    slots
      .filter((s) => s.ref && results[s.id] && !results[s.id].running)
      .map((s) => {
        const r = results[s.id];
        return {
          system,
          prompt,
          provider: s.ref!.providerId,
          model: s.ref!.model,
          output: r.text,
          error: r.error ?? '',
          latency_ms: Math.round(r.latencyMs ?? 0),
          input_tokens: r.usage?.inputTokens ?? 0,
          output_tokens: r.usage?.outputTokens ?? 0,
          cost_usd: r.costUsd ?? 0,
          rating: r.rating ?? '',
          timestamp: new Date().toISOString(),
        };
      });

  const saveToDataset = async () => {
    const newRows = rows();
    if (!newRows.length) return;
    const all = await datasets.all();
    const existing = all.find((d) => d.name === COMPARISON_DATASET);
    const now = Date.now();
    const columns = Object.keys(newRows[0]);
    const ds: Dataset = existing
      ? { ...existing, rows: [...existing.rows, ...newRows], updatedAt: now }
      : { id: uid(), name: COMPARISON_DATASET, description: 'Side-by-side outputs saved from Compare, with ratings.', source: 'compare', columns, rows: newRows, createdAt: now, updatedAt: now };
    await datasets.put(ds);
    toast(`Saved ${newRows.length} rows to "${COMPARISON_DATASET}"`, 'success');
  };

  return (
    <div className="page">
      <PageHeader
        title="Compare models"
        description="Send the same prompt to several models at once and compare quality, latency, tokens and cost side by side."
        actions={
          <>
            <Button icon="table" disabled={running || !rows().length} onClick={saveToDataset}>
              Save to dataset
            </Button>
            <Button icon="download" disabled={running || !rows().length} onClick={() => downloadJSON(rows(), `comparison-${timestampSlug()}.json`)}>
              JSON
            </Button>
            <Button
              icon="download"
              disabled={running || !rows().length}
              onClick={() => {
                const r = rows();
                downloadText(toCSV(Object.keys(r[0]), r), `comparison-${timestampSlug()}.csv`, 'text/csv');
              }}
            >
              CSV
            </Button>
          </>
        }
      />
      <div className="stack lg">
        <Card>
          <div className="stack">
            <div className="grid cols-2">
              <Field label="System prompt (optional)">
                <Textarea rows={4} value={system} onChange={(e) => setSystem(e.target.value)} />
              </Field>
              <Field label="Prompt">
                <Textarea
                  rows={4}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void run();
                  }}
                  placeholder="Ctrl+Enter to run"
                />
              </Field>
            </div>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              {slots.map((slot, i) => (
                <div key={slot.id} className="row nowrap" style={{ minWidth: 240, flex: '1 1 240px' }}>
                  <div className="flex-1">
                    <Field label={`Model ${i + 1}`}>
                      <ModelPicker value={slot.ref} onChange={(ref) => setSlots((s) => s.map((x) => (x.id === slot.id ? { ...x, ref } : x)))} />
                    </Field>
                  </div>
                  {slots.length > 1 ? (
                    <Button variant="ghost" iconOnly icon="x" aria-label="Remove model" onClick={() => setSlots((s) => s.filter((x) => x.id !== slot.id))} />
                  ) : null}
                </div>
              ))}
              {slots.length < 6 ? (
                <Button icon="plus" onClick={() => setSlots((s) => [...s, { id: uid() }])}>
                  Add model
                </Button>
              ) : null}
            </div>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div style={{ width: 140 }}>
                <Field label="Temperature">
                  <NumberInput value={params.temperature} min={0} max={2} step={0.1} placeholder="default" onChange={(v) => setParams({ ...params, temperature: v })} />
                </Field>
              </div>
              <div style={{ width: 160 }}>
                <Field label="Max output tokens">
                  <NumberInput value={params.maxTokens} min={1} step={256} placeholder="default" onChange={(v) => setParams({ ...params, maxTokens: v })} />
                </Field>
              </div>
              <div className="flex-1" />
              {running ? (
                <Button variant="danger" icon="stop" onClick={() => controllers.current.forEach((c) => c.abort())}>
                  Stop all
                </Button>
              ) : (
                <Button variant="primary" icon="play" disabled={!prompt.trim() || !slots.some((s) => s.ref)} onClick={() => void run()}>
                  Run comparison
                </Button>
              )}
            </div>
            <span className="small subtle">Models that ignore sampling parameters (e.g. current Claude models) run with their defaults.</span>
          </div>
        </Card>

        {Object.keys(results).length ? (
          <div className="compare-grid">
            {slots
              .filter((s) => results[s.id])
              .map((slot) => {
                const r = results[slot.id];
                return (
                  <Card
                    key={slot.id}
                    title={<h3 className="ellipsis">{slot.ref?.model}</h3>}
                    actions={
                      r.running ? (
                        <span className="spinner" />
                      ) : (
                        <div className="row nowrap">
                          {[1, 2, 3, 4, 5].map((n) => (
                            <Button
                              key={n}
                              size="sm"
                              variant={r.rating === n ? 'primary' : 'ghost'}
                              aria-label={`Rate ${n}`}
                              onClick={() => patch(slot.id, { rating: r.rating === n ? undefined : n })}
                            >
                              {n}
                            </Button>
                          ))}
                        </div>
                      )
                    }
                  >
                    <div className="stack sm">
                      <div className="row small subtle">
                        {r.latencyMs != null ? <Badge>{formatMs(r.latencyMs)}</Badge> : null}
                        {r.firstTokenMs != null ? <Badge>TTFT {formatMs(r.firstTokenMs)}</Badge> : null}
                        {r.usage ? (
                          <Badge>
                            {formatCompact(r.usage.inputTokens)}→{formatCompact(r.usage.outputTokens)} tok{r.usage.estimated ? '*' : ''}
                          </Badge>
                        ) : null}
                        {r.costUsd ? <Badge>{formatUSD(r.costUsd)}</Badge> : null}
                      </div>
                      {r.thinking ? (
                        <details>
                          <summary>Reasoning</summary>
                          <div className="thinking">{r.thinking}</div>
                        </details>
                      ) : null}
                      {r.error ? <Notice tone="err">{r.error}</Notice> : <Markdown text={r.text || (r.running ? '…' : '(empty)')} />}
                    </div>
                  </Card>
                );
              })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
