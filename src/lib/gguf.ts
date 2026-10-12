/**
 * GGUF (llama.cpp) header reader: metadata key/values and tensor infos.
 * Reads progressively larger prefixes until the header fits, so large model
 * files never need to be loaded in full.
 */
import type { TensorInfo, WeightsSummary } from './safetensors';

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

enum ValueType {
  UINT8 = 0,
  INT8 = 1,
  UINT16 = 2,
  INT16 = 3,
  UINT32 = 4,
  INT32 = 5,
  FLOAT32 = 6,
  BOOL = 7,
  STRING = 8,
  ARRAY = 9,
  UINT64 = 10,
  INT64 = 11,
  FLOAT64 = 12,
}

/** ggml tensor types: [name, bytes per block, elements per block] */
const GGML_TYPES: Record<number, [string, number, number]> = {
  0: ['F32', 4, 1],
  1: ['F16', 2, 1],
  2: ['Q4_0', 18, 32],
  3: ['Q4_1', 20, 32],
  6: ['Q5_0', 22, 32],
  7: ['Q5_1', 24, 32],
  8: ['Q8_0', 34, 32],
  9: ['Q8_1', 36, 32],
  10: ['Q2_K', 84, 256],
  11: ['Q3_K', 110, 256],
  12: ['Q4_K', 144, 256],
  13: ['Q5_K', 176, 256],
  14: ['Q6_K', 210, 256],
  15: ['Q8_K', 292, 256],
  16: ['IQ2_XXS', 66, 256],
  17: ['IQ2_XS', 74, 256],
  18: ['IQ3_XXS', 98, 256],
  19: ['IQ1_S', 50, 256],
  20: ['IQ4_NL', 18, 32],
  21: ['IQ3_S', 110, 256],
  22: ['IQ2_S', 82, 256],
  23: ['IQ4_XS', 136, 256],
  24: ['I8', 1, 1],
  25: ['I16', 2, 1],
  26: ['I32', 4, 1],
  27: ['I64', 8, 1],
  28: ['F64', 8, 1],
  29: ['IQ1_M', 56, 256],
  30: ['BF16', 2, 1],
  34: ['TQ1_0', 54, 256],
  35: ['TQ2_0', 66, 256],
  39: ['MXFP4', 17, 32],
};

export class NeedMoreDataError extends Error {
  constructor() {
    super('GGUF header extends beyond the bytes read');
  }
}

