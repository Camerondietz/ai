/**
 * Back-of-the-envelope inference memory estimate:
 *   weights  = params × bytes/param
 *   KV cache = 2 (K and V) × layers × kv_heads × head_dim × context × batch × bytes
 *   overhead = activations, runtime buffers, fragmentation (a percentage)
 */
export interface MemoryInput {
  params: number;
  bytesPerParam: number;
  layers: number;
  kvHeads: number;
  headDim: number;
  context: number;
  batch: number;
  kvBytes: number;
  overheadPct: number;
}

export interface MemoryEstimate {
  weights: number;
  kvCache: number;
  overhead: number;
  total: number;
}

export function estimateMemory(i: MemoryInput): MemoryEstimate {
  const weights = i.params * i.bytesPerParam;
  const kvCache = 2 * i.layers * i.kvHeads * i.headDim * i.context * i.batch * i.kvBytes;
  const overhead = ((weights + kvCache) * i.overheadPct) / 100;
  return { weights, kvCache, overhead, total: weights + kvCache + overhead };
}

export const PRECISIONS: { label: string; bytes: number }[] = [
  { label: 'FP32', bytes: 4 },
  { label: 'FP16 / BF16', bytes: 2 },
  { label: 'FP8 / INT8 / Q8', bytes: 1 },
  { label: 'Q6_K (~6.6 bit)', bytes: 0.82 },
  { label: 'Q5_K_M (~5.7 bit)', bytes: 0.71 },
  { label: 'Q4_K_M (~4.8 bit)', bytes: 0.6 },
  { label: 'INT4 / Q4 (4 bit)', bytes: 0.5 },
  { label: 'Q3_K (~3.4 bit)', bytes: 0.43 },
  { label: 'Q2_K (~2.6 bit)', bytes: 0.33 },
];

export interface ConfigHints {
  layers?: number;
  heads?: number;
  kvHeads?: number;
  headDim?: number;
  hiddenSize?: number;
  maxContext?: number;
  modelType?: string;
  vocabSize?: number;
}

/** Pull architecture numbers out of a Hugging Face config.json. */
export function hintsFromConfig(config: Record<string, unknown>): ConfigHints {
  const c = (config.text_config && typeof config.text_config === 'object' ? config.text_config : config) as Record<string, unknown>;
  const num = (...keys: string[]) => {
    for (const k of keys) {
      const v = c[k] ?? config[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const heads = num('num_attention_heads', 'n_head', 'num_heads');
  const hiddenSize = num('hidden_size', 'n_embd', 'd_model');
  return {
    layers: num('num_hidden_layers', 'n_layer', 'num_layers'),
    heads,
    kvHeads: num('num_key_value_heads', 'num_kv_heads', 'multi_query_group_num') ?? heads,
    headDim: num('head_dim') ?? (heads && hiddenSize ? hiddenSize / heads : undefined),
    hiddenSize,
    maxContext: num('max_position_embeddings', 'n_positions', 'max_sequence_length', 'seq_length'),
    modelType: typeof c.model_type === 'string' ? c.model_type : typeof config.model_type === 'string' ? (config.model_type as string) : undefined,
    vocabSize: num('vocab_size'),
  };
}
