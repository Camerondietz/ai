/**
 * Minimal ONNX (protobuf) reader: model metadata, opsets, graph inputs and
 * outputs, initializer (weight) tensors and an operator histogram.
 * No protobuf library needed; only the fields we display are decoded.
 */
import type { TensorInfo, WeightsSummary } from './safetensors';

const ONNX_DTYPES: Record<number, [string, number]> = {
  1: ['float32', 4],
  2: ['uint8', 1],
  3: ['int8', 1],
  4: ['uint16', 2],
  5: ['int16', 2],
  6: ['int32', 4],
  7: ['int64', 8],
  8: ['string', 0],
  9: ['bool', 1],
  10: ['float16', 2],
  11: ['float64', 8],
  12: ['uint32', 4],
  13: ['uint64', 8],
  14: ['complex64', 8],
  15: ['complex128', 16],
  16: ['bfloat16', 2],
  17: ['float8e4m3fn', 1],
  18: ['float8e4m3fnuz', 1],
  19: ['float8e5m2', 1],
  20: ['float8e5m2fnuz', 1],
  21: ['uint4', 0.5],
  22: ['int4', 0.5],
  23: ['float4e2m1', 0.5],
};

class PB {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }
  eof() {
    return this.pos >= this.end;
  }
  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error('Truncated protobuf varint');
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
    throw new Error('Malformed protobuf varint');
  }
  tag(): [number, number] {
    const t = this.varint();
    return [Math.floor(t / 8), t & 7];
  }
  bytes(): [number, number] {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error('Truncated protobuf field');
    return [start, this.pos];
  }
  string(): string {
    const [s, e] = this.bytes();
    return new TextDecoder().decode(this.buf.subarray(s, e));
  }
  sub(): PB {
    const [s, e] = this.bytes();
    return new PB(this.buf, s, e);
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`Unsupported protobuf wire type ${wire}`);
  }
}

export interface OnnxValueInfo {
  name: string;
  dtype: string;
  shape: (number | string)[];
}

export interface OnnxInfo extends WeightsSummary {
  irVersion?: number;
  producer?: string;
  producerVersion?: string;
  opsets: { domain: string; version: number }[];
  inputs: OnnxValueInfo[];
  outputs: OnnxValueInfo[];
  ops: Record<string, number>;
  nodeCount: number;
  externalData: boolean;
}

function parseValueInfo(pb: PB): OnnxValueInfo {
  const info: OnnxValueInfo = { name: '', dtype: '?', shape: [] };
  while (!pb.eof()) {
    const [field, wire] = pb.tag();
    if (field === 1 && wire === 2) info.name = pb.string();
    else if (field === 2 && wire === 2) {
      // TypeProto
      const type = pb.sub();
      while (!type.eof()) {
        const [tf, tw] = type.tag();
        if (tf === 1 && tw === 2) {
          // TypeProto.Tensor
          const tensor = type.sub();
          while (!tensor.eof()) {
            const [f, w] = tensor.tag();
            if (f === 1 && w === 0) info.dtype = ONNX_DTYPES[tensor.varint()]?.[0] ?? 'unknown';
            else if (f === 2 && w === 2) {
              const shape = tensor.sub();
              while (!shape.eof()) {
                const [sf, sw] = shape.tag();
                if (sf === 1 && sw === 2) {
                  const dim = shape.sub();
                  let value: number | string = '?';
                  while (!dim.eof()) {
                    const [df, dw] = dim.tag();
                    if (df === 1 && dw === 0) value = dim.varint();
                    else if (df === 2 && dw === 2) value = dim.string();
                    else dim.skip(dw);
                  }
                  info.shape.push(value);
                } else shape.skip(sw);
              }
            } else tensor.skip(w);
          }
        } else type.skip(tw);
      }
    } else pb.skip(wire);
  }
  return info;
}

