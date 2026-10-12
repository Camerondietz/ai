import { useEffect, useMemo, useState } from 'react';
import { DataTable } from '../components/DataTable';
import { FileDrop } from '../components/FileDrop';
import { JsonView } from '../components/JsonView';
import { CodeBlock } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { PushToHubDialog } from '../components/PushToHubDialog';
import { Badge, Button, Card, EmptyState, Field, Input, KeyValues, Notice, NumberInput, PageHeader, Progress, Select, Tabs, Textarea } from '../components/ui';
import { WeightsView } from '../components/WeightsView';
import { useCollection } from '../lib/collection';
import { sha256Hex } from '../lib/crypto';
import { downloadJSON, downloadText, pickFiles, timestampSlug } from '../lib/download';
import { formatBytes, formatCompact, formatRelative, slugify } from '../lib/format';
import { inspectGGUFBlob, type GGUFInfo } from '../lib/gguf';
import { fetchRepoJSON, inspectRemoteGGUF, inspectRemoteOnnx, inspectRemoteSafetensors, repoInfo, repoTree, type TreeEntry } from '../lib/hf';
import { modelCard } from '../lib/hfPush';
import { uid } from '../lib/id';
import { estimateMemory, hintsFromConfig, PRECISIONS, type ConfigHints } from '../lib/memory';
import { inspectOnnxBlob, type OnnxInfo } from '../lib/onnx';
import { inspectSafetensorsBlob, type WeightsSummary } from '../lib/safetensors';
import { describeError } from '../providers';
import { navigate, useRoute } from '../router';
import { models } from '../state/collections';
import { toast, toastError } from '../state/toast';
import type { ModelEntry } from '../state/types';

type Summary = WeightsSummary | GGUFInfo | OnnxInfo;
type Tab = 'inspect' | 'remote' | 'registry' | 'memory';

function entryFromSummary(name: string, kind: ModelEntry['kind'], source: string, summary: Summary, sizeBytes?: number, extra: Record<string, unknown> = {}): ModelEntry {
  const now = Date.now();
  const metadata: Record<string, unknown> = { ...extra, tensorCount: summary.tensors.length };
  if (summary.format === 'gguf') metadata.gguf = Object.fromEntries(Object.entries(summary.metadata).filter(([, v]) => typeof v !== 'object'));
  else if (summary.format === 'onnx') {
    const o = summary as OnnxInfo;
    Object.assign(metadata, { opsets: o.opsets, inputs: o.inputs, outputs: o.outputs, producer: o.producer });
  } else metadata.safetensors = summary.metadata;
  return {
    id: uid(),
    name,
    kind,
    source,
    format: summary.format,
    params: summary.totalParams,
    sizeBytes: sizeBytes ?? summary.totalBytes,
    dtypes: summary.dtypeParams,
    metadata,
    tags: [],
    notes: '',
    createdAt: now,
    updatedAt: now,
  };
}

