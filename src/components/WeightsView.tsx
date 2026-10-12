import { useMemo, useState } from 'react';
import { formatBytes, formatCompact } from '../lib/format';
import { ggufHighlights, type GGUFInfo } from '../lib/gguf';
import type { OnnxInfo } from '../lib/onnx';
import type { TensorInfo, WeightsSummary } from '../lib/safetensors';
import { HBarList } from './Charts';
import { DataTable } from './DataTable';
import { JsonView } from './JsonView';
import { Badge, Card, Input, KeyValues, Tabs } from './ui';

type AnySummary = WeightsSummary | GGUFInfo | OnnxInfo;

function isGGUF(s: AnySummary): s is GGUFInfo {
  return s.format === 'gguf';
}
function isOnnx(s: AnySummary): s is OnnxInfo {
  return s.format === 'onnx';
}

/** Group tensor names into layers to show where parameters live. */
function layerBreakdown(tensors: TensorInfo[]): { label: string; params: number }[] {
  const groups = new Map<string, number>();
  for (const t of tensors) {
    const name = t.name.replace(/\.(\d+)\./, '.N.');
    const top = /\.N\./.test(name) ? name.split('.N.')[0] + '.N (repeated blocks)' : name.split('.').slice(0, 2).join('.');
    groups.set(top, (groups.get(top) ?? 0) + t.params);
  }
  return [...groups.entries()].map(([label, params]) => ({ label, params })).sort((a, b) => b.params - a.params);
}

export function WeightsView({ summary, fileSize, title }: { summary: AnySummary; fileSize?: number; title?: string }) {
  const [tab, setTab] = useState<'overview' | 'tensors' | 'metadata'>('overview');
  const [filter, setFilter] = useState('');
  const tensors = useMemo(
    () => (filter ? summary.tensors.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase())) : summary.tensors),
    [summary.tensors, filter],
  );
  const groups = useMemo(() => layerBreakdown(summary.tensors).slice(0, 12), [summary.tensors]);
  const bits = summary.totalParams ? (summary.totalBytes * 8) / summary.totalParams : 0;

  return (
    <Card
      title={
        <div className="row">
          <h2>{title ?? 'Inspection'}</h2>
          <Badge tone="accent">{summary.format}</Badge>
        </div>
      }
    >
      <Tabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'tensors', label: `Tensors (${summary.tensors.length.toLocaleString()})` },
          { id: 'metadata', label: 'Metadata' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'overview' ? (
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <div className="stack">
            <KeyValues
              items={[
                ['Parameters', <strong key="p">{formatCompact(summary.totalParams)} ({summary.totalParams.toLocaleString()})</strong>],
                ['Weights size', formatBytes(summary.totalBytes)],
                ['Avg bits / param', bits ? bits.toFixed(2) : '—'],
                ...(fileSize ? ([['File size', formatBytes(fileSize)]] as [string, string][]) : []),
                ['Header size', formatBytes(summary.headerBytes)],
                ...(isGGUF(summary)
                  ? (Object.entries(ggufHighlights(summary))
                      .filter(([, v]) => v !== undefined)
                      .map(([k, v]) => [k, String(v)]) as [string, string][])
                  : []),
                ...(isOnnx(summary)
                  ? ([
                      ['Producer', `${summary.producer ?? '?'} ${summary.producerVersion ?? ''}`],
                      ['IR version', String(summary.irVersion ?? '?')],
                      ['Opsets', summary.opsets.map((o) => `${o.domain} v${o.version}`).join(', ')],
                      ['Nodes', summary.nodeCount.toLocaleString()],
                      ['External data', summary.externalData ? 'yes (weights in a separate file)' : 'no'],
                    ] as [string, string][])
                  : []),
              ]}
            />
            {isOnnx(summary) ? (
              <div className="stack sm">
                <h3>Inputs</h3>
                {summary.inputs.map((i) => (
                  <code key={i.name} className="small">
                    {i.name}: {i.dtype}[{i.shape.join(', ')}]
                  </code>
                ))}
                <h3>Outputs</h3>
                {summary.outputs.map((o) => (
                  <code key={o.name} className="small">
                    {o.name}: {o.dtype}[{o.shape.join(', ')}]
                  </code>
                ))}
              </div>
            ) : null}
          </div>
          <div className="stack">
            <h3>Parameters by dtype</h3>
            <HBarList
              items={Object.entries(summary.dtypeParams)
                .sort((a, b) => b[1] - a[1])
                .map(([dtype, n]) => ({ label: dtype, value: n, display: `${formatCompact(n)} (${((n / (summary.totalParams || 1)) * 100).toFixed(1)}%)` }))}
            />
            {isOnnx(summary) ? (
              <>
                <h3>Top operators</h3>
                <HBarList
                  items={Object.entries(summary.ops)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 12)
                    .map(([op, n]) => ({ label: op, value: n, display: n.toLocaleString() }))}
                />
              </>
            ) : (
              <>
                <h3>Where the parameters are</h3>
                <HBarList items={groups.map((g) => ({ label: g.label, value: g.params, display: formatCompact(g.params) }))} />
              </>
            )}
          </div>
        </div>
      ) : null}
      {tab === 'tensors' ? (
        <div className="stack">
          <Input placeholder="Filter by name (e.g. attn, layers.0., embed)…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <DataTable<TensorInfo>
            columns={[
              { key: 'name', label: 'Name', render: (t) => <code>{t.name}</code> },
              { key: 'dtype', label: 'dtype' },
              { key: 'shape', label: 'Shape', render: (t) => `[${t.shape.join(', ')}]` },
              { key: 'params', label: 'Params', num: true, render: (t) => t.params.toLocaleString() },
              { key: 'bytes', label: 'Size', num: true, render: (t) => formatBytes(t.bytes) },
            ]}
            rows={tensors}
            rowKey={(t) => t.name}
            pageSize={100}
            maxHeight="60vh"
          />
        </div>
      ) : null}
      {tab === 'metadata' ? <JsonView value={summary.metadata} filename="metadata.json" /> : null}
    </Card>
  );
}
