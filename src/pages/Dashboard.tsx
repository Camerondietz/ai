import { useEffect, useMemo, useState } from 'react';
import { BarChart, HBarList } from '../components/Charts';
import { Badge, Button, Card, EmptyState, KeyValues, PageHeader, Stat } from '../components/ui';
import { useCollection } from '../lib/collection';
import { dayKey, formatBytes, formatCompact, formatMs, formatPercent, formatRelative, formatUSD } from '../lib/format';
import { href, navigate } from '../router';
import { conversations, evals, usage } from '../state/collections';
import { useSettings } from '../state/settings';
import { monthStart, spendSince } from '../state/usage';
import { hasSecret, useVault } from '../state/vault';

function useStorageInfo() {
  const [info, setInfo] = useState<{ usage?: number; quota?: number; persisted?: boolean }>({});
  useEffect(() => {
    void (async () => {
      const est = await navigator.storage?.estimate?.();
      const persisted = await navigator.storage?.persisted?.();
      setInfo({ usage: est?.usage, quota: est?.quota, persisted });
    })();
  }, []);
  return info;
}

export function DashboardPage() {
  const settings = useSettings();
  const vault = useVault();
  const { items: records } = useCollection(usage);
  const { items: convs } = useCollection(conversations);
  const { items: runs } = useCollection(evals);
  const storage = useStorageInfo();

  const stats = useMemo(() => {
    const now = Date.now();
    const today = dayKey(now);
    const weekAgo = now - 7 * 86_400_000;
    let reqToday = 0;
    let tokToday = 0;
    let week = 0;
    let weekErr = 0;
    let weekLatency = 0;
    for (const r of records) {
      if (dayKey(r.ts) === today) {
        reqToday++;
        tokToday += r.inputTokens + r.outputTokens;
      }
      if (r.ts >= weekAgo) {
        week++;
        if (!r.ok) weekErr++;
        weekLatency += r.latencyMs;
      }
    }
    const days: { label: string; value: number }[] = [];
    const byDay = new Map<string, number>();
    for (const r of records) byDay.set(dayKey(r.ts), (byDay.get(dayKey(r.ts)) ?? 0) + r.costUsd);
    for (let i = 29; i >= 0; i--) {
      const key = dayKey(now - i * 86_400_000);
      days.push({ label: key.slice(5), value: byDay.get(key) ?? 0 });
    }
    const start = monthStart();
    const byModel = new Map<string, { cost: number; tokens: number; count: number }>();
    for (const r of records) {
      if (r.ts < start) continue;
      const m = byModel.get(r.model) ?? { cost: 0, tokens: 0, count: 0 };
      m.cost += r.costUsd;
      m.tokens += r.inputTokens + r.outputTokens;
      m.count++;
      byModel.set(r.model, m);
    }
    const topModels = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].count - a[1].count).slice(0, 8);
    return {
      reqToday,
      tokToday,
      monthSpend: spendSince(records, start),
      avgLatency: week ? weekLatency / week : undefined,
      errorRate: week ? weekErr / week : undefined,
      days,
      topModels,
    };
  }, [records]);

  const keyedProviders = settings.providers.filter((p) => p.enabled && (!p.secretRef || hasSecret(p.secretRef)));
  const budget = settings.budget.monthlyUsd;

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        description="Usage, spend and security posture for this workspace. Everything shown here is computed locally."
        actions={
          <>
            <Button icon="plus" variant="primary" onClick={() => navigate('chat', { new: '1' })}>
              New chat
            </Button>
            <Button icon="beaker" onClick={() => navigate('evals', { new: '1' })}>
              New evaluation
            </Button>
          </>
        }
      />

      <div className="stack lg">
        <div className="grid cols-4">
          <Stat label="Requests today" value={formatCompact(stats.reqToday)} sub={`${formatCompact(stats.tokToday)} tokens`} />
          <Stat
            label="Spend this month"
            value={formatUSD(stats.monthSpend)}
            sub={budget > 0 ? `${formatPercent(stats.monthSpend / budget)} of ${formatUSD(budget)} budget${settings.budget.hardStop ? ' (hard stop)' : ''}` : 'No budget set'}
          />
          <Stat label="Avg latency (7d)" value={formatMs(stats.avgLatency)} sub="end-to-end, including streaming" />
          <Stat label="Error rate (7d)" value={formatPercent(stats.errorRate, 1)} sub="failed requests / all requests" />
        </div>

        <div className="grid cols-3" style={{ alignItems: 'start' }}>
          <Card title="Spend per day (30 days)" className="" bodyClassName="card-body">
            {records.length ? (
              <BarChart data={stats.days} format={(v) => (v >= 1 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`)} />
            ) : (
              <EmptyState title="No usage yet">Requests you make from Chat, Compare and Evaluations are recorded here.</EmptyState>
            )}
          </Card>
          <Card title="Top models this month">
            {stats.topModels.length ? (
              <HBarList
                items={stats.topModels.map(([model, m]) => ({
                  label: model,
                  value: m.cost || m.count,
                  display: m.cost ? formatUSD(m.cost) : `${m.count} req`,
                }))}
              />
            ) : (
              <p className="muted small">No requests this month.</p>
            )}
          </Card>
          <Card
            title="Security posture"
            actions={
              <a className="small" href={href('settings', { tab: 'security' })}>
                Manage
              </a>
            }
          >
            <KeyValues
              items={[
                [
                  'API keys',
                  vault.status === 'unlocked' ? (
                    <Badge tone="ok">Encrypted vault · unlocked</Badge>
                  ) : vault.status === 'locked' ? (
                    <Badge tone="warn">Encrypted vault · locked</Badge>
                  ) : vault.status === 'session' ? (
                    <Badge tone="warn">Memory only (lost on reload)</Badge>
                  ) : (
                    <Badge>None stored</Badge>
                  ),
                ],
                [
                  'Network',
                  settings.net.mode === 'open' ? (
                    <Badge tone="warn">Open (HTTPS anywhere)</Badge>
                  ) : settings.net.mode === 'local-only' ? (
                    <Badge tone="ok">Local only</Badge>
                  ) : (
                    <Badge tone="ok">Allowlist · {settings.net.allowlist.length} hosts</Badge>
                  ),
                ],
                ['Auto-lock', settings.autoLockMinutes ? `${settings.autoLockMinutes} min idle` : <Badge tone="warn">Off</Badge>],
                ['Storage', storage.usage != null ? `${formatBytes(storage.usage)} used${storage.persisted ? ' · persistent' : ''}` : '—'],
                ['Telemetry', <Badge tone="ok">None</Badge>],
              ]}
            />
          </Card>
        </div>

        {keyedProviders.filter((p) => p.kind !== 'local').length === 0 ? (
          <Card title="Get started">
            <ol className="stack sm" style={{ margin: 0, paddingLeft: 18 }}>
              <li>
                Add an API key in <a href={href('settings', { tab: 'providers' })}>Settings → Providers</a> (Anthropic, OpenAI, Hugging Face, Gemini, Groq, OpenRouter…), or use a
                local server like Ollama.
              </li>
              <li>
                Or run a model fully on-device with no key at all: <a href={href('chat', { new: '1', provider: 'browser' })}>chat with an in-browser model</a> or explore{' '}
                <a href={href('lab')}>Local Lab</a>.
              </li>
              <li>
                Create an encrypted vault so keys survive reloads (top-right lock button), and review the <a href={href('settings', { tab: 'security' })}>network allowlist</a>.
              </li>
              <li>
                Import a dataset or pull one from Hugging Face, then run an <a href={href('evals', { new: '1' })}>evaluation</a> across models.
              </li>
            </ol>
          </Card>
        ) : null}

        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <Card
            title="Recent conversations"
            actions={
              <a className="small" href={href('chat')}>
                All chats
              </a>
            }
            bodyClassName=""
          >
            {convs.length ? (
              <div className="list">
                {convs.slice(0, 6).map((c) => (
                  <a key={c.id} className="list-item" href={href(`chat/${c.id}`)} style={{ textDecoration: 'none' }}>
                    <div className="title ellipsis">{c.title}</div>
                    <div className="meta">
                      {c.model} · {c.messages.length} messages · {formatRelative(c.updatedAt)}
                    </div>
                  </a>
                ))}
              </div>
            ) : (
              <EmptyState title="No conversations yet" action={<Button onClick={() => navigate('chat', { new: '1' })}>Start a chat</Button>} />
            )}
          </Card>
          <Card
            title="Recent evaluations"
            actions={
              <a className="small" href={href('evals')}>
                All evaluations
              </a>
            }
            bodyClassName=""
          >
            {runs.length ? (
              <div className="list">
                {runs.slice(0, 6).map((r) => (
                  <a key={r.id} className="list-item" href={href(`evals/${r.id}`)} style={{ textDecoration: 'none' }}>
                    <div className="row between">
                      <span className="title ellipsis">{r.name}</span>
                      <Badge tone={r.status === 'done' ? 'ok' : r.status === 'running' ? 'accent' : 'warn'}>{r.status}</Badge>
                    </div>
                    <div className="meta">
                      {r.config.models.length} models · {r.inputs.length} rows · {formatRelative(r.createdAt)}
                    </div>
                  </a>
                ))}
              </div>
            ) : (
              <EmptyState title="No evaluations yet" action={<Button onClick={() => navigate('evals', { new: '1' })}>Create one</Button>} />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
