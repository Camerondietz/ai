/**
 * Anthropic adapter built on the official SDK (@anthropic-ai/sdk), loaded on
 * demand. Requests go straight from the browser to the Anthropic API with the
 * user's own key ("direct browser access"); the SDK's fetch is routed through
 * the app's network guard so they appear in the activity log.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { makeFetch } from '../lib/net';
import type { ProviderConfig } from '../state/types';
import type { ChatRequest, ChatResult } from './types';

type StreamParams = Parameters<Anthropic['messages']['stream']>[0];
type BetaStreamParams = Parameters<Anthropic['beta']['messages']['stream']>[0];

/** Current models reject temperature/top_p (sampling is fixed). */
const NO_SAMPLING = /claude-(fable|mythos|opus-5|opus-4-[78]|sonnet-5|haiku-5)/;
/** Models that accept thinking: {type: "adaptive"} and output_config.effort. */
const ADAPTIVE = /claude-(fable|mythos|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5)/;
/** Models with server-side refusal fallback ("fallbacks": "default"). */
const FALLBACK = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

export function anthropicSupportsSampling(model: string): boolean {
  return !NO_SAMPLING.test(model);
}

export function anthropicSupportsAdaptive(model: string): boolean {
  return ADAPTIVE.test(model);
}

function isFirstPartyApi(baseUrl: string): boolean {
  return !baseUrl || /^https:\/\/api\.anthropic\.com\/?$/.test(baseUrl);
}

/**
 * Server-side refusal fallback: when enabled for a supported model on the
 * Claude API, a declined request is re-run on a fallback model in the same
 * call. Returns the beta header to send, or null.
 */
export function anthropicFallbackBeta(provider: ProviderConfig, model: string): string | null {
  return provider.options.refusalFallback && FALLBACK.test(model) && isFirstPartyApi(provider.baseUrl)
    ? 'server-side-fallback-2026-07-01'
    : null;
}

async function createClient(provider: ProviderConfig, apiKey: string | undefined): Promise<Anthropic> {
  if (!apiKey) throw new Error(`No API key set for ${provider.name}.`);
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  return new AnthropicClient({
    apiKey,
    baseURL: provider.baseUrl || undefined,
    dangerouslyAllowBrowser: true,
    fetch: makeFetch(`chat:${provider.id}`),
    maxRetries: 1,
    defaultHeaders: provider.headers,
  });
}

export function buildAnthropicParams(req: Pick<ChatRequest, 'model' | 'system' | 'messages' | 'params'>): Record<string, unknown> {
  const p = req.params;
  const params: Record<string, unknown> = {
    model: req.model,
    max_tokens: p.maxTokens ?? 64000,
    messages: req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
  };
  if (req.system) params.system = req.system;
  if (anthropicSupportsSampling(req.model)) {
    if (p.temperature != null) params.temperature = p.temperature;
    if (p.topP != null) params.top_p = p.topP;
  }
  if (p.stop?.length) params.stop_sequences = p.stop;
  if (anthropicSupportsAdaptive(req.model)) {
    if (p.showReasoning) params.thinking = { type: 'adaptive', display: 'summarized' };
    if (p.effort) params.output_config = { effort: p.effort };
  }
  return params;
}

interface LooseEvent {
  type: string;
  delta?: { type?: string; text?: string; thinking?: string };
}

export async function chatAnthropic(req: ChatRequest): Promise<ChatResult> {
  const client = await createClient(req.provider, req.apiKey);
  const params = buildAnthropicParams(req);
  const fallbackBeta = anthropicFallbackBeta(req.provider, req.model);
  const useFallback = fallbackBeta !== null;
  const request = useFallback ? { ...params, betas: [fallbackBeta], fallbacks: 'default' } : params;

  const started = performance.now();
  const stream = useFallback
    ? client.beta.messages.stream(request as unknown as BetaStreamParams, { signal: req.signal })
    : client.messages.stream(request as unknown as StreamParams, { signal: req.signal });

  let text = '';
  let thinking = '';
  let firstTokenMs: number | undefined;
  for await (const event of stream as unknown as AsyncIterable<LooseEvent>) {
    if (event.type !== 'content_block_delta' || !event.delta) continue;
    if (event.delta.type === 'text_delta' && event.delta.text) {
      firstTokenMs ??= performance.now() - started;
      text += event.delta.text;
      req.onDelta?.(event.delta.text);
    } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
      firstTokenMs ??= performance.now() - started;
      thinking += event.delta.thinking;
      req.onThinking?.(event.delta.thinking);
    }
  }

  const final = await stream.finalMessage();
  const u = final.usage as unknown as {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  const stopDetails = (final as unknown as { stop_details?: unknown }).stop_details;
  return {
    text,
    thinking: thinking || undefined,
    usage: {
      inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens,
    },
    stopReason: final.stop_reason ?? undefined,
    model: final.model,
    firstTokenMs,
    request,
    response: {
      id: final.id,
      model: final.model,
      stop_reason: final.stop_reason,
      stop_details: stopDetails ?? null,
      usage: final.usage,
    },
  };
}

/** Exact input token count from the Messages API token counting endpoint. */
export async function countAnthropicTokens(provider: ProviderConfig, apiKey: string | undefined, model: string, text: string): Promise<number> {
  const client = await createClient(provider, apiKey);
  const res = await client.messages.countTokens({ model, messages: [{ role: 'user', content: text }] });
  return res.input_tokens;
}

export async function listAnthropicModels(provider: ProviderConfig, apiKey?: string): Promise<string[]> {
  const client = await createClient(provider, apiKey);
  const ids: string[] = [];
  for await (const model of client.models.list({ limit: 100 })) ids.push(model.id);
  return ids;
}
