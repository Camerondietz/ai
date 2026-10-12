import { describe, expect, it } from 'vitest';
import { inspectGGUF, parseGGUF } from './gguf';

/** Build a tiny GGUF v3 header in memory. */
function buildGGUF(): ArrayBuffer {
  const parts: number[] = [];
  const u32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    parts.push(...b);
  };
  const u64 = (v: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    parts.push(...b);
  };
  const str = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    u64(bytes.length);
    parts.push(...bytes);
  };

  u32(0x46554747); // magic
  u32(3); // version
  u64(2); // tensor count
  u64(3); // kv count
  str('general.architecture');
  u32(8);
  str('llama');
  str('llama.context_length');
  u32(4);
  u32(4096);
  str('tokenizer.ggml.tokens');
  u32(9); // array
  u32(8); // of strings
  u64(20);
  for (let i = 0; i < 20; i++) str(`tok${i}`);
  // tensor 1: F32 [8, 4]
  str('token_embd.weight');
  u32(2);
  u64(4);
  u64(8);
  u32(0);
  u64(0);
  // tensor 2: Q4_0 [64]
  str('output.weight');
  u32(1);
  u64(64);
  u32(2);
  u64(128);
  return new Uint8Array(parts).buffer;
}

describe('GGUF', () => {
  it('parses metadata and tensors', () => {
    const info = parseGGUF(buildGGUF());
    expect(info.version).toBe(3);
    expect(info.architecture).toBe('llama');
    expect(info.metadata['llama.context_length']).toBe(4096);
    expect(info.metadata['tokenizer.ggml.tokens']).toMatchObject({ array: true, length: 20 });
    expect(info.tensors).toHaveLength(2);
    expect(info.tensors[0]).toMatchObject({ name: 'token_embd.weight', dtype: 'F32', shape: [8, 4], params: 32, bytes: 128 });
    expect(info.tensors[1]).toMatchObject({ dtype: 'Q4_0', params: 64, bytes: 36 });
    expect(info.totalParams).toBe(96);
  });

  it('retries with a larger prefix when the header is cut off', async () => {
    const full = buildGGUF();
    const sizes: number[] = [];
    const info = await inspectGGUF(
      async (n) => {
        sizes.push(n);
        return full.slice(0, n);
      },
      { initialBytes: 32 },
    );
    expect(info.tensors).toHaveLength(2);
    expect(sizes).toEqual([32, 128, 512]);
  });

  it('rejects other files', () => {
    expect(() => parseGGUF(new Uint8Array(16).buffer)).toThrow(/magic/);
  });
});
