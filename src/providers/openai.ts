/**
 * OpenAI-compatible Chat Completions adapter. Works with OpenAI, Hugging Face
 * Inference Providers, Gemini's compatibility endpoint, OpenRouter, Groq,
 * Mistral, Ollama, LM Studio, vLLM, llama.cpp and most gateways.
 */
import { guardedFetch } from '../lib/net';
import { readSSE } from '../lib/sse';
import type { ProviderConfig, TokenUsage } from '../state/types';
import { httpError, joinUrl, type ChatRequest, type ChatResult } from './types';

interface Chunk {
  id?: string;
  model?: string;
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  error?: { message?: string };
}

export function buildOpenAIBody(req: Pick<ChatRequest, 'provider' | 'model' | 'system' | 'messages' | 'params'>): Record<string, unknown> {
  const messages = [
    ...(req.system ? [{ role: 'system', content: req.system }] : []),
    ...req.messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  const body: Record<string, unknown> = { model: req.model, messages, stream: true };
  if (req.provider.options.streamUsage !== false) body.stream_options = { include_usage: true };
  const p = req.params;
  if (p.temperature != null) body.temperature = p.temperature;
  if (p.topP != null) body.top_p = p.topP;
  if (p.maxTokens != null) body[req.provider.options.maxTokensField ?? 'max_tokens'] = p.maxTokens;
  if (p.stop?.length) body.stop = p.stop;
  if (p.effort && (p.effort === 'low' || p.effort === 'medium' || p.effort === 'high')) body.reasoning_effort = p.effort;
  return body;
}

function authHeaders(provider: ProviderConfig, apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { ...provider.headers };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

export async function chatOpenAI(req: ChatRequest): Promise<ChatResult> {
  const body = buildOpenAIBody(req);
  const started = performance.now();
  const res = await guardedFetch(
    joinUrl(req.provider.baseUrl, 'chat/completions'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(req.provider, req.apiKey) },
      body: JSON.stringify(body),
      signal: req.signal,
    },
    `chat:${req.provider.id}`,
  );
  if (!res.ok) throw await httpError(res);

  let text = '';
  let thinking = '';
  let model = req.model;
  let id: string | undefined;
  let stopReason: string | undefined;
  let usage: TokenUsage | undefined;
  let rawUsage: Chunk['usage'];
  let firstTokenMs: number | undefined;

  for await (const ev of readSSE(res)) {
    if (ev.data === '[DONE]') break;
    let chunk: Chunk;
    try {
      chunk = JSON.parse(ev.data) as Chunk;
    } catch {
      continue;
    }
    if (chunk.error) throw new Error(chunk.error.message ?? 'Provider returned an error mid-stream');
    id = chunk.id ?? id;
    model = chunk.model ?? model;
    const choice = chunk.choices?.[0];
    const content = choice?.delta?.content;
    if (content) {
      firstTokenMs ??= performance.now() - started;
      text += content;
      req.onDelta?.(content);
    }
    const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
    if (reasoning) {
      firstTokenMs ??= performance.now() - started;
      thinking += reasoning;
      req.onThinking?.(reasoning);
    }
    if (choice?.finish_reason) stopReason = choice.finish_reason;
    if (chunk.usage) {
      rawUsage = chunk.usage;
      usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
    }
  }

  return {
    text,
    thinking: thinking || undefined,
    usage,
    stopReason,
    model,
    firstTokenMs,
    request: body,
    response: { id, model, finish_reason: stopReason, usage: rawUsage },
  };
}

export async function listOpenAIModels(provider: ProviderConfig, apiKey?: string): Promise<string[]> {
  const res = await guardedFetch(
    joinUrl(provider.baseUrl, 'models'),
    { headers: authHeaders(provider, apiKey) },
    `models:${provider.id}`,
  );
  if (!res.ok) throw await httpError(res);
  const json = (await res.json()) as { data?: { id: string }[]; models?: { id?: string; name?: string }[] };
  const ids = json.data?.map((m) => m.id) ?? json.models?.map((m) => m.id ?? m.name ?? '') ?? [];
  return [...new Set(ids.filter(Boolean))].sort();
}