class Reader {
  private view: DataView;
  pos = 0;
  private decoder = new TextDecoder();
  constructor(private buf: ArrayBuffer) {
    this.view = new DataView(buf);
  }
  private need(n: number) {
    if (this.pos + n > this.buf.byteLength) throw new NeedMoreDataError();
  }
  u8() {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  i8() {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }
  u16() {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16() {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32() {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  u64() {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return Number(v);
  }
  i64() {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return Number(v);
  }
  string() {
    const len = this.u64();
    if (len > 64 * 1024 * 1024) throw new Error('Corrupt GGUF string length');
    this.need(len);
    const s = this.decoder.decode(new Uint8Array(this.buf, this.pos, len));
    this.pos += len;
    return s;
  }
}

function readValue(r: Reader, type: number): unknown {
  switch (type) {
    case ValueType.UINT8:
      return r.u8();
    case ValueType.INT8:
      return r.i8();
    case ValueType.UINT16:
      return r.u16();
    case ValueType.INT16:
      return r.i16();
    case ValueType.UINT32:
      return r.u32();
    case ValueType.INT32:
      return r.i32();
    case ValueType.FLOAT32:
      return r.f32();
    case ValueType.BOOL:
      return r.u8() !== 0;
    case ValueType.STRING:
      return r.string();
    case ValueType.UINT64:
      return r.u64();
    case ValueType.INT64:
      return r.i64();
    case ValueType.FLOAT64:
      return r.f64();
    case ValueType.ARRAY: {
      const itemType = r.u32();
      const len = r.u64();
      const preview: unknown[] = [];
      for (let i = 0; i < len; i++) {
        const v = readValue(r, itemType);
        if (i < 16) preview.push(v);
      }
      // Large arrays (tokenizer vocabularies) are summarized, not kept.
      return len <= 16 ? preview : { array: true, length: len, preview };
    }
    default:
      throw new Error(`Unknown GGUF value type ${type}`);
  }
}

export interface GGUFInfo extends WeightsSummary {
  version: number;
  architecture?: string;
}

export function parseGGUF(buf: ArrayBuffer): GGUFInfo {
  const r = new Reader(buf);
  if (r.u32() !== GGUF_MAGIC) throw new Error('Not a GGUF file (bad magic)');
  const version = r.u32();
  if (version < 2 || version > 3) throw new Error(`Unsupported GGUF version ${version}`);
  const tensorCount = r.u64();
  const kvCount = r.u64();

  const metadata: Record<string, unknown> = {};
  for (let i = 0; i < kvCount; i++) {
    const key = r.string();
    const type = r.u32();
    metadata[key] = readValue(r, type);
  }

  const tensors: TensorInfo[] = [];
  const dtypeParams: Record<string, number> = {};
  let totalParams = 0;
  let totalBytes = 0;
  for (let i = 0; i < tensorCount; i++) {
    const name = r.string();
    const nDims = r.u32();
    const shape: number[] = [];
    for (let d = 0; d < nDims; d++) shape.push(r.u64());
    const typeId = r.u32();
    r.u64(); // data offset
    const [dtype, blockBytes, blockSize] = GGML_TYPES[typeId] ?? [`type_${typeId}`, 0, 1];
    const params = shape.reduce((a, b) => a * b, 1);
    const bytes = Math.round((params / blockSize) * blockBytes);
    // GGUF lists dims fastest-varying first; show them PyTorch-style.
    tensors.push({ name, dtype, shape: [...shape].reverse(), params, bytes });
    dtypeParams[dtype] = (dtypeParams[dtype] ?? 0) + params;
    totalParams += params;
    totalBytes += bytes;
  }

  return {
    format: 'gguf',
    version,
    architecture: typeof metadata['general.architecture'] === 'string' ? (metadata['general.architecture'] as string) : undefined,
    tensors,
    totalParams,
    totalBytes,
    dtypeParams,
    metadata,
    headerBytes: r.pos,
  };
}

/** Parse using a prefix reader, doubling the prefix until the header fits. */
export async function inspectGGUF(
  readPrefix: (bytes: number) => Promise<ArrayBuffer>,
  { initialBytes = 4 * 1024 * 1024, maxBytes = 512 * 1024 * 1024 }: { initialBytes?: number; maxBytes?: number } = {},
): Promise<GGUFInfo> {
  let size = initialBytes;
  for (;;) {
    const buf = await readPrefix(size);
    try {
      return parseGGUF(buf);
    } catch (err) {
      const exhausted = buf.byteLength < size; // file is shorter than requested
      if (!(err instanceof NeedMoreDataError) || exhausted || size >= maxBytes) throw err;
      size *= 4;
    }
  }
}

export function inspectGGUFBlob(blob: Blob): Promise<GGUFInfo> {
  return inspectGGUF(async (n) => blob.slice(0, Math.min(n, blob.size)).arrayBuffer());
}

/** Pull the most useful facts out of GGUF metadata for display. */
export function ggufHighlights(info: GGUFInfo): Record<string, unknown> {
  const m = info.metadata;
  const arch = info.architecture ?? '';
  const pick = (k: string) => m[k];
  return {
    name: pick('general.name'),
    architecture: arch,
    'file type': pick('general.file_type'),
    'context length': pick(`${arch}.context_length`),
    'embedding length': pick(`${arch}.embedding_length`),
    layers: pick(`${arch}.block_count`),
    'attention heads': pick(`${arch}.attention.head_count`),
    'kv heads': pick(`${arch}.attention.head_count_kv`),
    'tokenizer': pick('tokenizer.ggml.model'),
    license: pick('general.license'),
  };
}