function parseInitializer(pb: PB): { tensor: TensorInfo; external: boolean } {
  const dims: number[] = [];
  let dataType = 0;
  let name = '';
  let external = false;
  while (!pb.eof()) {
    const [field, wire] = pb.tag();
    if (field === 1 && wire === 0) dims.push(pb.varint());
    else if (field === 1 && wire === 2) {
      const packed = pb.sub();
      while (!packed.eof()) dims.push(packed.varint());
    } else if (field === 2 && wire === 0) dataType = pb.varint();
    else if (field === 8 && wire === 2) name = pb.string();
    else if (field === 14 && wire === 0) external = pb.varint() === 1;
    else pb.skip(wire);
  }
  const [dtype, size] = ONNX_DTYPES[dataType] ?? [`type_${dataType}`, 0];
  const params = dims.reduce((a, b) => a * b, 1);
  return { tensor: { name, dtype, shape: dims, params, bytes: Math.round(params * size) }, external };
}

export function parseOnnx(data: ArrayBuffer | Uint8Array): OnnxInfo {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const model = new PB(buf);
  const info: OnnxInfo = {
    format: 'onnx',
    tensors: [],
    totalParams: 0,
    totalBytes: 0,
    dtypeParams: {},
    metadata: {},
    headerBytes: buf.length,
    opsets: [],
    inputs: [],
    outputs: [],
    ops: {},
    nodeCount: 0,
    externalData: false,
  };
  let sawGraph = false;

  while (!model.eof()) {
    const [field, wire] = model.tag();
    if (field === 1 && wire === 0) info.irVersion = model.varint();
    else if (field === 2 && wire === 2) info.producer = model.string();
    else if (field === 3 && wire === 2) info.producerVersion = model.string();
    else if (field === 8 && wire === 2) {
      const op = model.sub();
      const entry = { domain: '', version: 0 };
      while (!op.eof()) {
        const [f, w] = op.tag();
        if (f === 1 && w === 2) entry.domain = op.string();
        else if (f === 2 && w === 0) entry.version = op.varint();
        else op.skip(w);
      }
      info.opsets.push({ domain: entry.domain || 'ai.onnx', version: entry.version });
    } else if (field === 14 && wire === 2) {
      const kv = model.sub();
      let key = '';
      let value = '';
      while (!kv.eof()) {
        const [f, w] = kv.tag();
        if (f === 1 && w === 2) key = kv.string();
        else if (f === 2 && w === 2) value = kv.string();
        else kv.skip(w);
      }
      if (key) info.metadata[key] = value;
    } else if (field === 7 && wire === 2) {
      sawGraph = true;
      const graph = model.sub();
      while (!graph.eof()) {
        const [f, w] = graph.tag();
        if (f === 1 && w === 2) {
          const node = graph.sub();
          let opType = '?';
          let domain = '';
          while (!node.eof()) {
            const [nf, nw] = node.tag();
            if (nf === 4 && nw === 2) opType = node.string();
            else if (nf === 7 && nw === 2) domain = node.string();
            else node.skip(nw);
          }
          const key = domain && domain !== 'ai.onnx' ? `${domain}.${opType}` : opType;
          info.ops[key] = (info.ops[key] ?? 0) + 1;
          info.nodeCount++;
        } else if (f === 2 && w === 2) info.metadata['graph.name'] = graph.string();
        else if (f === 5 && w === 2) {
          const { tensor, external } = parseInitializer(graph.sub());
          if (external) info.externalData = true;
          info.tensors.push(tensor);
          info.totalParams += tensor.params;
          info.totalBytes += tensor.bytes;
          info.dtypeParams[tensor.dtype] = (info.dtypeParams[tensor.dtype] ?? 0) + tensor.params;
        } else if (f === 11 && w === 2) info.inputs.push(parseValueInfo(graph.sub()));
        else if (f === 12 && w === 2) info.outputs.push(parseValueInfo(graph.sub()));
        else graph.skip(w);
      }
    } else model.skip(wire);
  }

  if (!sawGraph) throw new Error('Not an ONNX model (no graph found)');
  // Graph inputs often repeat initializers in older exports; keep real inputs only.
  const initNames = new Set(info.tensors.map((t) => t.name));
  info.inputs = info.inputs.filter((i) => !initNames.has(i.name));
  return info;
}

export async function inspectOnnxBlob(blob: Blob): Promise<OnnxInfo> {
  if (blob.size > 2 * 1024 * 1024 * 1024) {
    throw new Error('ONNX files over 2 GB must use external data; inspect the small .onnx graph file instead.');
  }
  return parseOnnx(await blob.arrayBuffer());
}
