import { useMemo, useState } from 'react';
import { DataTable } from '../components/DataTable';
import { Badge, Button, Card, Field, Input, KeyValues, Notice, NumberInput, PageHeader, Progress, Select, Tabs, Textarea } from '../components/ui';
import { useCollection } from '../lib/collection';
import { parseCSV, toCSV } from '../lib/csv';
import { copyText, downloadText } from '../lib/download';
import { cellText, formatUSD, truncate } from '../lib/format';
import { inferColumns, parseJSONAuto, parseJSONL, toJSONL } from '../lib/jsonl';
import { describeError } from '../providers';
import { countAnthropicTokens } from '../providers/anthropic';
import { useRoute } from '../router';
import { datasets } from '../state/collections';
import { useSettings } from '../state/settings';
import { toast } from '../state/toast';
import { getSecret } from '../state/vault';
import { runModel, tokenize } from '../workers/mlClient';

type Tab = 'tokenizer' | 'search' | 'json' | 'cost';

export function ToolsPage() {
  const route = useRoute();
  const [tab, setTab] = useState<Tab>((route.query.get('tab') as Tab | null) ?? 'tokenizer');
  return (
    <div className="page">
      <PageHeader title="Tools" description="Utilities for everyday AI engineering. Everything runs locally unless a step says otherwise." />
      <Tabs
        tabs={[
          { id: 'tokenizer', label: 'Tokenizer' },
          { id: 'search', label: 'Semantic search' },
          { id: 'json', label: 'JSON / JSONL / CSV' },
          { id: 'cost', label: 'Cost planner' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'tokenizer' ? <TokenizerTool /> : null}
      {tab === 'search' ? <SemanticSearch /> : null}
      {tab === 'json' ? <JsonTool /> : null}
      {tab === 'cost' ? <CostPlanner /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

const TOKENIZERS = [
  { id: 'Xenova/gpt-4o', label: 'OpenAI o200k (GPT-4o family)' },
  { id: 'onnx-community/Qwen3-0.6B-ONNX', label: 'Qwen3' },
  { id: 'Xenova/llama-3-tokenizer', label: 'Llama 3' },
  { id: 'Xenova/mistral-tokenizer-v3', label: 'Mistral v3' },
  { id: 'Xenova/bert-base-uncased', label: 'BERT (WordPiece)' },
];

function TokenizerPanel({ text, initial }: { text: string; initial: string }) {
  const [model, setModel] = useState(initial);
  const [result, setResult] = useState<{ ids: number[]; pieces: string[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      setResult(await tokenize(model.trim(), text));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={
        <div className="row nowrap" style={{ flex: 1 }}>
          <Select value={TOKENIZERS.some((t) => t.id === model) ? model : ''} onChange={(e) => e.target.value && setModel(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">Custom…</option>
            {TOKENIZERS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
          <Input value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
      }
      actions={
        <Button size="sm" variant="primary" loading={busy} disabled={!text} onClick={run}>
          Tokenize
        </Button>
      }
    >
      {error ? <Notice tone="err">{error}</Notice> : null}
      {result ? (
        <div className="stack">
          <div className="row">
            <Badge tone="accent">{result.ids.length.toLocaleString()} tokens</Badge>
            <Badge>{text.length.toLocaleString()} chars</Badge>
            <Badge>{result.ids.length ? (text.length / result.ids.length).toFixed(2) : '—'} chars/token</Badge>
          </div>
          <div className="tokens">
            {result.pieces.slice(0, 3000).map((p, i) => (
              <span key={i} className="tok" title={`id ${result.ids[i]}`}>
                {p}
              </span>
            ))}
          </div>
          <details>
            <summary>Token ids</summary>
            <pre className="plain mono small">{JSON.stringify(result.ids)}</pre>
          </details>
        </div>
      ) : (
        <span className="small subtle">Downloads only the tokenizer files (a few MB) from Hugging Face.</span>
      )}
    </Card>
  );
}

function TokenizerTool() {
  const settings = useSettings();
  const [text, setText] = useState('Tokenizers split text into subword units. Unusual words, code, and non-English text often cost more tokens: e.g. "Grüß Gott", `fn main() {}` 🚀');
  const anthropic = settings.providers.find((p) => p.kind === 'anthropic' && p.enabled);
  const [claudeModel, setClaudeModel] = useState(anthropic?.defaultModel ?? 'claude-opus-5-5');
  const [claudeCount, setClaudeCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="stack lg">
      <Field label="Text">
        <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <TokenizerPanel text={text} initial="Xenova/gpt-4o" />
        <TokenizerPanel text={text} initial="onnx-community/Qwen3-0.6B-ONNX" />
      </div>
      {anthropic ? (
        <Card title="Claude token count (exact, via API)">
          <div className="row">
            <Select value={claudeModel} onChange={(e) => setClaudeModel(e.target.value)} style={{ maxWidth: 260 }}>
              {anthropic.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
            <Button
              loading={busy}
              disabled={!text}
              onClick={async () => {
                setBusy(true);
                try {
                  setClaudeCount(await countAnthropicTokens(anthropic, anthropic.secretRef ? getSecret(anthropic.secretRef) : undefined, claudeModel, text));
                } catch (err) {
                  toast(describeError(err), 'error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Count tokens
            </Button>
            {claudeCount != null ? <Badge tone="accent">{claudeCount.toLocaleString()} input tokens</Badge> : null}
          </div>
          <p className="small subtle" style={{ marginBottom: 0 }}>
            Claude's tokenizer is not published, so counting uses Anthropic's free token counting endpoint (sends the text to api.anthropic.com). The count
            includes a few tokens of message framing.
          </p>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SemanticSearch() {
  const { items } = useCollection(datasets);
  const [dsId, setDsId] = useState('');
  const [column, setColumn] = useState('');
  const [model, setModel] = useState('onnx-community/all-MiniLM-L6-v2-ONNX');
  const [index, setIndex] = useState<{ vectors: number[][]; rows: number[]; key: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ row: number; score: number }[]>([]);
  const [error, setError] = useState('');
  const dataset = items.find((d) => d.id === dsId) ?? items[0];
  const col = column || dataset?.columns[0] || '';
  const limit = 2000;

  const embed = async (texts: string[]): Promise<number[][]> => {
    const r = await runModel<{ data: number[][] }>({ task: 'feature-extraction', model, device: 'auto' }, texts);
    return r.data.data;
  };

  const build = async () => {
    if (!dataset) return;
    setError('');
    setProgress(0);
    try {
      const rows = dataset.rows.slice(0, limit).map((r, i) => ({ i, text: cellText(r[col]) })).filter((r) => r.text.trim());
      const vectors: number[][] = [];
      for (let k = 0; k < rows.length; k += 32) {
        vectors.push(...(await embed(rows.slice(k, k + 32).map((r) => r.text.slice(0, 2000)))));
        setProgress(Math.min(1, (k + 32) / rows.length));
      }
      setIndex({ vectors, rows: rows.map((r) => r.i), key: `${dataset.id}|${col}|${model}` });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setProgress(null);
    }
  };

  const search = async () => {
    if (!index || !query.trim()) return;
    try {
      const [q] = await embed([query]);
      const scored = index.vectors.map((v, k) => ({ row: index.rows[k], score: v.reduce((s, x, j) => s + x * q[j], 0) }));
      scored.sort((a, b) => b.score - a.score);
      setHits(scored.slice(0, 10));
    } catch (err) {
      setError(describeError(err));
    }
  };

  if (!items.length) return <Notice>Import a dataset first (Datasets page), then build a local embedding index over one of its text columns.</Notice>;

  const stale = index && index.key !== `${dataset?.id}|${col}|${model}`;

  return (
    <div className="stack lg">
      <Card title="1. Build an index">
        <div className="stack">
          <div className="grid cols-3">
            <Field label="Dataset">
              <Select value={dataset?.id} onChange={(e) => setDsId(e.target.value)}>
                {items.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Text column">
              <Select value={col} onChange={(e) => setColumn(e.target.value)}>
                {dataset?.columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Embedding model">
              <Input value={model} onChange={(e) => setModel(e.target.value)} />
            </Field>
          </div>
          <div className="row">
            <Button variant="primary" icon="zap" loading={progress != null} onClick={build}>
              Embed {Math.min(dataset?.rows.length ?? 0, limit).toLocaleString()} rows locally
            </Button>
            {index && !stale ? <Badge tone="ok">{index.vectors.length.toLocaleString()} vectors ready</Badge> : null}
            {stale ? <Badge tone="warn">settings changed — rebuild</Badge> : null}
          </div>
          {progress != null ? <Progress value={progress} /> : null}
          <span className="small subtle">This is the retrieval half of RAG: texts become vectors on your device; queries are matched by cosine similarity.</span>
        </div>
      </Card>
      {error ? <Notice tone="err">{error}</Notice> : null}
      <Card title="2. Search">
        <div className="stack">
          <form
            className="row nowrap"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <Input placeholder="Ask in natural language…" value={query} onChange={(e) => setQuery(e.target.value)} disabled={!index} />
            <Button type="submit" variant="primary" icon="search" disabled={!index || !query.trim()}>
              Search
            </Button>
          </form>
          {hits.length && dataset ? (
            <DataTable<{ row: number; score: number }>
              columns={[
                { key: 'score', label: 'Similarity', num: true, render: (h) => h.score.toFixed(3) },
                { key: 'row', label: 'Row', num: true, render: (h) => h.row + 1 },
                { key: 'text', label: col, render: (h) => <div className="cell">{truncate(cellText(dataset.rows[h.row]?.[col]), 400)}</div> },
              ]}
              rows={hits}
              rowKey={(h) => h.row}
            />
          ) : null}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function JsonTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const act = (fn: () => string, ok: string) => {
    try {
      setOutput(fn());
      setMessage({ tone: 'ok', text: ok });
    } catch (err) {
      setMessage({ tone: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <Card title="Input">
        <div className="stack">
          <Textarea rows={16} className="mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder='{"paste": "JSON, JSONL or CSV here"}' />
          <div className="row">
            <Button size="sm" onClick={() => act(() => JSON.stringify(JSON.parse(input), null, 2), 'Valid JSON')}>
              Validate & format
            </Button>
            <Button size="sm" onClick={() => act(() => JSON.stringify(JSON.parse(input)), 'Minified')}>
              Minify
            </Button>
            <Button
              size="sm"
              onClick={() =>
                act(() => {
                  const r = parseJSONL(input);
                  if (r.errors.length) throw new Error(`Line ${r.errors[0].line}: ${r.errors[0].message} (${r.errors.length} bad lines)`);
                  return `${r.rows.length} valid JSONL records\n\n${JSON.stringify(r.rows.slice(0, 3), null, 2)}`;
                }, 'Valid JSONL')
              }
            >
              Validate JSONL
            </Button>
            <Button size="sm" onClick={() => act(() => toJSONL(parseJSONAuto(input).rows), 'Converted to JSONL')}>
              → JSONL
            </Button>
            <Button size="sm" onClick={() => act(() => JSON.stringify(parseJSONAuto(input).rows, null, 2), 'Converted to JSON array')}>
              → JSON array
            </Button>
            <Button
              size="sm"
              onClick={() =>
                act(() => {
                  const rows = parseJSONAuto(input).rows;
                  return toCSV(inferColumns(rows), rows, { safe: false });
                }, 'Converted to CSV')
              }
            >
              → CSV
            </Button>
            <Button size="sm" onClick={() => act(() => JSON.stringify(parseCSV(input).rows, null, 2), 'Parsed CSV')}>
              CSV → JSON
            </Button>
          </div>
        </div>
      </Card>
      <Card
        title="Output"
        actions={
          <>
            <Button size="sm" icon="copy" disabled={!output} onClick={async () => toast((await copyText(output)) ? 'Copied' : 'Copy failed')}>
              Copy
            </Button>
            <Button size="sm" icon="download" disabled={!output} onClick={() => downloadText(output, 'output.txt')}>
              Save
            </Button>
          </>
        }
      >
        <div className="stack">
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
          <pre className="plain mono small" style={{ minHeight: 300, maxHeight: '60vh' }}>
            {output}
          </pre>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function CostPlanner() {
  const settings = useSettings();
  const [requests, setRequests] = useState<number | undefined>(1000);
  const [inTok, setInTok] = useState<number | undefined>(1500);
  const [outTok, setOutTok] = useState<number | undefined>(400);
  const [cachedPct, setCachedPct] = useState<number | undefined>(0);

  const rows = useMemo(() => {
    const r = requests ?? 0;
    const i = inTok ?? 0;
    const o = outTok ?? 0;
    const cached = (cachedPct ?? 0) / 100;
    return settings.pricing
      .map((p) => {
        // Cached input is billed at roughly 10% on most providers.
        const perReq = (i * (1 - cached) * p.input + i * cached * p.input * 0.1 + o * p.output) / 1e6;
        return { model: p.pattern, perReq, daily: perReq * r, monthly: perReq * r * 30, input: p.input, output: p.output };
      })
      .sort((a, b) => a.monthly - b.monthly);
  }, [settings.pricing, requests, inTok, outTok, cachedPct]);

  return (
    <div className="stack lg">
      <Card title="Workload">
        <div className="grid cols-4">
          <Field label="Requests per day">
            <NumberInput value={requests} min={0} step={100} onChange={setRequests} />
          </Field>
          <Field label="Input tokens / request">
            <NumberInput value={inTok} min={0} step={100} onChange={setInTok} />
          </Field>
          <Field label="Output tokens / request">
            <NumberInput value={outTok} min={0} step={50} onChange={setOutTok} />
          </Field>
          <Field label="Cached input %" hint="Prompt caching discount (~90% off cached tokens)">
            <NumberInput value={cachedPct} min={0} max={100} onChange={setCachedPct} />
          </Field>
        </div>
      </Card>
      <DataTable
        columns={[
          { key: 'model', label: 'Model / pattern', render: (r) => <code>{r.model}</code> },
          { key: 'price', label: '$ / 1M in · out', render: (r) => `${r.input} · ${r.output}` },
          { key: 'perReq', label: 'Per request', num: true, render: (r) => formatUSD(r.perReq) },
          { key: 'daily', label: 'Per day', num: true, render: (r) => formatUSD(r.daily) },
          { key: 'monthly', label: 'Per month (30d)', num: true, render: (r) => <strong>{formatUSD(r.monthly)}</strong> },
        ]}
        rows={rows}
        rowKey={(r) => r.model}
      />
      <KeyValues items={[['Prices', 'From Settings → Pricing. Add rows there for any provider or model you use; verify against the provider’s current price list.']]} />
    </div>
  );
}
