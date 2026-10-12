import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { ModelPicker } from '../components/ModelPicker';
import { Badge, Button, Card, Checkbox, Field, Input, KeyValues, Notice, NumberInput, PageHeader, Select, Tabs, Textarea } from '../components/ui';
import { CreateVaultDialog, strengthLabel, UnlockDialog } from '../components/VaultDialogs';
import { passphraseBits } from '../lib/crypto';
import { downloadJSON, pickFiles, timestampSlug } from '../lib/download';
import { formatBytes } from '../lib/format';
import { whoAmI, type WhoAmI } from '../lib/hf';
import { describeError, listModels } from '../providers';
import { DEFAULT_PRICING, HF_TOKEN_SECRET, PROVIDER_PRESETS, presetFor } from '../providers/presets';
import { navigate, useRoute } from '../router';
import { ALL_COLLECTIONS, type CollectionKey } from '../state/collections';
import {
  addProviderFromPreset,
  allowHost,
  providerHost,
  removeProvider,
  updateSettings,
  upsertProvider,
  useSettings,
  HF_HOSTS,
  type Theme,
} from '../state/settings';
import { toast, toastError } from '../state/toast';
import type { PriceEntry, ProviderConfig } from '../state/types';
import { changePassphrase, destroyVault, getSecret, hasSecret, lockVault, MIN_PASSPHRASE_LENGTH, removeSecret, setSecret, useVault } from '../state/vault';
import { buildWorkspaceExport, importWorkspace, isEncryptedWorkspace, parseWorkspaceFile, wipeAllData, type WorkspaceFile } from '../state/workspace';

type Tab = 'providers' | 'huggingface' | 'security' | 'pricing' | 'data' | 'general';

