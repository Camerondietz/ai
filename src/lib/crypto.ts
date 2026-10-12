/**
 * Passphrase-based encryption using only the browser's WebCrypto API.
 *
 * - Key derivation: PBKDF2-SHA256, 600,000 iterations (OWASP 2023 guidance),
 *   random 16-byte salt.
 * - Cipher: AES-256-GCM with a fresh random 12-byte IV per encryption.
 *   GCM authenticates the ciphertext, so tampering or a wrong passphrase fails
 *   loudly instead of producing garbage.
 * - Derived keys are created non-extractable: script code can use them but
 *   cannot read the raw key bytes back out.
 */
export const PBKDF2_ITERATIONS = 600_000;

export interface EncryptedEnvelope {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  /** base64 */
  salt: string;
  /** base64 */
  iv: string;
  /** base64 ciphertext + GCM tag */
  ct: string;
}

type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 bytes backed by a plain ArrayBuffer (what WebCrypto's BufferSource expects). */
function utf8(text: string): Bytes {
  return new Uint8Array(encoder.encode(text));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Bytes {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function deriveKey(passphrase: string, salt: Bytes, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', utf8(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptWithKey(
  key: CryptoKey,
  salt: Bytes,
  iterations: number,
  plaintext: string,
): Promise<EncryptedEnvelope> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(plaintext)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations, salt: toBase64(salt), iv: toBase64(iv), ct: toBase64(ct) };
}

export async function decryptWithKey(key: CryptoKey, envelope: EncryptedEnvelope): Promise<string> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.iv) },
      key,
      fromBase64(envelope.ct),
    );
    return decoder.decode(plain);
  } catch {
    throw new Error('Decryption failed: wrong passphrase or corrupted data.');
  }
}

export async function encryptString(passphrase: string, plaintext: string, iterations = PBKDF2_ITERATIONS): Promise<EncryptedEnvelope> {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, iterations);
  return encryptWithKey(key, salt, iterations, plaintext);
}

export async function decryptString(passphrase: string, envelope: EncryptedEnvelope): Promise<string> {
  const key = await deriveKey(passphrase, fromBase64(envelope.salt), envelope.iterations);
  return decryptWithKey(key, envelope);
}

export function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    v.kdf === 'PBKDF2-SHA256' &&
    typeof v.iterations === 'number' &&
    typeof v.salt === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.ct === 'string'
  );
}

/** SHA-256 hex digest, e.g. for fingerprinting files. */
export async function sha256Hex(data: ArrayBuffer | Bytes): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Rough passphrase strength estimate in bits (length × character-class pool). */
export function passphraseBits(passphrase: string): number {
  let pool = 0;
  if (/[a-z]/.test(passphrase)) pool += 26;
  if (/[A-Z]/.test(passphrase)) pool += 26;
  if (/[0-9]/.test(passphrase)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(passphrase)) pool += 33;
  return pool ? Math.round(passphrase.length * Math.log2(pool)) : 0;
}
