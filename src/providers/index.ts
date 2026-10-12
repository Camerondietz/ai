import { NetworkBlockedError } from '../lib/net';
import { estimateUsage } from '../lib/tokens';
import { getProvider, getSettings } from '../state/settings';
import { assertWithinBudget, recordUsage } from '../state/usage';
import { getSecret, vaultStore } from '../state/vault';
import type { ChatMessage, ChatParams, ModelRef, ProviderConfig, UsageSource } from '../state/types';
import { chatAnthropic, listAnthropicModels } from './anthropic';
import { chatLocal } from './local';
import { chatOpenAI, listOpenAIModels } from './openai';
import type { ChatRequest, ChatResult } from './types';

export interface RunChatOptions {
  providerId: string;
  model: string;
  system?: string;
  messages: ChatMessage[];
  params: ChatParams;
  source: UsageSource;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onThinking?: (text: string) => void;
  onStatus?: (status: string) => void;
}

export interface RunChatOutcome extends ChatResult {
  latencyMs: number;
  costUsd: number;
  aborted?: boolean;
}

function resolveKey(provider: ProviderConfig): string | undefined {
  if (!provider.secretRef) return undefined;
  const key = getSecret(provider.secretRef);
  if (key) return key;
  if (vaultStore.get().status === 'locked') {
    throw new Error('The vault is locked. Unlock it (top bar) to use your saved API keys.');
  }
  throw new Error(`No API key set for ${provider.name}. Add one in Settings → Providers.`);
}

export async function runChat(opts: RunChatOptions): Promise<RunChatOutcome> {
  const provider = getProvider(opts.providerId);
  if (!provider) throw new Error(`Unknown provider "${opts.providerId}". Pick a model again.`);
  if (!provider.enabled) throw new Error(`${provider.name} is disabled in Settings → Providers.`);
  if (!opts.model) throw new Error('Choose a model first.');
  await assertWithinBudget(provider.kind);
  const apiKey = resolveKey(provider);

  let partial = '';
  const req: ChatRequest = {
    provider,
    apiKey,
    model: opts.model,
    system: opts.system?.trim() ? opts.system : undefined,
    messages: opts.messages,
    params: opts.params,
    signal: opts.signal,
    onDelta: (t) => {
      partial += t;
      opts.onDelta?.(t);
    },
    onThinking: opts.onThinking,
    onStatus: opts.onStatus,
  };

  const started = performance.now();
  try {
    const result =
      provider.kind === 'anthropic'
        ? await chatAnthropic(req)
        : provider.kind === 'local'
          ? await chatLocal(req)
          : await chatOpenAI(req);
    const latencyMs = performance.now() - started;
    const usage = result.usage ?? estimateUsage(req.system, req.messages, result.text);
    const costUsd = await recordUsage({
      providerId: provider.id,
      model: opts.model,
      source: opts.source,
      usage,
      latencyMs,
      ok: true,
    });
    return { ...result, usage, latencyMs, costUsd, aborted: opts.signal?.aborted || undefined };
  } catch (err) {
    const latencyMs = performance.now() - started;
    if (opts.signal?.aborted) {
      // Stopped by the user: keep what streamed so far (it was still billed).
      const usage = estimateUsage(req.system, req.messages, partial);
      const costUsd = await recordUsage({ providerId: provider.id, model: opts.model, source: opts.source, usage, latencyMs, ok: true });
      return { text: partial, usage, latencyMs, costUsd, aborted: true, model: opts.model, stopReason: 'aborted' };
    }
    await recordUsage({ providerId: provider.id, model: opts.model, source: opts.source, latencyMs, ok: false });
    throw err;
  }
}

export async function listModels(provider: ProviderConfig): Promise<string[]> {
  const apiKey = provider.secretRef ? getSecret(provider.secretRef) : undefined;
  if (provider.kind === 'local') return provider.models;
  if (provider.kind === 'anthropic') return listAnthropicModels(provider, apiKey);
  return listOpenAIModels(provider, apiKey);
}

/** All selectable provider/model pairs from enabled providers. */
export function modelOptions(): { ref: ModelRef; label: string; providerName: string }[] {
  const out: { ref: ModelRef; label: string; providerName: string }[] = [];
  for (const p of getSettings().providers) {
    if (!p.enabled) continue;
    for (const m of p.models) out.push({ ref: { providerId: p.id, model: m }, label: m, providerName: p.name });
  }
  return out;
}

export function modelKey(ref: ModelRef): string {
  return `${ref.providerId}::${ref.model}`;
}

export function parseModelKey(key: string): ModelRef {
  const i = key.indexOf('::');
  return i === -1 ? { providerId: '', model: key } : { providerId: key.slice(0, i), model: key.slice(i + 2) };
}

export function isBlockedError(err: unknown): err is NetworkBlockedError {
  return err instanceof NetworkBlockedError;
}

export function describeError(err: unknown): string {
  if (err instanceof NetworkBlockedError) {
    return `${err.message}. Add the host in Settings → Security → Network policy if you trust it.`;
  }
  if (err instanceof TypeError && /fetch|network/i.test(err.message)) {
    return `${err.message}. The server may be down or may not allow browser (CORS) requests from this site.`;
  }
  return err instanceof Error ? err.message : String(err);
}
