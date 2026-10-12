import { describe, expect, it } from 'vitest';
import { parseOnnx } from './onnx';

// Tiny protobuf encoder for building test fixtures.
const enc = new TextEncoder();
function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
const vField = (f: number, v: number) => [...varint(f * 8), ...varint(v)];
const bField = (f: number, bytes: number[]) => [...varint(f * 8 + 2), ...varint(bytes.length), ...bytes];
const sField = (f: number, s: string) => bField(f, [...enc.encode(s)]);

function valueInfo(name: string, dims: (number | string)[]) {
  const shape = dims.flatMap((d) => bField(1, typeof d === 'number' ? vField(1, d) : sField(2, d)));
  const tensorType = [...vField(1, 1), ...bField(2, shape)];
  return [...sField(1, name), ...bField(2, bField(1, tensorType))];
}

function buildModel(): Uint8Array {
  const node = (op: string) => bField(1, sField(4, op));
  const initializer = bField(5, [...bField(1, [...varint(4), ...varint(3)]), ...vField(2, 1), ...sField(8, 'W')]);
  const graph = [
    ...node('MatMul'),
    ...node('MatMul'),
    ...node('Add'),
    ...sField(2, 'main_graph'),
    ...initializer,
    ...bField(11, valueInfo('x', ['batch', 4])),
    ...bField(11, valueInfo('W', [4, 3])),
    ...bField(12, valueInfo('y', ['batch', 3])),
  ];
  return new Uint8Array([
    ...vField(1, 8),
    ...sField(2, 'pytorch'),
    ...bField(8, [...sField(1, ''), ...vField(2, 17)]),
    ...bField(7, graph),
    ...bField(14, [...sField(1, 'author'), ...sField(2, 'me')]),
  ]);
}

describe('ONNX', () => {
  it('reads model structure', () => {
    const info = parseOnnx(buildModel());
    expect(info.irVersion).toBe(8);
    expect(info.producer).toBe('pytorch');
    expect(info.opsets).toEqual([{ domain: 'ai.onnx', version: 17 }]);
    expect(info.ops).toEqual({ MatMul: 2, Add: 1 });
    expect(info.nodeCount).toBe(3);
    expect(info.tensors[0]).toMatchObject({ name: 'W', dtype: 'float32', shape: [4, 3], params: 12, bytes: 48 });
    expect(info.inputs).toEqual([{ name: 'x', dtype: 'float32', shape: ['batch', 4] }]);
    expect(info.outputs[0].shape).toEqual(['batch', 3]);
    expect(info.metadata).toMatchObject({ author: 'me', 'graph.name': 'main_graph' });
  });

  it('rejects non-ONNX data', () => {
    expect(() => parseOnnx(new Uint8Array([8, 1]))).toThrow(/no graph/);
  });
});
