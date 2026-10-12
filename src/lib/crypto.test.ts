import { describe, expect, it } from 'vitest';
import { decryptString, encryptString, fromBase64, isEnvelope, passphraseBits, toBase64 } from './crypto';

describe('crypto', () => {
  it('round-trips base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('encrypts and decrypts with the right passphrase', async () => {
    const env = await encryptString('correct horse battery staple', 'secret payload ✓', 1000);
    expect(isEnvelope(env)).toBe(true);
    expect(env.ct).not.toContain('secret');
    await expect(decryptString('correct horse battery staple', env)).resolves.toBe('secret payload ✓');
  });

  it('rejects the wrong passphrase', async () => {
    const env = await encryptString('right-passphrase', 'data', 1000);
    await expect(decryptString('wrong-passphrase', env)).rejects.toThrow(/wrong passphrase/);
  });

  it('uses a fresh salt and IV each time', async () => {
    const a = await encryptString('pw', 'same', 1000);
    const b = await encryptString('pw', 'same', 1000);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('estimates passphrase strength', () => {
    expect(passphraseBits('')).toBe(0);
    expect(passphraseBits('aaaa')).toBeLessThan(passphraseBits('aA1!aA1!aA1!'));
  });
});
