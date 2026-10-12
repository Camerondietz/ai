import { describe, expect, it } from 'vitest';
import { inspectSafetensorsBlob, inspectSafetensorsRemote, readHeaderLength } from './safetensors';

function makeFile(header: Record<string, unknown>, dataBytes: number): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + json.length + dataBytes);
  new DataView(out.buffer).setBigUint64(0, BigInt(json.length), true);
  out.set(json, 8);
  return out;
}

const header = {
  __metadata__: { format: 'pt' },
  'model.embed.weight': { dtype: 'BF16', shape: [10, 4], data_offsets: [0, 80] },
  'model.norm.weight': { dtype: 'F32', shape: [4], data_offsets: [80, 96] },
};

describe('safetensors', () => {
  it('reads the header from a blob', async () => {
    const bytes = makeFile(header, 96);
    const s = await inspectSafetensorsBlob(new Blob([bytes]));
    expect(s.totalParams).toBe(44);
    expect(s.totalBytes).toBe(96);
    expect(s.dtypeParams).toEqual({ BF16: 40, F32: 4 });
    expect(s.metadata).toEqual({ format: 'pt' });
    expect(s.tensors.map((t) => t.name)).toEqual(['model.embed.weight', 'model.norm.weight']);
  });

  it('reads the header through range requests', async () => {
    const bytes = makeFile(header, 96);
    const ranges: [number, number][] = [];
    const s = await inspectSafetensorsRemote(async (start, end) => {
      ranges.push([start, end]);
      return bytes.slice(start, end + 1).buffer;
    });
    expect(s.totalParams).toBe(44);
    expect(ranges[0]).toEqual([0, 7]);
    expect(ranges).toHaveLength(2);
  });

  it('rejects non-safetensors input', () => {
    expect(() => readHeaderLength(new Uint8Array(8).buffer)).toThrow();
  });
});
