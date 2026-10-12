import { dbGet, dbPut } from '../lib/db';
import { setNetPolicy, type NetPolicy } from '../lib/net';
import { createStore, useStore } from '../lib/store';
import { shortId } from '../lib/id';
import { DEFAULT_PRICING, PROVIDER_PRESETS, presetFor, providerFromPreset } from '../providers/presets';
import type { ModelRef, PriceEntry, ProviderConfig, TokenUsage } from './types';

export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  version: 1;
  theme: Theme;
  providers: ProviderConfig[];
  defaultModel?: ModelRef;
  pricing: PriceEntry[];
  budget: { monthlyUsd: number; hardStop: boolean };
  net: NetPolicy;
  /** Lock the vault after this many idle minutes (0 = never) */
  autoLockMinutes: number;
  local: { device: 'auto' | 'webgpu' | 'wasm'; allowRemoteModels: boolean; localModelPath: string };
  hf: { endpoint: string; datasetsServer: string };
  /** Keep a per-request usage ledger (tokens, cost, latency) */
  recordUsage: boolean;
  /** Keep raw request/response JSON on chat messages for the Inspect view */
  storeInspect: boolean;
}

export const HF_HOSTS = ['huggingface.co', '*.huggingface.co', '*.hf.co'];

function defaultProviders(): ProviderConfig[] {
  return ['anthropic', 'openai', 'huggingface', 'ollama', 'browser'].map((key) =>
    providerFromPreset(presetFor(key)!, key),
  );
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    theme: 'system',
    providers: defaultProviders(),
    defaultModel: { providerId: 'anthropic', model: 'claude-opus-5-5' },
    pricing: DEFAULT_PRICING.map((p) => ({ ...p })),
    budget: { monthlyUsd: 50, hardStop: false },
    net: {
      mode: 'allowlist',
      allowlist: [...HF_HOSTS, 'api.anthropic.com', 'api.openai.com'],
    },
    autoLockMinutes: 15,
    local: { device: 'auto', allowRemoteModels: true, localModelPath: './models/' },
    hf: { endpoint: 'https://huggingface.co', datasetsServer: 'https://datasets-server.huggingface.co' },
    recordUsage: true,
    storeInspect: true,
  };
}

export const settingsStore = createStore<Settings>(defaultSettings());

export function getSettings(): Settings {
  return settingsStore.get();
}

export function useSettings(): Settings {
  return useStore(settingsStore);
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function merge(saved: Partial<Settings>): Settings {
  const d = defaultSettings();
  return {
    ...d,
    ...saved,
    budget: { ...d.budget, ...saved.budget },
    net: { ...d.net, ...saved.net },
    local: { ...d.local, ...saved.local },
    hf: { ...d.hf, ...saved.hf },
    providers: saved.providers ?? d.providers,
    pricing: saved.pricing ?? d.pricing,
    version: 1,
  };
}

export async function initSettings(): Promise<void> {
  const saved = await dbGet<Partial<Settings>>('kv', 'settings');
  if (saved) settingsStore.set(merge(saved));
  setNetPolicy(settingsStore.get().net);
  settingsStore.subscribe(() => {
    const s = settingsStore.get();
    setNetPolicy(s.net);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void dbPut('kv', s, 'settings'), 250);
  });
}

export function updateSettings(patch: Partial<Settings> | ((prev: Settings) => Settings)) {
  settingsStore.set((prev) => (typeof patch === 'function' ? patch(prev) : { ...prev, ...patch }));
}

export function replaceSettings(next: Partial<Settings>) {
  settingsStore.set(merge(next));
}

// ---------------------------------------------------------------------------
// Providers

export function getProvider(id: string): ProviderConfig | undefined {
  return settingsStore.get().providers.find((p) => p.id === id);
}

export function upsertProvider(provider: ProviderConfig) {
  updateSettings((s) => {
    const exists = s.providers.some((p) => p.id === provider.id);
    return {
      ...s,
      providers: exists ? s.providers.map((p) => (p.id === provider.id ? provider : p)) : [...s.providers, provider],
    };
  });
}

export function removeProvider(id: string) {
  updateSettings((s) => ({ ...s, providers: s.providers.filter((p) => p.id !== id) }));
}

export function addProviderFromPreset(presetKey: string): ProviderConfig {
  const preset = presetFor(presetKey) ?? PROVIDER_PRESETS[0];
  const taken = new Set(settingsStore.get().providers.map((p) => p.id));
  const id = taken.has(preset.preset) ? `${preset.preset}-${shortId()}` : preset.preset;
  const provider = providerFromPreset(preset, id);
  upsertProvider(provider);
  return provider;
}

/** Hostname of a provider's base URL, if it is a remote https host. */
export function providerHost(provider: ProviderConfig): string | null {
  try {
    const url = new URL(provider.baseUrl);
    return url.protocol === 'https:' ? url.hostname : null;
  } catch {
    return null;
  }
}

export function allowHost(host: string) {
  updateSettings((s) =>
    s.net.allowlist.includes(host) ? s : { ...s, net: { ...s.net, allowlist: [...s.net.allowlist, host] } },
  );
}

// ---------------------------------------------------------------------------
// Pricing

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function priceFor(model: string): PriceEntry | undefined {
  const table = settingsStore.get().pricing;
  return (
    table.find((p) => p.pattern === model) ??
    table.find((p) => p.pattern.includes('*') && globToRegExp(p.pattern).test(model))
  );
}

export function computeCost(providerId: string, model: string, usage: TokenUsage | undefined): number {
  if (!usage) return 0;
  const provider = getProvider(providerId);
  if (provider?.kind === 'local') return 0;
  const price = priceFor(model);
  if (!price) return 0;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}
