import { useEffect, useMemo, useState } from 'react';
import { DataTable, type Column } from '../components/DataTable';
import { FileDrop } from '../components/FileDrop';
import { Modal } from '../components/Modal';
import { PushToHubDialog } from '../components/PushToHubDialog';
import { Badge, Button, Card, EmptyState, Field, Input, Notice, NumberInput, PageHeader, Progress, Select, Tabs, Textarea } from '../components/ui';
import { useCollection } from '../lib/collection';
import { parseCSV, toCSV } from '../lib/csv';
import { downloadJSON, downloadText } from '../lib/download';
import { cellText, formatBytes, formatRelative, slugify, truncate } from '../lib/format';
import { datasetSplits, fetchDatasetRows } from '../lib/hf';
import { datasetCard } from '../lib/hfPush';
import { uid } from '../lib/id';
import { inferColumns, parseJSONAuto, toJSONL } from '../lib/jsonl';
import { describeError } from '../providers';
import { navigate, useRoute } from '../router';
import { datasets } from '../state/collections';
import { toast, toastError } from '../state/toast';
import type { Dataset, Row } from '../state/types';

function makeDataset(name: string, source: string, columns: string[], rows: Row[], description = ''): Dataset {
  const now = Date.now();
  return { id: uid(), name, description, source, columns, rows, createdAt: now, updatedAt: now };
}

async function parseFile(file: File): Promise<{ columns: string[]; rows: Row[]; warnings: string[] }> {
  const text = await file.text();
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
    const t = parseCSV(text, lower.endsWith('.tsv') ? '\t' : undefined);
    return { ...t, warnings: [] };
  }
  const r = parseJSONAuto(text);
  return {
    columns: inferColumns(r.rows),
    rows: r.rows,
    warnings: r.errors.slice(0, 5).map((e) => `Line ${e.line}: ${e.message}`),
  };
}

// ---------------------------------------------------------------------------