export function SettingsPage() {
  const route = useRoute();
  const [tab, setTab] = useState<Tab>((route.query.get('tab') as Tab | null) ?? 'providers');
  useEffect(() => {
    const t = route.query.get('tab') as Tab | null;
    if (t) setTab(t);
  }, [route.query]);

  return (
    <div className="page">
      <PageHeader title="Settings" description="Everything here is stored in this browser only." />
      <Tabs
        tabs={[
          { id: 'providers', label: 'Providers & keys' },
          { id: 'huggingface', label: 'Hugging Face' },
          { id: 'security', label: 'Security' },
          { id: 'pricing', label: 'Pricing & budget' },
          { id: 'data', label: 'Data & backup' },
          { id: 'general', label: 'General' },
        ]}
        value={tab}
        onChange={(t) => navigate('settings', { tab: t })}
      />
      {tab === 'providers' ? <ProvidersTab /> : null}
      {tab === 'huggingface' ? <HuggingFaceTab /> : null}
      {tab === 'security' ? <SecurityTab /> : null}
      {tab === 'pricing' ? <PricingTab /> : null}
      {tab === 'data' ? <DataTab /> : null}
      {tab === 'general' ? <GeneralTab /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keys

function KeyNotice() {
  const vault = useVault();
  if (vault.status === 'locked') {
    return <Notice tone="warn">The vault is locked. Unlock it (lock button, top right) to view or change saved keys.</Notice>;
  }
  if (vault.status === 'unlocked') {
    return <Notice tone="ok">Keys are encrypted at rest in your vault (AES-256-GCM) and only decrypted in memory while unlocked.</Notice>;
  }
  return (
    <Notice tone="warn">
      Keys you enter are kept <strong>in memory only</strong> and disappear when you reload. Create an encrypted vault (Security tab) to keep them across
      sessions.
    </Notice>
  );
}

function SecretInput({ secretId, placeholder }: { secretId: string; placeholder?: string }) {
  const vault = useVault();
  const [value, setValue] = useState('');
  const present = hasSecret(secretId);
  const locked = vault.status === 'locked';
  const existing = getSecret(secretId);
  return (
    <div className="row nowrap">
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        disabled={locked}
        placeholder={present && existing ? `•••• ${existing.slice(-4)} (saved)` : (placeholder ?? 'Paste API key')}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        disabled={locked || !value.trim()}
        onClick={async () => {
          try {
            await setSecret(secretId, value);
            setValue('');
            toast('Key saved', 'success');
          } catch (err) {
            toastError(err);
          }
        }}
      >
        Save
      </Button>
      {present ? (
        <Button
          variant="ghost"
          iconOnly
          icon="trash"
          aria-label="Remove key"
          disabled={locked}
          onClick={async () => {
            await removeSecret(secretId);
            toast('Key removed', 'info');
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Providers

function ProvidersTab() {
  const settings = useSettings();
  useVault();
  const [editing, setEditing] = useState<ProviderConfig | null>(null);
  const [preset, setPreset] = useState('');

  const add = () => {
    if (!preset) return;
    const p = addProviderFromPreset(preset);
    const host = providerHost(p);
    if (host && settings.net.mode === 'allowlist' && !settings.net.allowlist.includes(host)) {
      allowHost(host);
      toast(`Added ${host} to the network allowlist.`, 'info');
    }
    setPreset('');
    setEditing(p);
  };

  return (
    <div className="stack lg">
      <KeyNotice />
      <Card title="Default model for new chats">
        <div style={{ maxWidth: 420 }}>
          <ModelPicker value={settings.defaultModel} onChange={(ref) => updateSettings({ defaultModel: ref })} />
        </div>
      </Card>
      <div className="grid auto">
        {settings.providers.map((p) => {
          const keyOk = !p.secretRef || hasSecret(p.secretRef);
          return (
            <Card
              key={p.id}
              title={<h3 className="ellipsis">{p.name}</h3>}
              actions={
                <Button size="sm" icon="edit" onClick={() => setEditing(p)}>
                  Configure
                </Button>
              }
            >
              <div className="stack sm">
                <div className="row">
                  <Badge tone={p.enabled ? 'ok' : undefined}>{p.enabled ? 'enabled' : 'disabled'}</Badge>
                  <Badge>{p.kind === 'openai' ? 'OpenAI-compatible' : p.kind === 'anthropic' ? 'Anthropic SDK' : 'in-browser'}</Badge>
                  {p.secretRef ? <Badge tone={keyOk ? 'ok' : 'warn'}>{keyOk ? 'key set' : 'no key'}</Badge> : <Badge>no key needed</Badge>}
                </div>
                <span className="small subtle ellipsis">{p.baseUrl || 'runs on this device'}</span>
                <span className="small muted">
                  {p.models.length} model{p.models.length === 1 ? '' : 's'}
                  {p.defaultModel ? ` · default ${p.defaultModel}` : ''}
                </span>
              </div>
            </Card>
          );
        })}
      </div>
      <Card title="Add a provider">
        <div className="row">
          <Select value={preset} onChange={(e) => setPreset(e.target.value)} style={{ maxWidth: 360 }}>
            <option value="">Choose…</option>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.preset} value={p.preset}>
                {p.name}
              </option>
            ))}
          </Select>
          <Button variant="primary" icon="plus" disabled={!preset} onClick={add}>
            Add
          </Button>
        </div>
      </Card>
      {editing ? <ProviderEditor provider={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function ProviderEditor({ provider, onClose }: { provider: ProviderConfig; onClose: () => void }) {
  const settings = useSettings();
  const [p, setP] = useState<ProviderConfig>(provider);
  const [modelsText, setModelsText] = useState(provider.models.join('\n'));
  const [headersText, setHeadersText] = useState(provider.headers ? JSON.stringify(provider.headers, null, 2) : '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const preset = p.preset ? presetFor(p.preset) : undefined;
  const host = providerHost(p);
  const blocked = host && settings.net.mode !== 'open' && !settings.net.allowlist.some((x) => x === host || (x.startsWith('*.') && host.endsWith(x.slice(1))));

  const models = () =>
    modelsText
      .split('\n')
      .map((m) => m.trim())
      .filter(Boolean);

  const save = () => {
    let headers: Record<string, string> | undefined;
    if (headersText.trim()) {
      try {
        headers = JSON.parse(headersText) as Record<string, string>;
      } catch {
        toast('Extra headers must be a JSON object', 'error');
        return;
      }
      if (Object.keys(headers).some((h) => /authorization|api-key|x-api-key|cookie/i.test(h))) {
        toast('Put credentials in the API key field (encrypted), not in extra headers.', 'error');
        return;
      }
    }
    const list = models();
    upsertProvider({ ...p, models: list, defaultModel: p.defaultModel && list.includes(p.defaultModel) ? p.defaultModel : list[0], headers });
    toast('Provider saved', 'success');
    onClose();
  };

  const fetchModels = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const fetched = await listModels({ ...p, models: models() });
      const merged = [...new Set([...models(), ...fetched])];
      setModelsText(merged.join('\n'));
      setStatus({ tone: 'ok', text: `Connected. ${fetched.length} models available.` });
    } catch (err) {
      setStatus({ tone: 'err', text: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Configure ${provider.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button
            variant="danger"
            icon="trash"
            onClick={() => {
              if (!confirm(`Remove provider "${provider.name}"?`)) return;
              removeProvider(provider.id);
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
        {preset?.note ? <Notice>{preset.note}</Notice> : null}
        <div className="grid cols-2">
          <Field label="Name">
            <Input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
          </Field>
          {p.kind !== 'local' ? (
            <Field label="Base URL" hint={p.kind === 'openai' ? 'Up to and including /v1' : 'https://api.anthropic.com'}>
              <Input value={p.baseUrl} onChange={(e) => setP({ ...p, baseUrl: e.target.value.trim() })} />
            </Field>
          ) : null}
        </div>
        {blocked ? (
          <Notice tone="warn">
            {host} is not in your network allowlist, so requests will be blocked.{' '}
            <Button size="sm" onClick={() => allowHost(host!)}>
              Allow {host}
            </Button>
          </Notice>
        ) : null}
        <Checkbox checked={p.enabled} onChange={(v) => setP({ ...p, enabled: v })} label="Enabled" />
        {p.secretRef ? (
          <Field
            label={p.secretRef === HF_TOKEN_SECRET ? 'Hugging Face token (shared)' : 'API key'}
            hint={
              preset?.keyUrl ? (
                <>
                  Create one at{' '}
                  <a href={preset.keyUrl} target="_blank" rel="noopener noreferrer">
                    {preset.keyUrl}
                  </a>
                  . Use a restricted, per-project key with a spending limit where your provider supports it.
                </>
              ) : undefined
            }
          >
            <SecretInput secretId={p.secretRef} />
          </Field>
        ) : p.kind === 'openai' ? (
          <Checkbox
            checked={false}
            onChange={(v) => v && setP({ ...p, secretRef: `provider:${p.id}` })}
            label="This server requires an API key"
          />
        ) : null}
        <Field label="Models (one per line)" hint={p.kind === 'local' ? 'Any Transformers.js-compatible text-generation repo on Hugging Face' : undefined}>
          <Textarea rows={6} className="mono" value={modelsText} onChange={(e) => setModelsText(e.target.value)} />
        </Field>
        <div className="row">
          {p.kind !== 'local' ? (
            <Button icon="refresh" loading={busy} onClick={fetchModels}>
              Test connection & fetch models
            </Button>
          ) : null}
          <Field label="Default model">
            <Select value={p.defaultModel ?? ''} onChange={(e) => setP({ ...p, defaultModel: e.target.value || undefined })}>
              <option value="">(first in list)</option>
              {models().map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
        {p.kind === 'openai' ? (
          <details>
            <summary>Advanced</summary>
            <div className="stack" style={{ marginTop: 10 }}>
              <Checkbox
                checked={p.options.streamUsage !== false}
                onChange={(v) => setP({ ...p, options: { ...p.options, streamUsage: v } })}
                label="Request token usage in the stream (stream_options.include_usage)"
              />
              <Field label="Max tokens parameter">
                <Select
                  value={p.options.maxTokensField ?? 'max_tokens'}
                  onChange={(e) => setP({ ...p, options: { ...p.options, maxTokensField: e.target.value as 'max_tokens' | 'max_completion_tokens' } })}
                >
                  <option value="max_tokens">max_tokens</option>
                  <option value="max_completion_tokens">max_completion_tokens (OpenAI reasoning models)</option>
                </Select>
              </Field>
              <Field label="Extra headers (JSON, non-secret)" hint='e.g. {"X-Title": "my-app"}. Never put keys here.'>
                <Textarea rows={3} className="mono" value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
              </Field>
            </div>
          </details>
        ) : null}
        {p.kind === 'anthropic' ? (
          <Checkbox
            checked={!!p.options.refusalFallback}
            onChange={(v) => setP({ ...p, options: { ...p.options, refusalFallback: v } })}
            label="Server-side refusal fallback (Claude API, supported models): if a request is declined by a safety classifier, it is retried on a fallback model in the same call"
          />
        ) : null}
        {p.preset === 'ollama' ? (
          <Notice>
            Allow this site to call Ollama by starting it with <code>OLLAMA_ORIGINS={location.origin}</code> (e.g. <code>OLLAMA_ORIGINS={location.origin} ollama serve</code>).
            Your browser may also ask to allow access to devices on your local network.
          </Notice>
        ) : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Hugging Face

function HuggingFaceTab() {
  const settings = useSettings();
  useVault();
  const [me, setMe] = useState<WhoAmI | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack lg">
      <KeyNotice />
      <Card title="Access token">
        <div className="stack">
          <SecretInput secretId={HF_TOKEN_SECRET} placeholder="hf_…" />
          <p className="small muted" style={{ margin: 0 }}>
            Optional. Needed for gated/private repos, pushing datasets and model cards, and Inference Providers. Create a <strong>fine-grained</strong> token at{' '}
            <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener noreferrer">
              huggingface.co/settings/tokens
            </a>{' '}
            with only the permissions you need (read, write to specific repos, “Make calls to Inference Providers”). It is sent only to the Hugging Face hosts
            configured below.
          </p>
          <div className="row">
            <Button
              icon="key"
              loading={busy}
              disabled={!hasSecret(HF_TOKEN_SECRET)}
              onClick={async () => {
                setBusy(true);
                try {
                  setMe(await whoAmI());
                } catch (err) {
                  toast(describeError(err), 'error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Check token
            </Button>
            {me ? (
              <Badge tone="ok">
                {me.name}
                {me.auth?.accessToken?.role ? ` · ${me.auth.accessToken.role}` : ''}
                {me.orgs?.length ? ` · orgs: ${me.orgs.map((o) => o.name).join(', ')}` : ''}
              </Badge>
            ) : null}
          </div>
        </div>
      </Card>
      <Card title="Endpoints">
        <div className="grid cols-2">
          <Field label="Hub endpoint" hint="Change only for a mirror or private Hub deployment.">
            <Input value={settings.hf.endpoint} onChange={(e) => updateSettings((s) => ({ ...s, hf: { ...s.hf, endpoint: e.target.value.trim() } }))} />
          </Field>
          <Field label="Dataset viewer API">
            <Input value={settings.hf.datasetsServer} onChange={(e) => updateSettings((s) => ({ ...s, hf: { ...s.hf, datasetsServer: e.target.value.trim() } }))} />
          </Field>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Security

function SecurityTab() {
  const settings = useSettings();
  const vault = useVault();
  const [dialog, setDialog] = useState<'create' | 'unlock' | 'change' | null>(null);
  const [allowText, setAllowText] = useState(settings.net.allowlist.join('\n'));

  useEffect(() => setAllowText(settings.net.allowlist.join('\n')), [settings.net.allowlist]);

  const saveAllowlist = () => {
    const list = [...new Set(allowText.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean))];
    const bad = list.filter((h) => !/^(\*\.)?[a-z0-9.-]+$/.test(h) || h === '*');
    if (bad.length) {
      toast(`Invalid host pattern(s): ${bad.join(', ')}. Use host names like api.example.com or *.example.com.`, 'error');
      return;
    }
    updateSettings((s) => ({ ...s, net: { ...s.net, allowlist: list } }));
    toast('Allowlist saved', 'success');
  };

  const providerHosts = settings.providers.filter((p) => p.enabled).map(providerHost).filter((h): h is string => !!h);

  return (
    <div className="stack lg">
      <Card title="Key vault">
        <div className="stack">
          <KeyValues
            items={[
              [
                'Status',
                <Badge key="s" tone={vault.status === 'unlocked' ? 'ok' : vault.status === 'none' ? undefined : 'warn'}>
                  {vault.status === 'none' ? 'no vault' : vault.status === 'session' ? 'session only (not persisted)' : vault.status}
                </Badge>,
              ],
              ['Stored secrets', vault.status === 'locked' ? 'hidden while locked' : vault.ids.length ? vault.ids.join(', ') : 'none'],
              ['Encryption', 'AES-256-GCM · key from PBKDF2-SHA256 (600,000 iterations) · non-extractable WebCrypto key'],
            ]}
          />
          <div className="row">
            {vault.status === 'none' || vault.status === 'session' ? (
              <Button variant="primary" icon="lock" onClick={() => setDialog('create')}>
                Create encrypted vault
              </Button>
            ) : null}
            {vault.status === 'locked' ? (
              <Button variant="primary" icon="unlock" onClick={() => setDialog('unlock')}>
                Unlock
              </Button>
            ) : null}
            {vault.status === 'unlocked' ? (
              <>
                <Button icon="lock" onClick={lockVault}>
                  Lock now
                </Button>
                <Button icon="key" onClick={() => setDialog('change')}>
                  Change passphrase
                </Button>
              </>
            ) : null}
            {vault.status === 'locked' || vault.status === 'unlocked' ? (
              <Button
                variant="danger"
                icon="trash"
                onClick={async () => {
                  if (!confirm('Delete the encrypted vault and all saved keys? You will need to re-enter them.')) return;
                  await destroyVault();
                  toast('Vault deleted', 'info');
                }}
              >
                Delete vault
              </Button>
            ) : null}
          </div>
          <Field label="Auto-lock after inactivity (minutes, 0 = never)">
            <div style={{ maxWidth: 160 }}>
              <NumberInput value={settings.autoLockMinutes} min={0} max={1440} onChange={(v) => updateSettings({ autoLockMinutes: v ?? 0 })} />
            </div>
          </Field>
        </div>
      </Card>

      <Card title="Network policy">
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>
            Every request from this app (including libraries and the inference worker) is checked here. Same-origin files and localhost (Ollama, LM Studio, vLLM)
            are always allowed; plain HTTP to remote hosts is always blocked. A Content Security Policy enforces HTTPS-only connections at the browser level as a
            second layer.
          </p>
          <div className="stack sm">
            {(
              [
                ['allowlist', 'Allowlist (recommended)', 'Only the hosts listed below.'],
                ['local-only', 'Local only', 'Air-gapped mode: no internet at all, only this site and localhost. Cached in-browser models still work.'],
                ['open', 'Open', 'Any HTTPS host. Convenient, least restrictive.'],
              ] as const
            ).map(([mode, label, hint]) => (
              <label key={mode} className="check">
                <input type="radio" name="netmode" checked={settings.net.mode === mode} onChange={() => updateSettings((s) => ({ ...s, net: { ...s.net, mode } }))} />
                <span>
                  <strong>{label}</strong> <span className="small subtle">— {hint}</span>
                </span>
              </label>
            ))}
          </div>
          <Field label="Allowed hosts (one per line; *.example.com matches subdomains)">
            <Textarea rows={8} className="mono" value={allowText} onChange={(e) => setAllowText(e.target.value)} />
          </Field>
          <div className="row">
            <Button variant="primary" onClick={saveAllowlist}>
              Save allowlist
            </Button>
            <Button
              onClick={() => {
                for (const h of [...HF_HOSTS, ...providerHosts]) allowHost(h);
                toast('Added Hugging Face and enabled-provider hosts', 'success');
              }}
            >
              Add hosts for enabled providers
            </Button>
            <Button variant="ghost" onClick={() => navigate('activity')}>
              View network log
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Built-in protections">
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>No backend, no analytics, no third-party scripts or fonts; all code ships with the app.</li>
          <li>Content Security Policy blocks inline/remote scripts, plugins, form posts and remote images (no tracking pixels in model output).</li>
          <li>Model output is rendered without raw HTML; links open with noopener/noreferrer and only http(s)/mailto are allowed.</li>
          <li>Requests send no cookies and no Referer to third parties; API keys are attached only to their own provider.</li>
          <li>The app refuses to run inside a frame (clickjacking defense).</li>
          <li>The network log records metadata only — never prompts, keys or responses.</li>
        </ul>
      </Card>

      {dialog === 'create' ? <CreateVaultDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'unlock' ? <UnlockDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'change' ? <ChangePassphraseDialog onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function ChangePassphraseDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmNext, setConfirmNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const strength = strengthLabel(passphraseBits(next));
  const valid = current && next.length >= MIN_PASSPHRASE_LENGTH && next === confirmNext;
  return (
    <Modal
      title="Change vault passphrase"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await changePassphrase(current, next);
                toast('Passphrase changed; vault re-encrypted.', 'success');
                onClose();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Change
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Current passphrase">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New passphrase" hint={next ? `Strength: ${strength.label}` : `At least ${MIN_PASSPHRASE_LENGTH} characters`}>
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Confirm new passphrase">
          <Input type="password" autoComplete="new-password" value={confirmNext} onChange={(e) => setConfirmNext(e.target.value)} />
        </Field>
        {error ? <Notice tone="err">{error}</Notice> : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Pricing

function PricingTab() {
  const settings = useSettings();
  const [rows, setRows] = useState<PriceEntry[]>(settings.pricing);
  const dirty = JSON.stringify(rows) !== JSON.stringify(settings.pricing);
  const update = (i: number, patch: Partial<PriceEntry>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack lg">
      <Card title="Budget">
        <div className="stack">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ width: 200 }}>
              <Field label="Monthly budget (USD)" hint="0 = no budget">
                <NumberInput value={settings.budget.monthlyUsd} min={0} step={5} onChange={(v) => updateSettings((s) => ({ ...s, budget: { ...s.budget, monthlyUsd: v ?? 0 } }))} />
              </Field>
            </div>
            <Checkbox
              checked={settings.budget.hardStop}
              onChange={(v) => updateSettings((s) => ({ ...s, budget: { ...s.budget, hardStop: v } }))}
              label="Hard stop: block paid requests once this month's estimated spend reaches the budget"
            />
          </div>
          <span className="small subtle">Spend is estimated from token usage × the prices below. Also set limits in each provider's console; that is the real safeguard.</span>
        </div>
      </Card>
      <Card
        title="Prices (USD per 1M tokens)"
        actions={
          <>
            <Button size="sm" onClick={() => setRows([...rows, { pattern: '', input: 0, output: 0 }])} icon="plus">
              Add row
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRows(DEFAULT_PRICING.map((p) => ({ ...p })))}>
              Reset defaults
            </Button>
            <Button size="sm" variant="primary" disabled={!dirty} onClick={() => updateSettings({ pricing: rows.filter((r) => r.pattern.trim()) })}>
              Save
            </Button>
          </>
        }
      >
        <div className="stack sm">
          <span className="small subtle">
            Patterns match model ids exactly, or with * wildcards (e.g. <code>gpt-4o*</code>). Defaults cover Claude models; add the models you use from other
            providers. Local and in-browser models are free.
          </span>
          {rows.map((r, i) => (
            <div key={i} className="row nowrap">
              <Input className="mono" placeholder="model id or pattern*" value={r.pattern} onChange={(e) => update(i, { pattern: e.target.value })} />
              <div style={{ width: 120 }}>
                <NumberInput value={r.input} min={0} step={0.01} placeholder="input" onChange={(v) => update(i, { input: v ?? 0 })} />
              </div>
              <div style={{ width: 120 }}>
                <NumberInput value={r.output} min={0} step={0.01} placeholder="output" onChange={(v) => update(i, { output: v ?? 0 })} />
              </div>
              <Button variant="ghost" iconOnly icon="x" aria-label="Remove row" onClick={() => setRows(rows.filter((_, j) => j !== i))} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data

function DataTab() {
  const [storage, setStorage] = useState<{ usage?: number; quota?: number; persisted?: boolean }>({});
  const [selected, setSelected] = useState<Record<CollectionKey, boolean>>({
    conversations: true,
    prompts: true,
    datasets: true,
    evals: true,
    models: true,
    usage: true,
  });
  const [includeSettings, setIncludeSettings] = useState(true);
  const [includeVault, setIncludeVault] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [importFile, setImportFile] = useState<{ text: string; name: string; encrypted: boolean } | null>(null);
  const [wipe, setWipe] = useState(false);

  const refresh = async () => {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    setStorage({ usage: est?.usage, quota: est?.quota, persisted });
  };
  useEffect(() => {
    void refresh();
  }, []);

  const exportWorkspace = async () => {
    if (includeVault && !passphrase) {
      toast('Encrypt the backup with a passphrase to include the vault.', 'warning');
      return;
    }
    setBusy(true);
    try {
      const keys = (Object.keys(selected) as CollectionKey[]).filter((k) => selected[k]);
      const file = await buildWorkspaceExport({ collections: keys, includeSettings, includeVault, passphrase: passphrase || undefined });
      downloadJSON(file, `ai-workbench-${timestampSlug()}${passphrase ? '.workbench.enc.json' : '.workbench.json'}`);
      toast(passphrase ? 'Encrypted backup downloaded' : 'Backup downloaded (unencrypted, keep it safe)', 'success');
    } catch (err) {
      toastError(err, 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack lg">
      <Card title="Storage">
        <div className="stack">
          <KeyValues
            items={[
              ['Used', formatBytes(storage.usage)],
              ['Available quota', formatBytes(storage.quota)],
              ['Persistent', storage.persisted ? <Badge key="p" tone="ok">yes — the browser won't evict this data</Badge> : <Badge key="p" tone="warn">no — the browser may clear it under storage pressure</Badge>],
            ]}
          />
          {!storage.persisted ? (
            <div className="row">
              <Button
                onClick={async () => {
                  const ok = await navigator.storage?.persist?.();
                  toast(ok ? 'Persistent storage granted' : 'The browser declined (it may grant it after more use, or if installed/bookmarked)', ok ? 'success' : 'warning');
                  void refresh();
                }}
              >
                Request persistent storage
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      <Card title="Back up workspace">
        <div className="stack">
          <div className="row">
            {(Object.keys(ALL_COLLECTIONS) as CollectionKey[]).map((k) => (
              <Checkbox key={k} checked={selected[k]} onChange={(v) => setSelected({ ...selected, [k]: v })} label={k} />
            ))}
          </div>
          <Checkbox checked={includeSettings} onChange={setIncludeSettings} label="Settings (providers, pricing, network policy; never raw keys)" />
          <Checkbox checked={includeVault} onChange={setIncludeVault} label="Encrypted key vault (still protected by its own vault passphrase)" />
          <Field label="Encrypt backup with passphrase (recommended)" hint="Leave empty for a plain JSON file.">
            <Input type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} style={{ maxWidth: 360 }} />
          </Field>
          <div className="row">
            <Button variant="primary" icon="download" loading={busy} onClick={exportWorkspace}>
              Download backup
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Restore">
        <div className="row">
          <Button
            icon="upload"
            onClick={async () => {
              const [file] = await pickFiles('.json,application/json');
              if (!file) return;
              const text = await file.text();
              let encrypted = false;
              try {
                encrypted = isEncryptedWorkspace(JSON.parse(text));
              } catch {
                toast('Not a JSON file', 'error');
                return;
              }
              setImportFile({ text, name: file.name, encrypted });
            }}
          >
            Choose backup file…
          </Button>
        </div>
      </Card>

      <Card title="Danger zone">
        <div className="row between">
          <span className="muted">Delete every conversation, dataset, evaluation, setting, key and cached model in this browser.</span>
          <Button variant="danger" icon="trash" onClick={() => setWipe(true)}>
            Wipe all data
          </Button>
        </div>
      </Card>

      {importFile ? <ImportDialog file={importFile} onClose={() => setImportFile(null)} /> : null}
      {wipe ? <WipeDialog onClose={() => setWipe(false)} /> : null}
    </div>
  );
}

function ImportDialog({ file, onClose }: { file: { text: string; name: string; encrypted: boolean }; onClose: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [parsed, setParsed] = useState<WorkspaceFile | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [importSettings, setImportSettings] = useState(false);
  const [importVault, setImportVault] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setError('');
    try {
      setParsed(await parseWorkspaceFile(file.text, passphrase || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (!file.encrypted) void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal
      title={`Restore ${file.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {parsed ? (
            <Button
              variant={mode === 'replace' ? 'danger' : 'primary'}
              loading={busy}
              onClick={async () => {
                if (mode === 'replace' && !confirm('Replace mode deletes current items in the restored collections first. Continue?')) return;
                setBusy(true);
                try {
                  const summary = await importWorkspace(parsed, { mode, importSettings, importVault });
                  const counts = Object.entries(summary.counts)
                    .map(([k, n]) => `${n} ${k}`)
                    .join(', ');
                  toast(`Restored ${counts || 'nothing'}${summary.settings ? ', settings' : ''}${summary.vault ? ', vault (locked)' : ''}`, 'success');
                  onClose();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Restore
            </Button>
          ) : (
            <Button variant="primary" disabled={!passphrase} onClick={open}>
              Decrypt
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        {file.encrypted && !parsed ? (
          <Field label="Backup passphrase">
            <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void open()} />
          </Field>
        ) : null}
        {parsed ? (
          <>
            <KeyValues
              items={[
                ['Exported', parsed.exportedAt],
                ...(Object.entries(parsed.collections).map(([k, v]) => [k, `${(v as unknown[]).length} items`]) as [string, string][]),
                ['Settings', parsed.settings ? 'included' : '—'],
                ['Vault', parsed.vault ? 'included (encrypted)' : '—'],
              ]}
            />
            <Field label="Mode">
              <Select value={mode} onChange={(e) => setMode(e.target.value as 'merge' | 'replace')}>
                <option value="merge">Merge (add new, overwrite same ids)</option>
                <option value="replace">Replace (clear those collections first)</option>
              </Select>
            </Field>
            {parsed.settings ? <Checkbox checked={importSettings} onChange={setImportSettings} label="Also restore settings" /> : null}
            {parsed.vault ? <Checkbox checked={importVault} onChange={setImportVault} label="Also restore the key vault (replaces the current vault)" /> : null}
          </>
        ) : null}
        {error ? <Notice tone="err">{error}</Notice> : null}
      </div>
    </Modal>
  );
}

function WipeDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Wipe all data"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={text !== 'DELETE'}
            onClick={async () => {
              setBusy(true);
              await wipeAllData();
              location.hash = '';
              location.reload();
            }}
          >
            Permanently delete everything
          </Button>
        </>
      }
    >
      <div className="stack">
        <Notice tone="err">This cannot be undone. Download a backup first if you might need anything.</Notice>
        <Field label='Type "DELETE" to confirm'>
          <Input value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// General

function GeneralTab() {
  const settings = useSettings();
  return (
    <div className="stack lg">
      <Card title="Appearance">
        <Field label="Theme">
          <Select value={settings.theme} onChange={(e) => updateSettings({ theme: e.target.value as Theme })} style={{ maxWidth: 240 }}>
            <option value="system">Match system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </Select>
        </Field>
      </Card>
      <Card title="Records">
        <div className="stack">
          <Checkbox checked={settings.recordUsage} onChange={(v) => updateSettings({ recordUsage: v })} label="Keep a usage ledger (tokens, cost, latency per call) for the dashboard and budget" />
          <Checkbox
            checked={settings.storeInspect}
            onChange={(v) => updateSettings({ storeInspect: v })}
            label="Keep raw request/response JSON on chat messages (for Inspect and learning; uses more storage)"
          />
        </div>
      </Card>
      <Card title="About">
        <KeyValues
          items={[
            ['Version', __APP_VERSION__],
            ['Architecture', 'Static single-page app: React + TypeScript + Vite. IndexedDB storage, WebCrypto vault, Web Worker inference.'],
            ['Data location', 'This browser profile only. Nothing is sent anywhere except the API calls you make.'],
            ['Keyboard', 'Ctrl/⌘ + K opens the command palette.'],
          ]}
        />
      </Card>
    </div>
  );
}
