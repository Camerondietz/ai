// Domain types shared across the app. Everything here is plain JSON so it can
// be stored in IndexedDB and exported/imported as files.

export type Role = 'system' | 'user' | 'assistant';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Row = Record<string, unknown>;

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** true when the provider did not report usage and we estimated it */
  estimated?: boolean;
}

export interface ChatParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  /** Anthropic: output_config.effort */
  effort?: Effort;
  /** Ask the provider for a readable reasoning summary when supported */
  showReasoning?: boolean;
}

export interface ModelRef {
  providerId: string;
  model: string;
}

export interface StoredMessage extends ChatMessage {
  id: string;
  createdAt: number;
  providerId?: string;
  model?: string;
  thinking?: string;
  usage?: TokenUsage;
  latencyMs?: number;
  firstTokenMs?: number;
  costUsd?: number;
  stopReason?: string;
  error?: string;
  /** Sanitized request/response for the "Inspect" view (never contains keys) */
  inspect?: { request: unknown; response?: unknown };
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId: string;
  model: string;
  system: string;
  params: ChatParams;
  messages: StoredMessage[];
  pinned?: boolean;
}

export interface PromptVersion {
  version: number;
  system: string;
  template: string;
  note?: string;
  createdAt: number;
}

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  versions: PromptVersion[];
  createdAt: number;
  updatedAt: number;
}

export interface Dataset {
  id: string;
  name: string;
  description: string;
  /** e.g. "file:qa.csv", "hf:squad/plain_text/validation", "eval:<id>" */
  source: string;
  columns: string[];
  rows: Row[];
  createdAt: number;
  updatedAt: number;
}

export type ScorerType = 'exact' | 'contains' | 'regex' | 'json' | 'f1' | 'judge';

export interface ScorerConfig {
  type: ScorerType;
  caseSensitive?: boolean;
  pattern?: string;
  judge?: ModelRef;
  rubric?: string;
}

export interface EvalConfig {
  datasetId: string;
  datasetName: string;
  promptId?: string;
  promptVersion?: number;
  system: string;
  template: string;
  models: ModelRef[];
  expectedColumn?: string;
  scorers: ScorerConfig[];
  params: ChatParams;
  concurrency: number;
  limit?: number;
}

export interface EvalInput {
  rowIndex: number;
  prompt: string;
  /** Rendered system prompt when it contains per-row variables */
  system?: string;
  expected?: string;
}

export interface EvalCell {
  rowIndex: number;
  modelKey: string;
  output: string;
  error?: string;
  latencyMs?: number;
  usage?: TokenUsage;
  costUsd?: number;
  scores: Record<string, number>;
  judgeNotes?: string;
}

export type EvalStatus = 'running' | 'done' | 'cancelled' | 'error' | 'interrupted';

export interface EvalRun {
  id: string;
  name: string;
  createdAt: number;
  finishedAt?: number;
  status: EvalStatus;
  /** Why the run stopped early (status "error") */
  error?: string;
  config: EvalConfig;
  inputs: EvalInput[];
  cells: EvalCell[];
}

export interface ModelEntry {
  id: string;
  name: string;
  kind: 'file' | 'hub' | 'endpoint';
  /** file name, HF repo id, or provider/model */
  source: string;
  format?: string;
  params?: number;
  sizeBytes?: number;
  dtypes?: Record<string, number>;
  metadata?: Record<string, unknown>;
  tags: string[];
  notes: string;
  createdAt: number;
  updatedAt: number;
}

export type UsageSource = 'chat' | 'compare' | 'eval' | 'judge' | 'other';

export interface UsageRecord {
  id: string;
  ts: number;
  providerId: string;
  model: string;
  source: UsageSource;
  inputTokens: number;
  outputTokens: number;
  estimated?: boolean;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
}

export type ProviderKind = 'openai' | 'anthropic' | 'local';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** Vault entry holding the API key; undefined when no key is needed */
  secretRef?: string;
  models: string[];
  defaultModel?: string;
  enabled: boolean;
  preset?: string;
  options: {
    /** OpenAI-compatible: request usage in the final stream chunk */
    streamUsage?: boolean;
    /** OpenAI-compatible: name of the max tokens field */
    maxTokensField?: 'max_tokens' | 'max_completion_tokens';
    /** Anthropic: server-side refusal fallback on supported models */
    refusalFallback?: boolean;
  };
  /** Extra non-secret headers (e.g. OpenRouter's X-Title) */
  headers?: Record<string, string>;
}

export interface PriceEntry {
  /** exact model id, or a glob with * (e.g. "gpt-4o*") */
  pattern: string;
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
}