export function DatasetsPage() {
  const route = useRoute();
  const { items, loaded } = useCollection(datasets);
  const [importing, setImporting] = useState(route.query.get('import') === '1');
  const id = route.segments[1];
  const active = id ? items.find((d) => d.id === id) : undefined;

  useEffect(() => {
    if (!id && loaded && items.length) navigate(`datasets/${items[0].id}`);
  }, [id, loaded, items]);

  return (
    <div className="page">
      <PageHeader
        title="Datasets"
        description="Tabular data for evaluations, fine-tuning and analysis. Stored only in this browser until you export or push it."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setImporting(true)}>
            New / import
          </Button>
        }
      />
      {loaded && !items.length ? (
        <Card>
          <EmptyState title="No datasets yet" action={<Button variant="primary" onClick={() => setImporting(true)}>Import data</Button>}>
            Import CSV, TSV, JSON or JSONL files, paste data, or pull rows from any dataset on Hugging Face.
          </EmptyState>
        </Card>
      ) : (
        <div className="split">
          <Card bodyClassName="">
            <div className="list">
              {items.map((d) => (
                <a key={d.id} href={`#/datasets/${d.id}`} className={`list-item ${d.id === id ? 'active' : ''}`} style={{ textDecoration: 'none' }}>
                  <div className="title ellipsis">{d.name}</div>
                  <div className="meta">
                    {d.rows.length.toLocaleString()} rows · {d.columns.length} cols · {formatRelative(d.updatedAt)}
                  </div>
                </a>
              ))}
            </div>
          </Card>
          {active ? <DatasetDetail key={active.id} dataset={active} /> : null}
        </div>
      )}
      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ImportDialog({ onClose }: { onClose: () => void }) {
  const route = useRoute();
  const [tab, setTab] = useState<'file' | 'hf' | 'paste' | 'empty'>(route.query.get('hf') ? 'hf' : 'file');
  const [preview, setPreview] = useState<{ name: string; source: string; columns: string[]; rows: Row[]; warnings: string[] } | null>(null);
  const [error, setError] = useState('');
  const [paste, setPaste] = useState('');
  const [emptyCols, setEmptyCols] = useState('input, expected');
  const [hfId, setHfId] = useState(route.query.get('hf') ?? '');
  const [splits, setSplits] = useState<{ config: string; split: string }[]>([]);
  const [split, setSplit] = useState('');
  const [limit, setLimit] = useState<number | undefined>(500);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!preview) return;
    const ds = makeDataset(preview.name, preview.source, preview.columns, preview.rows);
    await datasets.put(ds);
    toast(`Imported ${ds.rows.length.toLocaleString()} rows`, 'success');
    onClose();
    navigate(`datasets/${ds.id}`);
  };

  const loadSplits = async () => {
    setBusy(true);
    setError('');
    try {
      const s = await datasetSplits(hfId.trim());
      setSplits(s);
      setSplit(s[0] ? `${s[0].config}::${s[0].split}` : '');
      if (!s.length) setError('No splits found. The dataset viewer may not support this dataset.');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const loadRows = async () => {
    const [config, sp] = split.split('::');
    setBusy(true);
    setError('');
    setProgress(0);
    try {
      const max = Math.min(limit ?? 500, 20_000);
      const r = await fetchDatasetRows(hfId.trim(), config, sp, max, (loaded, total) => setProgress(total ? loaded / total : 0));
      setPreview({
        name: `${hfId.trim()} (${config}/${sp})`,
        source: `hf:${hfId.trim()}/${config}/${sp}`,
        columns: r.columns,
        rows: r.rows,
        warnings: r.total > r.rows.length ? [`Imported ${r.rows.length.toLocaleString()} of ${r.total.toLocaleString()} rows.`] : [],
      });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Modal
      title="New dataset"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {tab === 'empty' ? (
            <Button
              variant="primary"
              onClick={async () => {
                const cols = emptyCols
                  .split(',')
                  .map((c) => c.trim())
                  .filter(Boolean);
                const ds = makeDataset('New dataset', 'manual', cols, []);
                await datasets.put(ds);
                onClose();
                navigate(`datasets/${ds.id}`);
              }}
            >
              Create
            </Button>
          ) : (
            <Button variant="primary" disabled={!preview || !preview.rows.length} onClick={save}>
              Import {preview ? `${preview.rows.length.toLocaleString()} rows` : ''}
            </Button>
          )}
        </>
      }
    >
      <Tabs
        tabs={[
          { id: 'file', label: 'File' },
          { id: 'hf', label: 'Hugging Face' },
          { id: 'paste', label: 'Paste' },
          { id: 'empty', label: 'Empty' },
        ]}
        value={tab}
        onChange={(t) => {
          setTab(t);
          setPreview(null);
          setError('');
        }}
      />
      <div className="stack">
        {tab === 'file' ? (
          <FileDrop
            accept=".csv,.tsv,.txt,.json,.jsonl,.ndjson"
            onFiles={async ([file]) => {
              setError('');
              try {
                const r = await parseFile(file);
                setPreview({ name: file.name.replace(/\.[^.]+$/, ''), source: `file:${file.name}`, ...r });
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <strong>Drop a file here or click to choose</strong>
            <div className="small subtle">CSV, TSV, JSON (array or wrapped), JSONL. Parsed locally; nothing is uploaded.</div>
          </FileDrop>
        ) : null}

        {tab === 'paste' ? (
          <>
            <Textarea rows={8} className="mono" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'question,answer\nWhat is 2+2?,4'} />
            <Button
              disabled={!paste.trim()}
              onClick={() => {
                const t = paste.trim();
                if (t.startsWith('[') || t.startsWith('{')) {
                  const r = parseJSONAuto(t);
                  setPreview({ name: 'Pasted data', source: 'paste', columns: inferColumns(r.rows), rows: r.rows, warnings: r.errors.map((e) => `Line ${e.line}: ${e.message}`) });
                } else {
                  setPreview({ name: 'Pasted data', source: 'paste', ...parseCSV(t), warnings: [] });
                }
              }}
            >
              Parse
            </Button>
          </>
        ) : null}

        {tab === 'hf' ? (
          <>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div className="flex-1">
                <Field label="Dataset id" hint="e.g. openai/gsm8k, rajpurkar/squad, tatsu-lab/alpaca">
                  <Input value={hfId} onChange={(e) => setHfId(e.target.value)} placeholder="owner/dataset" />
                </Field>
              </div>
              <Button loading={busy && !splits.length} disabled={!hfId.trim().includes('/')} onClick={loadSplits}>
                Find splits
              </Button>
            </div>
            {splits.length ? (
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div className="flex-1">
                  <Field label="Config / split">
                    <Select value={split} onChange={(e) => setSplit(e.target.value)}>
                      {splits.map((s) => (
                        <option key={`${s.config}::${s.split}`} value={`${s.config}::${s.split}`}>
                          {s.config} / {s.split}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div style={{ width: 140 }}>
                  <Field label="Max rows">
                    <NumberInput value={limit} min={1} max={20000} step={100} onChange={setLimit} />
                  </Field>
                </div>
                <Button variant="primary" loading={busy} disabled={!split} onClick={loadRows}>
                  Load rows
                </Button>
              </div>
            ) : null}
            {progress != null ? <Progress value={progress} /> : null}
            <span className="small subtle">Rows come from the Hugging Face dataset viewer API (100 per request). Gated datasets need your HF token.</span>
          </>
        ) : null}

        {tab === 'empty' ? (
          <Field label="Columns" hint="Comma-separated column names">
            <Input value={emptyCols} onChange={(e) => setEmptyCols(e.target.value)} />
          </Field>
        ) : null}

        {error ? <Notice tone="err">{error}</Notice> : null}
        {preview ? (
          <div className="stack sm">
            <Field label="Name">
              <Input value={preview.name} onChange={(e) => setPreview({ ...preview, name: e.target.value })} />
            </Field>
            <div className="row small muted">
              <Badge>{preview.rows.length.toLocaleString()} rows</Badge>
              <Badge>{preview.columns.length} columns</Badge>
            </div>
            {preview.warnings.map((w, i) => (
              <Notice key={i} tone="warn">
                {w}
              </Notice>
            ))}
            <DataTable
              columns={preview.columns.slice(0, 8).map((c) => ({ key: c, label: c, render: (r: Row) => <div className="cell">{truncate(cellText(r[c]), 200)}</div> }))}
              rows={preview.rows.slice(0, 5)}
              pageSize={5}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function DatasetDetail({ dataset }: { dataset: Dataset }) {
  const [name, setName] = useState(dataset.name);
  const [description, setDescription] = useState(dataset.description);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<{ index: number | null; row: Row } | null>(null);
  const [dialog, setDialog] = useState<'finetune' | 'push' | null>(null);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const indexed = dataset.rows.map((row, index) => ({ row, index }));
    if (!q) return indexed;
    return indexed.filter(({ row }) => dataset.columns.some((c) => cellText(row[c]).toLowerCase().includes(q)));
  }, [dataset, filter]);

  const approxBytes = useMemo(() => new Blob([JSON.stringify(dataset.rows)]).size, [dataset.rows]);

  const save = (patch: Partial<Dataset>) => datasets.put({ ...dataset, ...patch, updatedAt: Date.now() });

  const columns: Column<{ row: Row; index: number }>[] = [
    { key: '#', label: '#', num: true, render: (r) => r.index + 1 },
    ...dataset.columns.map((c) => ({
      key: c,
      label: c,
      render: (r: { row: Row }) => <div className="cell">{truncate(cellText(r.row[c]), 500)}</div>,
    })),
  ];

  const base = slugify(dataset.name);

  return (
    <div className="stack">
      <Card
        title={<h2 className="ellipsis">{dataset.name}</h2>}
        actions={
          <>
            <Button size="sm" icon="beaker" onClick={() => navigate('evals', { new: '1', dataset: dataset.id })}>
              Evaluate
            </Button>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="trash"
              aria-label="Delete dataset"
              onClick={async () => {
                if (!confirm(`Delete dataset "${dataset.name}" (${dataset.rows.length} rows)?`)) return;
                await datasets.remove(dataset.id);
                navigate('datasets');
              }}
            />
          </>
        }
      >
        <div className="stack">
          <div className="grid cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== dataset.name && void save({ name: name.trim() || dataset.name })} />
            </Field>
            <Field label="Source">
              <Input value={dataset.source} readOnly />
            </Field>
          </div>
          <Field label="Description">
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} onBlur={() => description !== dataset.description && void save({ description })} />
          </Field>
          <div className="row small muted">
            <Badge>{dataset.rows.length.toLocaleString()} rows</Badge>
            <Badge>{dataset.columns.length} columns</Badge>
            <Badge>~{formatBytes(approxBytes)}</Badge>
          </div>
          <div className="row">
            <span className="small muted">Export:</span>
            <Button size="sm" icon="download" onClick={() => downloadText(toCSV(dataset.columns, dataset.rows), `${base}.csv`, 'text/csv')}>
              CSV
            </Button>
            <Button size="sm" icon="download" onClick={() => downloadText(toJSONL(dataset.rows), `${base}.jsonl`, 'application/jsonl')}>
              JSONL
            </Button>
            <Button size="sm" icon="download" onClick={() => downloadJSON(dataset.rows, `${base}.json`)}>
              JSON
            </Button>
            <Button size="sm" icon="sparkles" onClick={() => setDialog('finetune')}>
              Fine-tuning format…
            </Button>
            <Button size="sm" icon="upload" onClick={() => setDialog('push')}>
              Push to Hugging Face…
            </Button>
          </div>
        </div>
      </Card>

      <Card
        title="Rows"
        actions={
          <>
            <Input placeholder="Filter rows…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 200 }} />
            <Button size="sm" icon="plus" onClick={() => setEditing({ index: null, row: Object.fromEntries(dataset.columns.map((c) => [c, ''])) })}>
              Add row
            </Button>
          </>
        }
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.index}
          onRowClick={(r) => setEditing({ index: r.index, row: { ...r.row } })}
          empty={<EmptyState title={filter ? 'No matching rows' : 'No rows yet'} />}
          maxHeight="60vh"
        />
      </Card>

      {editing ? (
        <Modal
          title={editing.index == null ? 'Add row' : `Edit row ${editing.index + 1}`}
          onClose={() => setEditing(null)}
          wide
          footer={
            <>
              {editing.index != null ? (
                <Button
                  variant="danger"
                  icon="trash"
                  onClick={async () => {
                    await save({ rows: dataset.rows.filter((_, i) => i !== editing.index) });
                    setEditing(null);
                  }}
                >
                  Delete row
                </Button>
              ) : null}
              <div className="flex-1" />
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={async () => {
                  const rowsNext = [...dataset.rows];
                  if (editing.index == null) rowsNext.push(editing.row);
                  else rowsNext[editing.index] = editing.row;
                  await save({ rows: rowsNext });
                  setEditing(null);
                }}
              >
                Save
              </Button>
            </>
          }
        >
          <div className="stack">
            {dataset.columns.map((c) => {
              const v = editing.row[c];
              const isObject = v !== null && typeof v === 'object';
              return (
                <Field key={c} label={c} hint={isObject ? 'Structured value (JSON) — read-only here' : undefined}>
                  <Textarea
                    rows={Math.min(8, Math.max(2, cellText(v).split('\n').length))}
                    value={cellText(v)}
                    readOnly={isObject}
                    onChange={(e) => setEditing({ ...editing, row: { ...editing.row, [c]: e.target.value } })}
                  />
                </Field>
              );
            })}
          </div>
        </Modal>
      ) : null}

      {dialog === 'finetune' ? <FineTuneDialog dataset={dataset} onClose={() => setDialog(null)} /> : null}
      {dialog === 'push' ? (
        <PushToHubDialog
          type="dataset"
          defaultName={base}
          describe={`${dataset.rows.length.toLocaleString()} rows of "${dataset.name}" as data.jsonl plus a README dataset card`}
          buildFiles={async () => [
            { path: 'data.jsonl', content: new Blob([toJSONL(dataset.rows)], { type: 'application/jsonl' }) },
            {
              path: 'README.md',
              content: new Blob(
                [datasetCard({ name: dataset.name, description: dataset.description, columns: dataset.columns, rows: dataset.rows.length, source: dataset.source, dataFile: 'data.jsonl' })],
                { type: 'text/markdown' },
              ),
            },
          ]}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

type FineTuneFormat = 'chat' | 'alpaca' | 'prompt-completion';

function FineTuneDialog({ dataset, onClose }: { dataset: Dataset; onClose: () => void }) {
  const cols = dataset.columns;
  const guess = (...names: string[]) => cols.find((c) => names.includes(c.toLowerCase())) ?? '';
  const [format, setFormat] = useState<FineTuneFormat>('chat');
  const [systemText, setSystemText] = useState('');
  const [systemCol, setSystemCol] = useState(guess('system', 'system_prompt'));
  const [userCol, setUserCol] = useState(guess('input', 'prompt', 'question', 'instruction', 'user') || cols[0] || '');
  const [assistantCol, setAssistantCol] = useState(guess('output', 'answer', 'response', 'completion', 'expected', 'assistant') || cols[1] || '');
  const [contextCol, setContextCol] = useState(guess('context', 'input_context'));

  const records = useMemo(() => {
    const val = (row: Row, c: string) => (c ? cellText(row[c]) : '');
    return dataset.rows
      .map((row) => {
        if (format === 'chat') {
          const system = systemCol ? val(row, systemCol) : systemText;
          return {
            messages: [
              ...(system ? [{ role: 'system', content: system }] : []),
              { role: 'user', content: val(row, userCol) },
              { role: 'assistant', content: val(row, assistantCol) },
            ],
          };
        }
        if (format === 'alpaca') return { instruction: val(row, userCol), input: val(row, contextCol), output: val(row, assistantCol) };
        return { prompt: val(row, userCol), completion: val(row, assistantCol) };
      })
      .filter((r) => JSON.stringify(r).length > 40);
  }, [dataset.rows, format, systemCol, systemText, userCol, assistantCol, contextCol]);

  const colSelect = (value: string, onChange: (v: string) => void, allowNone = false) => (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNone ? <option value="">(none)</option> : null}
      {cols.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </Select>
  );

  return (
    <Modal
      title="Export for fine-tuning"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            icon="download"
            disabled={!records.length}
            onClick={() => downloadText(toJSONL(records), `${slugify(dataset.name)}.${format}.jsonl`, 'application/jsonl')}
          >
            Download {records.length.toLocaleString()} examples
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Format">
          <Select value={format} onChange={(e) => setFormat(e.target.value as FineTuneFormat)}>
            <option value="chat">Chat messages (OpenAI / Hugging Face TRL / most trainers)</option>
            <option value="alpaca">Alpaca (instruction / input / output)</option>
            <option value="prompt-completion">Prompt / completion</option>
          </Select>
        </Field>
        <div className="grid cols-3">
          <Field label={format === 'alpaca' ? 'Instruction column' : format === 'chat' ? 'User column' : 'Prompt column'}>{colSelect(userCol, setUserCol)}</Field>
          {format === 'alpaca' ? <Field label="Input/context column">{colSelect(contextCol, setContextCol, true)}</Field> : null}
          <Field label={format === 'prompt-completion' ? 'Completion column' : 'Assistant / output column'}>{colSelect(assistantCol, setAssistantCol)}</Field>
          {format === 'chat' ? <Field label="System column">{colSelect(systemCol, setSystemCol, true)}</Field> : null}
        </div>
        {format === 'chat' && !systemCol ? (
          <Field label="System prompt for every example (optional)">
            <Textarea rows={2} value={systemText} onChange={(e) => setSystemText(e.target.value)} />
          </Field>
        ) : null}
        <Field label="Preview (first example)">
          <pre className="plain mono small">{records[0] ? JSON.stringify(records[0], null, 2) : 'No examples'}</pre>
        </Field>
      </div>
    </Modal>
  );
}

export { makeDataset };
