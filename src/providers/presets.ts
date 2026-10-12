import type { PriceEntry, ProviderConfig, ProviderKind } from '../state/types';

export interface ProviderPreset {
  preset: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  needsKey: boolean;
  /** Share an existing vault entry (Hugging Face token) instead of a per-provider key */
  secretRef?: string;
  models: string[];
  defaultModel?: string;
  options: ProviderConfig['options'];
  /** Where to create a key */
  keyUrl?: string;
  note?: string;
}

export const HF_TOKEN_SECRET = 'hf:token';

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    preset: 'anthropic',
    name: 'Anthropic (Claude)',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    needsKey: true,
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    defaultModel: 'claude-opus-5-5',
    options: { refusalFallback: true },
    keyUrl: 'https://platform.claude.com',
    note: 'Uses the official Anthropic SDK with direct browser access enabled. Your key is sent only to api.anthropic.com.',
  },
  {
    preset: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    models: [],
    options: { streamUsage: true, maxTokensField: 'max_completion_tokens' },
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    preset: 'huggingface',
    name: 'Hugging Face Inference Providers',
    kind: 'openai',
    baseUrl: 'https://router.huggingface.co/v1',
    needsKey: true,
    secretRef: HF_TOKEN_SECRET,
    models: [],
    options: { streamUsage: true, maxTokensField: 'max_tokens' },
    keyUrl: 'https://huggingface.co/settings/tokens',
    note: 'OpenAI-compatible router to many open models. Uses your Hugging Face token (needs the "Make calls to Inference Providers" permission).',
  },
  {
    preset: 'gemini',
    name: 'Google Gemini',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    models: [],
    options: { streamUsage: true, maxTokensField: 'max_tokens' },
    keyUrl: 'https://aistudio.google.com/apikey',
    note: "Uses Gemini's OpenAI-compatible endpoint.",
  },
  {
    preset: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    models: [],
    options: { streamUsage: true, maxTokensField: 'max_tokens' },
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    preset: 'groq',
    name: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    models: [],
    options: { streamUsage: true, maxTokensField: 'max_tokens' },
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    preset: 'mistral',
    name: 'Mistral AI',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    needsKey: true,
    models: [],
    options: { streamUsage: false, maxTokensField: 'max_tokens' },
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    preset: 'ollama',
    name: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    models: [],
    options: { streamUsage: true, maxTokensField: 'max_tokens' },
    note: 'Start Ollama with OLLAMA_ORIGINS set to this site\'s origin so the browser may call it (see README).',
  },
  {
    preset: 'lmstudio',
    name: 'LM Studio (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    needsKey: false,
    models: [],
    options: { streamUsage: true, maxTokensField: 'max_tokens' },
    note: 'Enable CORS in LM Studio\'s server settings.',
  },
  {
    preset: 'custom',
    name: 'Custom OpenAI-compatible',
    kind: 'openai',
    baseUrl: 'http://localhost:8000/v1',
    needsKey: false,
    models: [],
    options: { streamUsage: true, maxTokensField: 'max_tokens' },
    note: 'vLLM, llama.cpp server, TGI, LiteLLM or any gateway that speaks /v1/chat/completions.',
  },
  {
    preset: 'browser',
    name: 'In-browser (Transformers.js)',
    kind: 'local',
    baseUrl: '',
    needsKey: false,
    models: ['onnx-community/Qwen3-0.6B-ONNX', 'HuggingFaceTB/SmolLM2-360M-Instruct', 'onnx-community/Qwen2.5-0.5B-Instruct'],
    defaultModel: 'onnx-community/Qwen3-0.6B-ONNX',
    options: {},
    note: 'Runs entirely on your device (WebGPU or WebAssembly). Weights download once from Hugging Face and are cached by the browser.',
  },
];

export function presetFor(key: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.preset === key);
}

export function providerFromPreset(preset: ProviderPreset, id: string): ProviderConfig {
  return {
    id,
    name: preset.name,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    secretRef: preset.needsKey ? (preset.secretRef ?? `provider:${id}`) : undefined,
    models: [...preset.models],
    defaultModel: preset.defaultModel,
    enabled: true,
    preset: preset.preset,
    options: { ...preset.options },
  };
}

/** Default price table (USD per 1M tokens). Edit in Settings → Pricing. */
export const DEFAULT_PRICING: PriceEntry[] = [
  { pattern: 'claude-fable-5-1', input: 10, output: 50 },
  { pattern: 'claude-fable-5', input: 10, output: 50 },
  { pattern: 'claude-opus-5-5', input: 4, output: 20 },
  { pattern: 'claude-opus-5', input: 5, output: 25 },
  { pattern: 'claude-opus-4-8', input: 5, output: 25 },
  { pattern: 'claude-opus-4-7', input: 5, output: 25 },
  { pattern: 'claude-opus-4-6', input: 5, output: 25 },
  { pattern: 'claude-sonnet-5-5', input: 2, output: 10 },
  { pattern: 'claude-sonnet-5', input: 2, output: 10 },
  { pattern: 'claude-sonnet-4-6', input: 3, output: 15 },
  { pattern: 'claude-haiku-5-5', input: 0.1, output: 0.5 },
  { pattern: 'claude-haiku-4-5', input: 1, output: 5 },
];
