/**
 * safetensors header reader.
 *
 * File layout: 8-byte little-endian u64 header length N, then N bytes of JSON
 * mapping tensor name -> { dtype, shape, data_offsets }, then raw tensor data.
 * Only the header is read, so multi-GB files inspect instantly (and remote
 * files need just two small HTTP Range requests).
 */
export const SAFETENSORS_DTYPE_BYTES: Record<string, number> = {
  F64: 8,
  F32: 4,
  F16: 2,
  BF16: 2,
  I64: 8,
  I32: 4,
  I16: 2,
  I8: 1,
  U64: 8,
  U32: 4,
  U16: 2,
  U8: 1,
  BOOL: 1,
  F8_E4M3: 1,
  F8_E5M2: 1,
  F8_E8M0: 1,
  F6_E2M3: 0.75,
  F6_E3M2: 0.75,
  F4: 0.5,
};

export interface TensorInfo {
  name: string;
  dtype: string;
  shape: number[];
  params: number;
  bytes: number;
}

export interface WeightsSummary {
  format: 'safetensors' | 'gguf' | 'onnx';
  tensors: TensorInfo[];
  totalParams: number;
  totalBytes: number;
  /** parameter count per dtype */
  dtypeParams: Record<string, number>;
  metadata: Record<string, unknown>;
  headerBytes: number;
}

const MAX_HEADER = 100 * 1024 * 1024;

export function readHeaderLength(first8: ArrayBuffer): number {
  if (first8.byteLength < 8) throw new Error('File too small to be safetensors');
  const n = new DataView(first8).getBigUint64(0, true);
  if (n === 0n || n > BigInt(MAX_HEADER)) throw new Error('Not a safetensors file (implausible header length)');
  return Number(n);
}

export function parseSafetensorsHeader(json: string, headerBytes: number): WeightsSummary {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error('Not a safetensors file (header is not JSON)');
  }
  const tensors: TensorInfo[] = [];
  const dtypeParams: Record<string, number> = {};
  let metadata: Record<string, unknown> = {};
  let totalParams = 0;
  let totalBytes = 0;
  for (const [name, value] of Object.entries(raw)) {
    if (name === '__metadata__') {
      metadata = (value ?? {}) as Record<string, unknown>;
      continue;
    }
    const t = value as { dtype?: string; shape?: number[]; data_offsets?: [number, number] };
    if (!t || typeof t.dtype !== 'string' || !Array.isArray(t.shape)) continue;
    const params = t.shape.reduce((a, b) => a * b, 1);
    const bytes = Array.isArray(t.data_offsets)
      ? t.data_offsets[1] - t.data_offsets[0]
      : params * (SAFETENSORS_DTYPE_BYTES[t.dtype] ?? 0);
    tensors.push({ name, dtype: t.dtype, shape: t.shape, params, bytes });
    dtypeParams[t.dtype] = (dtypeParams[t.dtype] ?? 0) + params;
    totalParams += params;
    totalBytes += bytes;
  }
  tensors.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { format: 'safetensors', tensors, totalParams, totalBytes, dtypeParams, metadata, headerBytes };
}

export async function inspectSafetensorsBlob(blob: Blob): Promise<WeightsSummary> {
  const n = readHeaderLength(await blob.slice(0, 8).arrayBuffer());
  if (8 + n > blob.size) throw new Error('Truncated safetensors file');
  const json = await blob.slice(8, 8 + n).text();
  return parseSafetensorsHeader(json, n);
}

/** Inspect remote safetensors using a byte-range reader (see hf.ts fetchRange). */
export async function inspectSafetensorsRemote(
  readRange: (start: number, endInclusive: number) => Promise<ArrayBuffer>,
): Promise<WeightsSummary> {
  const n = readHeaderLength(await readRange(0, 7));
  const buf = await readRange(8, 8 + n - 1);
  return parseSafetensorsHeader(new TextDecoder().decode(buf), n);
}

/** Merge per-shard summaries of a sharded checkpoint. */
export function mergeSummaries(parts: WeightsSummary[]): WeightsSummary {
  const dtypeParams: Record<string, number> = {};
  for (const p of parts) for (const [k, v] of Object.entries(p.dtypeParams)) dtypeParams[k] = (dtypeParams[k] ?? 0) + v;
  return {
    format: parts[0]?.format ?? 'safetensors',
    tensors: parts.flatMap((p) => p.tensors).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    totalParams: parts.reduce((s, p) => s + p.totalParams, 0),
    totalBytes: parts.reduce((s, p) => s + p.totalBytes, 0),
    dtypeParams,
    metadata: parts[0]?.metadata ?? {},
    headerBytes: parts.reduce((s, p) => s + p.headerBytes, 0),
  };
}
