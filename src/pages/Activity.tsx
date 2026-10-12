import { useMemo, useState } from 'react';
import { DataTable } from '../components/DataTable';
import { Badge, Button, Card, Checkbox, EmptyState, Input, Notice, PageHeader, Select, Tabs } from '../components/ui';
import { useCollection } from '../lib/collection';
import { toCSV } from '../lib/csv';
import { downloadText, timestampSlug } from '../lib/download';
import { formatBytes, formatCompact, formatDateTime, formatMs, formatUSD } from '../lib/format';
import { allowHost, useSettings } from '../state/settings';
import { clearNetLog, hostMatches, useNetLog, type NetLogEntry } from '../lib/net';
import { usage } from '../state/collections';
import type { UsageRecord } from '../state/types';
import { useRoute } from '../router';

export function ActivityPage() {
  const route = useRoute();
  const [tab, setTab] = useState<'network' | 'usage'>(route.query.get('tab') === 'usage' ? 'usage' : 'network');
  return (
    <div className="page">
      <PageHeader
        title="Activity"
        description="An audit trail of every request this app makes and every model call you've paid for. Metadata only: no prompts, keys or response bodies are logged."
      />
      <Tabs
        tabs={[
          { id: 'network', label: 'Network log (this session)' },
          { id: 'usage', label: 'Usage ledger' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'network' ? <NetworkLog /> : <UsageLedger />}
    </div>
  );
}

function NetworkLog() {
  const log = useNetLog();
  const settings = useSettings();
  const [initiator, setInitiator] = useState('');
  const [host, setHost] = useState('');
  const [blockedOnly, setBlockedOnly] = useState(false);
  const initiators = useMemo(() => [...new Set(log.map((e) => e.initiator))].sort(), [log]);
  const rows = useMemo(
    () =>
      [...log]
        .reverse()
        .filter((e) => (!initiator || e.initiator === initiator) && (!host || e.host.includes(host)) && (!blockedOnly || e.blocked)),
    [log, initiator, host, blockedOnly],
  );
  const hosts = useMemo(() => {
    const m = new Map<string, { count: number; bytes: number; blocked: number }>();
    for (const e of log) {
      const h = m.get(e.host) ?? { count: 0, bytes: 0, blocked: 0 };
      h.count++;
      h.bytes += e.bytes ?? 0;
      if (e.blocked) h.blocked++;
      m.set(e.host, h);
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [log]);

  return (
    <div className="stack lg">
      <Card title="Hosts contacted this session" bodyClassName="">
        {hosts.length ? (
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Host</th>
                  <th className="num">Requests</th>
                  <th className="num">Data received</th>
                  <th>Policy</th>
                </tr>
              </thead>
              <tbody>
                {hosts.map(([h, s]) => {
                  const hostname = h.replace(/:\d+$/, '');
                  const listed = settings.net.allowlist.some((p) => hostMatches(hostname, p));
                  return (
                    <tr key={h}>
                      <td>
                        <code>{h}</code>
                      </td>
                      <td className="num">{s.count}</td>
                      <td className="num">{formatBytes(s.bytes)}</td>
                      <td>
                        {s.blocked ? (
                          <div className="row">
                            <Badge tone="err">{s.blocked} blocked</Badge>
                            {!listed ? (
                              <Button size="sm" onClick={() => allowHost(hostname)}>
                                Allow
                              </Button>
                            ) : null}
                          </div>
                        ) : listed ? (
                          <Badge tone="ok">allowlisted</Badge>
                        ) : (
                          <Badge>local / same-origin / open mode</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No requests yet">Requests appear here as soon as the app talks to any server, including model downloads.</EmptyState>
        )}
      </Card>

      <Card
        title="Requests"
        actions={
          <>
            <Select value={initiator} onChange={(e) => setInitiator(e.target.value)} style={{ width: 170 }}>
              <option value="">All initiators</option>
              {initiators.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </Select>
            <Input placeholder="Host contains…" value={host} onChange={(e) => setHost(e.target.value)} style={{ width: 160 }} />
            <Checkbox checked={blockedOnly} onChange={setBlockedOnly} label="Blocked only" />
            <Button
              size="sm"
              icon="download"
              disabled={!log.length}
              onClick={() =>
                downloadText(
                  toCSV(['ts', 'initiator', 'method', 'url', 'status', 'durationMs', 'bytes', 'blocked', 'error'], log.map((e) => ({ ...e, ts: new Date(e.ts).toISOString() }))),
                  `network-log-${timestampSlug()}.csv`,
                  'text/csv',
                )
              }
            >
              CSV
            </Button>
            <Button size="sm" variant="ghost" icon="trash" disabled={!log.length} onClick={clearNetLog}>
              Clear
            </Button>
          </>
        }
      >
        <DataTable<NetLogEntry>
          columns={[
            { key: 'ts', label: 'Time', render: (e) => new Date(e.ts).toLocaleTimeString() },
            { key: 'initiator', label: 'Initiator', render: (e) => <code>{e.initiator}</code> },
            { key: 'method', label: 'Method' },
            { key: 'url', label: 'URL', render: (e) => <div className="cell mono small">{e.url}</div> },
            {
              key: 'status',
              label: 'Status',
              render: (e) =>
                e.blocked ? (
                  <Badge tone="err" title={e.error}>
                    blocked
                  </Badge>
                ) : e.error ? (
                  <Badge tone="err" title={e.error}>
                    error
                  </Badge>
                ) : e.status == null ? (
                  <span className="spinner" />
                ) : (
                  <Badge tone={e.status < 400 ? 'ok' : 'warn'}>{e.status}</Badge>
                ),
            },
            { key: 'duration', label: 'Time', num: true, render: (e) => formatMs(e.durationMs) },
            { key: 'bytes', label: 'Size', num: true, render: (e) => (e.bytes ? formatBytes(e.bytes) : '—') },
          ]}
          rows={rows}
          rowKey={(e) => e.id}
          pageSize={100}
          empty={<span className="muted small">No matching requests.</span>}
        />
      </Card>
    </div>
  );
}

function UsageLedger() {
  const { items } = useCollection(usage);
  const [source, setSource] = useState('');
  const rows = source ? items.filter((r) => r.source === source) : items;
  const byProvider = useMemo(() => {
    const m = new Map<string, { n: number; tokens: number; cost: number; errors: number }>();
    for (const r of rows) {
      const p = m.get(r.providerId) ?? { n: 0, tokens: 0, cost: 0, errors: 0 };
      p.n++;
      p.tokens += r.inputTokens + r.outputTokens;
      p.cost += r.costUsd;
      if (!r.ok) p.errors++;
      m.set(r.providerId, p);
    }
    return [...m.entries()].sort((a, b) => b[1].cost - a[1].cost);
  }, [rows]);

  return (
    <div className="stack lg">
      <Notice>
        The ledger records one row per model call (tokens, cost, latency, success). Costs use the prices in Settings → Pricing and are estimates; your
        provider's invoice is authoritative. Disable recording in Settings → General.
      </Notice>
      <Card title="By provider" bodyClassName="">
        <div className="table-wrap" style={{ border: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Provider</th>
                <th className="num">Requests</th>
                <th className="num">Errors</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {byProvider.map(([p, s]) => (
                <tr key={p}>
                  <td>{p}</td>
                  <td className="num">{s.n.toLocaleString()}</td>
                  <td className="num">{s.errors || '—'}</td>
                  <td className="num">{formatCompact(s.tokens)}</td>
                  <td className="num">{formatUSD(s.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card
        title={`Calls (${rows.length.toLocaleString()})`}
        actions={
          <>
            <Select value={source} onChange={(e) => setSource(e.target.value)} style={{ width: 150 }}>
              <option value="">All sources</option>
              <option value="chat">chat</option>
              <option value="compare">compare</option>
              <option value="eval">eval</option>
              <option value="judge">judge</option>
              <option value="other">other</option>
            </Select>
            <Button
              size="sm"
              icon="download"
              disabled={!rows.length}
              onClick={() =>
                downloadText(
                  toCSV(
                    ['ts', 'source', 'providerId', 'model', 'inputTokens', 'outputTokens', 'estimated', 'costUsd', 'latencyMs', 'ok'],
                    rows.map((r) => ({ ...r, ts: new Date(r.ts).toISOString() })),
                  ),
                  `usage-${timestampSlug()}.csv`,
                  'text/csv',
                )
              }
            >
              CSV
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              disabled={!items.length}
              onClick={async () => {
                if (!confirm('Delete the entire usage ledger? Dashboard spend figures will reset.')) return;
                await usage.clear();
              }}
            >
              Clear
            </Button>
          </>
        }
      >
        <DataTable<UsageRecord>
          columns={[
            { key: 'ts', label: 'Time', render: (r) => formatDateTime(r.ts) },
            { key: 'source', label: 'Source', render: (r) => <Badge>{r.source}</Badge> },
            { key: 'model', label: 'Model', render: (r) => <code>{r.model}</code> },
            { key: 'tokens', label: 'In → out', num: true, render: (r) => `${formatCompact(r.inputTokens)} → ${formatCompact(r.outputTokens)}${r.estimated ? '*' : ''}` },
            { key: 'cost', label: 'Cost', num: true, render: (r) => formatUSD(r.costUsd) },
            { key: 'latency', label: 'Latency', num: true, render: (r) => formatMs(r.latencyMs) },
            { key: 'ok', label: 'OK', render: (r) => (r.ok ? <Badge tone="ok">ok</Badge> : <Badge tone="err">failed</Badge>) },
          ]}
          rows={rows}
          rowKey={(r) => r.id}
          pageSize={100}
          empty={<EmptyState title="No usage recorded yet" />}
        />
      </Card>
    </div>
  );
}