export function ModelsPage() {
  const route = useRoute();
  const initial = (route.query.get('tab') as Tab | null) ?? (route.query.get('repo') ? 'remote' : 'inspect');
  const [tab, setTab] = useState<Tab>(initial);
  const [memoryPrefill, setMemoryPrefill] = useState<{ params?: number; hints?: ConfigHints } | null>(null);

  useEffect(() => {
    const t = route.query.get('tab') as Tab | null;
    if (t) setTab(t);
  }, [route.query]);

  return (
    <div className="page">
      <PageHeader
        title="Models"
        description="Inspect weights (safetensors, GGUF, ONNX) locally or straight from Hugging Face without downloading them, keep a model registry, and estimate memory."
      />
      <Tabs
        tabs={[
          { id: 'inspect', label: 'Inspect file' },
          { id: 'remote', label: 'Inspect from Hugging Face' },
          { id: 'registry', label: 'Registry' },
          { id: 'memory', label: 'Memory estimator' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'inspect' ? <InspectLocal /> : null}
      {tab === 'remote' ? (
        <InspectRemote
          initialRepo={route.query.get('repo') ?? ''}
          onEstimate={(p) => {
            setMemoryPrefill(p);
            setTab('memory');
          }}
        />
      ) : null}
      {tab === 'registry' ? <Registry /> : null}
      {tab === 'memory' ? <MemoryEstimator prefill={memoryPrefill} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function InspectLocal() {
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState<string | null>(null);

  const inspect = async (f: File) => {
    setFile(f);
    setSummary(null);
    setConfig(null);
    setError('');
    setHash(null);
    setBusy(true);
    try {
      const lower = f.name.toLowerCase();
      if (lower.endsWith('.json')) {
        setConfig(JSON.parse(await f.text()) as Record<string, unknown>);
      } else if (lower.endsWith('.gguf')) {
        setSummary(await inspectGGUFBlob(f));
      } else if (lower.endsWith('.onnx')) {
        setSummary(await inspectOnnxBlob(f));
      } else {
        setSummary(await inspectSafetensorsBlob(f));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const computeHash = async () => {
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024 * 1024) {
      toast('Hashing in the browser is limited to files under 1.5 GB.', 'warning');
      return;
    }
    setBusy(true);
    try {
      setHash(await sha256Hex(await file.arrayBuffer()));
    } catch (err) {
      toastError(err, 'Hash failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack lg">
      <FileDrop accept=".safetensors,.gguf,.onnx,.json" onFiles={([f]) => void inspect(f)}>
        <strong>Drop a model file here or click to choose</strong>
        <div className="small subtle">
          .safetensors, .gguf and config.json read only their headers, so multi-gigabyte files are instant. .onnx graphs are parsed fully. Files never leave your
          device.
        </div>
      </FileDrop>
      {busy ? <Progress value={0.5} /> : null}
      {error ? <Notice tone="err">{error}</Notice> : null}
      {file && summary ? (
        <>
          <div className="row">
            <Button
              variant="primary"
              icon="plus"
              onClick={async () => {
                await models.put(entryFromSummary(file.name, 'file', file.name, summary, file.size));
                toast('Added to registry', 'success');
              }}
            >
              Add to registry
            </Button>
            <Button icon="key" onClick={computeHash}>
              Compute SHA-256
            </Button>
            <Button icon="download" onClick={() => downloadJSON({ file: file.name, size: file.size, ...summary }, `${slugify(file.name)}.inspection.json`)}>
              Export inspection
            </Button>
          </div>
          {hash ? (
            <Notice tone="ok">
              SHA-256: <code>{hash}</code>
              <div className="small">Compare with the “SHA256” / LFS pointer shown on the Hugging Face file page to verify integrity.</div>
            </Notice>
          ) : null}
          <WeightsView summary={summary} fileSize={file.size} title={file.name} />
        </>
      ) : null}
      {config ? (
        <Card title="config.json">
          <ConfigHintsView config={config} />
        </Card>
      ) : null}
    </div>
  );
}

function ConfigHintsView({ config }: { config: Record<string, unknown> }) {
  const h = hintsFromConfig(config);
  return (
    <div className="stack">
      <KeyValues
        items={[
          ['Architecture', String((config.architectures as string[] | undefined)?.join(', ') ?? h.modelType ?? '—')],
          ['Layers', h.layers ?? '—'],
          ['Hidden size', h.hiddenSize ?? '—'],
          ['Attention heads', h.heads ?? '—'],
          ['KV heads', h.kvHeads != null && h.heads != null && h.kvHeads < h.heads ? `${h.kvHeads} (grouped-query attention)` : (h.kvHeads ?? '—')],
          ['Head dim', h.headDim ?? '—'],
          ['Max context', h.maxContext?.toLocaleString() ?? '—'],
          ['Vocab size', h.vocabSize?.toLocaleString() ?? '—'],
        ]}
      />
      <details>
        <summary>Raw config</summary>
        <JsonView value={config} />
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------

function InspectRemote({ initialRepo, onEstimate }: { initialRepo: string; onEstimate: (p: { params?: number; hints?: ConfigHints }) => void }) {
  const [repo, setRepo] = useState(initialRepo);
  const [files, setFiles] = useState<TreeEntry[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [label, setLabel] = useState('');
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const load = async () => {
    const id = repo.trim();
    if (!id.includes('/')) return;
    setBusy(true);
    setError('');
    setSummary(null);
    setFiles(null);
    setConfig(null);
    try {
      const tree = await repoTree('model', id);
      setFiles(tree.filter((f) => f.type === 'file'));
      if (tree.some((f) => f.path === 'config.json')) {
        try {
          setConfig(await fetchRepoJSON<Record<string, unknown>>('model', id, 'config.json'));
        } catch {
          // optional
        }
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initialRepo) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inspect = async (kind: 'safetensors' | 'gguf' | 'onnx', file?: string) => {
    const id = repo.trim();
    setBusy(true);
    setError('');
    setSummary(null);
    setProgress(null);
    try {
      if (kind === 'safetensors') {
        const s = await inspectRemoteSafetensors(id, 'main', (d, t) => setProgress(d / t));
        setSummary(s);
        setLabel(`${id} · ${s.shards.length} shard${s.shards.length > 1 ? 's' : ''}`);
      } else if (kind === 'gguf' && file) {
        setSummary(await inspectRemoteGGUF(id, file));
        setLabel(`${id} · ${file}`);
      } else if (kind === 'onnx' && file) {
        setSummary(await inspectRemoteOnnx(id, file));
        setLabel(`${id} · ${file}`);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const ggufFiles = files?.filter((f) => f.path.endsWith('.gguf')) ?? [];
  const onnxFiles = files?.filter((f) => f.path.endsWith('.onnx')) ?? [];
  const hasSafetensors = files?.some((f) => f.path.endsWith('.safetensors')) ?? false;
  const totalSize = files?.reduce((s, f) => s + (f.lfs?.size ?? f.size ?? 0), 0) ?? 0;

  return (
    <div className="stack lg">
      <Card>
        <div className="stack">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="flex-1">
              <Field label="Model repository" hint="e.g. Qwen/Qwen3-8B, meta-llama/Llama-3.1-8B-Instruct (gated: needs token), unsloth/…-GGUF">
                <Input value={repo} onChange={(e) => setRepo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void load()} placeholder="owner/model" />
              </Field>
            </div>
            <Button variant="primary" icon="search" loading={busy && !files} disabled={!repo.includes('/')} onClick={load}>
              Load files
            </Button>
          </div>
          <span className="small subtle">
            Uses HTTP range requests to read only file headers (a few KB to a few MB), never the full weights.
          </span>
        </div>
      </Card>
      {error ? <Notice tone="err">{error}</Notice> : null}
      {files ? (
        <Card title={`${files.length} files · ${formatBytes(totalSize)}`}>
          <div className="stack">
            <div className="row">
              {hasSafetensors ? (
                <Button variant="primary" icon="cpu" loading={busy} onClick={() => void inspect('safetensors')}>
                  Inspect safetensors weights
                </Button>
              ) : null}
              {config ? (
                <Button
                  icon="sliders"
                  onClick={() => onEstimate({ params: summary?.totalParams, hints: hintsFromConfig(config) })}
                >
                  Estimate memory
                </Button>
              ) : null}
            </div>
            {ggufFiles.length ? (
              <div className="stack sm">
                <h3>GGUF files</h3>
                {ggufFiles.map((f) => (
                  <div key={f.path} className="row">
                    <code className="flex-1 ellipsis">{f.path}</code>
                    <span className="small subtle">{formatBytes(f.lfs?.size ?? f.size)}</span>
                    <Button size="sm" disabled={busy} onClick={() => void inspect('gguf', f.path)}>
                      Inspect
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            {onnxFiles.length ? (
              <div className="stack sm">
                <h3>ONNX files</h3>
                {onnxFiles.map((f) => (
                  <div key={f.path} className="row">
                    <code className="flex-1 ellipsis">{f.path}</code>
                    <span className="small subtle">{formatBytes(f.lfs?.size ?? f.size)}</span>
                    <Button size="sm" disabled={busy || (f.lfs?.size ?? f.size ?? 0) > 300 * 1024 * 1024} onClick={() => void inspect('onnx', f.path)}>
                      Inspect
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            {!hasSafetensors && !ggufFiles.length && !onnxFiles.length ? <span className="muted">No safetensors, GGUF or ONNX weights found in this repo.</span> : null}
          </div>
        </Card>
      ) : null}
      {progress != null ? <Progress value={progress} /> : null}
      {config ? (
        <Card title="Architecture (config.json)">
          <ConfigHintsView config={config} />
        </Card>
      ) : null}
      {summary ? (
        <>
          <div className="row">
            <Button
              variant="primary"
              icon="plus"
              onClick={async () => {
                let extra: Record<string, unknown> = {};
                try {
                  const info = await repoInfo('model', repo.trim());
                  extra = { pipeline_tag: info.pipeline_tag, library_name: info.library_name, license: info.cardData?.license, sha: info.sha };
                } catch {
                  // optional
                }
                await models.put(entryFromSummary(repo.trim(), 'hub', repo.trim(), summary, undefined, { ...extra, config: config ? hintsFromConfig(config) : undefined }));
                toast('Added to registry', 'success');
              }}
            >
              Add to registry
            </Button>
            {config ? (
              <Button icon="sliders" onClick={() => onEstimate({ params: summary.totalParams, hints: hintsFromConfig(config) })}>
                Estimate memory
              </Button>
            ) : null}
          </div>
          <WeightsView summary={summary} title={label} />
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Registry() {
  const { items } = useCollection(models);
  const [open, setOpen] = useState<ModelEntry | null>(null);
  const [adding, setAdding] = useState(false);

  const importRegistry = async () => {
    const [file] = await pickFiles('.json,application/json');
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as { models?: ModelEntry[] } | ModelEntry[];
      const list = Array.isArray(parsed) ? parsed : (parsed.models ?? []);
      const valid = list.filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string');
      await models.putMany(valid.map((m) => ({ ...m, tags: m.tags ?? [], notes: m.notes ?? '' })));
      toast(`Imported ${valid.length} models`, 'success');
    } catch (err) {
      toastError(err, 'Import failed');
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
          Add endpoint / note
        </Button>
        <Button icon="upload" onClick={importRegistry}>
          Import
        </Button>
        <Button icon="download" disabled={!items.length} onClick={() => downloadJSON({ format: 'ai-workbench/models', version: 1, models: items }, `model-registry-${timestampSlug()}.json`)}>
          Export
        </Button>
      </div>
      <DataTable<ModelEntry>
        columns={[
          { key: 'name', label: 'Name', render: (m) => <strong>{m.name}</strong> },
          { key: 'kind', label: 'Kind', render: (m) => <Badge>{m.kind}</Badge> },
          { key: 'format', label: 'Format', render: (m) => m.format ?? '—' },
          { key: 'params', label: 'Params', num: true, render: (m) => formatCompact(m.params) },
          { key: 'size', label: 'Size', num: true, render: (m) => formatBytes(m.sizeBytes) },
          { key: 'tags', label: 'Tags', render: (m) => m.tags.join(', ') },
          { key: 'updated', label: 'Updated', render: (m) => formatRelative(m.updatedAt) },
        ]}
        rows={items}
        rowKey={(m) => m.id}
        onRowClick={(m) => setOpen(m)}
        empty={
          <Card>
            <EmptyState title="Registry is empty">
              Inspect a file or Hugging Face repo and add it here, or record API endpoints and fine-tunes you use in production.
            </EmptyState>
          </Card>
        }
      />
      {open ? <RegistryEntryDialog entry={open} onClose={() => setOpen(null)} /> : null}
      {adding ? <AddEntryDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function AddEntryDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState('');
  return (
    <Modal
      title="Add registry entry"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              const now = Date.now();
              await models.put({ id: uid(), name: name.trim(), kind: 'endpoint', source: source.trim(), tags: [], notes, createdAt: now, updatedAt: now });
              onClose();
            }}
          >
            Add
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Support-bot fine-tune v3" />
        </Field>
        <Field label="Source" hint="Provider/model id, endpoint URL, or repo">
          <Input value={source} onChange={(e) => setSource(e.target.value)} />
        </Field>
        <Field label="Notes">
          <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Owner, purpose, eval results, deployment notes…" />
        </Field>
      </div>
    </Modal>
  );
}

function RegistryEntryDialog({ entry, onClose }: { entry: ModelEntry; onClose: () => void }) {
  const [name, setName] = useState(entry.name);
  const [tags, setTags] = useState(entry.tags.join(', '));
  const [notes, setNotes] = useState(entry.notes);
  const [push, setPush] = useState(false);
  const card = modelCard({
    name,
    description: notes,
    baseModel: entry.kind === 'hub' ? entry.source : undefined,
    params: entry.params,
    format: entry.format,
    tags: tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  });

  const save = async () => {
    await models.put({
      ...entry,
      name: name.trim() || entry.name,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      notes,
      updatedAt: Date.now(),
    });
    onClose();
  };

  return (
    <Modal
      title={entry.name}
      onClose={onClose}
      wide
      footer={
        <>
          <Button
            variant="danger"
            icon="trash"
            onClick={async () => {
              if (!confirm(`Remove "${entry.name}" from the registry?`)) return;
              await models.remove(entry.id);
              onClose();
            }}
          >
            Remove
          </Button>
          <div className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Tags">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="production, eval-passed, q4" />
          </Field>
        </div>
        <KeyValues
          items={[
            ['Kind', entry.kind],
            ['Source', entry.kind === 'hub' ? <a href={`#/hub?model=${encodeURIComponent(entry.source)}`}>{entry.source}</a> : entry.source || '—'],
            ['Format', entry.format ?? '—'],
            ['Parameters', entry.params ? entry.params.toLocaleString() : '—'],
            ['Size', formatBytes(entry.sizeBytes)],
          ]}
        />
        <Field label="Notes">
          <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {entry.metadata ? (
          <details>
            <summary>Metadata</summary>
            <JsonView value={entry.metadata} />
          </details>
        ) : null}
        <details>
          <summary>Model card (README.md)</summary>
          <div className="stack sm">
            <CodeBlock code={card} lang="markdown" />
            <div className="row">
              <Button size="sm" icon="download" onClick={() => downloadText(card, 'README.md', 'text/markdown')}>
                Download
              </Button>
              <Button size="sm" icon="upload" onClick={() => setPush(true)}>
                Push card to a model repo…
              </Button>
            </div>
          </div>
        </details>
      </div>
      {push ? (
        <PushToHubDialog
          type="model"
          defaultName={slugify(name)}
          describe="a README.md model card (no weights)"
          buildFiles={async () => [{ path: 'README.md', content: new Blob([card], { type: 'text/markdown' }) }]}
          onClose={() => setPush(false)}
        />
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

const GPU_SIZES = [8, 12, 16, 24, 32, 48, 80, 141];

function MemoryEstimator({ prefill }: { prefill: { params?: number; hints?: ConfigHints } | null }) {
  const h = prefill?.hints;
  const [paramsB, setParamsB] = useState<number | undefined>(prefill?.params ? +(prefill.params / 1e9).toFixed(3) : 8);
  const [precision, setPrecision] = useState(1);
  const [layers, setLayers] = useState<number | undefined>(h?.layers ?? 32);
  const [kvHeads, setKvHeads] = useState<number | undefined>(h?.kvHeads ?? 8);
  const [headDim, setHeadDim] = useState<number | undefined>(h?.headDim ?? 128);
  const [context, setContext] = useState<number | undefined>(Math.min(h?.maxContext ?? 8192, 32768));
  const [batch, setBatch] = useState<number | undefined>(1);
  const [kvBytes, setKvBytes] = useState(2);
  const [overhead, setOverhead] = useState<number | undefined>(10);

  const est = useMemo(
    () =>
      estimateMemory({
        params: (paramsB ?? 0) * 1e9,
        bytesPerParam: PRECISIONS[precision].bytes,
        layers: layers ?? 0,
        kvHeads: kvHeads ?? 0,
        headDim: headDim ?? 0,
        context: context ?? 0,
        batch: batch ?? 1,
        kvBytes,
        overheadPct: overhead ?? 0,
      }),
    [paramsB, precision, layers, kvHeads, headDim, context, batch, kvBytes, overhead],
  );
  const gb = (b: number) => b / 1024 ** 3;

  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <Card title="Inputs">
        <div className="stack">
          {h ? <Notice tone="ok">Prefilled from config.json{prefill?.params ? ' and inspected weights' : ''}.</Notice> : null}
          <div className="grid cols-2">
            <Field label="Parameters (billions)">
              <NumberInput value={paramsB} min={0} step={0.1} onChange={setParamsB} />
            </Field>
            <Field label="Weight precision">
              <Select value={precision} onChange={(e) => setPrecision(Number(e.target.value))}>
                {PRECISIONS.map((p, i) => (
                  <option key={p.label} value={i}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Layers">
              <NumberInput value={layers} min={0} onChange={setLayers} />
            </Field>
            <Field label="KV heads">
              <NumberInput value={kvHeads} min={0} onChange={setKvHeads} />
            </Field>
            <Field label="Head dim">
              <NumberInput value={headDim} min={0} onChange={setHeadDim} />
            </Field>
            <Field label="Context length (tokens)">
              <NumberInput value={context} min={0} step={1024} onChange={setContext} />
            </Field>
            <Field label="Concurrent sequences">
              <NumberInput value={batch} min={1} onChange={setBatch} />
            </Field>
            <Field label="KV cache precision">
              <Select value={kvBytes} onChange={(e) => setKvBytes(Number(e.target.value))}>
                <option value={2}>FP16 / BF16</option>
                <option value={1}>FP8 / INT8</option>
                <option value={0.5}>4-bit</option>
              </Select>
            </Field>
            <Field label="Runtime overhead %">
              <NumberInput value={overhead} min={0} max={100} onChange={setOverhead} />
            </Field>
          </div>
        </div>
      </Card>
      <Card title="Estimate">
        <div className="stack">
          <KeyValues
            items={[
              ['Weights', `${gb(est.weights).toFixed(2)} GB`],
              ['KV cache', `${gb(est.kvCache).toFixed(2)} GB`],
              ['Overhead', `${gb(est.overhead).toFixed(2)} GB`],
              ['Total', <strong key="t">{gb(est.total).toFixed(2)} GB</strong>],
            ]}
          />
          <div className="row">
            {GPU_SIZES.map((g) => (
              <Badge key={g} tone={gb(est.total) <= g * 0.95 ? 'ok' : 'err'}>
                {g} GB {gb(est.total) <= g * 0.95 ? 'fits' : '✗'}
              </Badge>
            ))}
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            KV cache = 2 × layers × KV heads × head dim × context × sequences × bytes. Grouped-query attention (fewer KV heads) is why modern models fit long
            contexts. Real usage varies by runtime (vLLM pre-allocates, llama.cpp is leaner); treat this as a planning number.
          </p>
        </div>
      </Card>
    </div>
  );
}
