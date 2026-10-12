/**
 * Secret storage for API keys and tokens.
 *
 * States:
 *  - none:     no vault exists yet and no secrets are held
 *  - session:  secrets held in memory only; they vanish on reload (default)
 *  - locked:   an encrypted vault exists on disk; secrets are not in memory
 *  - unlocked: vault decrypted into memory; changes are re-encrypted to disk
 *
 * Secrets never leave this module except via getSecret() at request time,
 * are never written to the workspace export unless encrypted, and are never
 * logged.
 */
import { dbDelete, dbGet, dbPut } from '../lib/db';
import {
  decryptWithKey,
  deriveKey,
  encryptWithKey,
  fromBase64,
  isEnvelope,
  PBKDF2_ITERATIONS,
  randomBytes,
  type EncryptedEnvelope,
} from '../lib/crypto';
import { createStore, useStore } from '../lib/store';

export type VaultStatus = 'none' | 'session' | 'locked' | 'unlocked';

export interface VaultState {
  status: VaultStatus;
  /** ids of secrets currently available (values are never exposed here) */
  ids: string[];
}

const VAULT_KEY = 'vault';
export const MIN_PASSPHRASE_LENGTH = 10;

export class VaultLockedError extends Error {
  constructor() {
    super('The vault is locked. Unlock it to use stored API keys.');
    this.name = 'VaultLockedError';
  }
}

let secrets: Record<string, string> = {};
let key: CryptoKey | null = null;
let salt: Uint8Array<ArrayBuffer> | null = null;
let iterations = PBKDF2_ITERATIONS;

export const vaultStore = createStore<VaultState>({ status: 'none', ids: [] });

function publish(status: VaultStatus) {
  vaultStore.set({ status, ids: Object.keys(secrets).sort() });
}

export function useVault(): VaultState {
  return useStore(vaultStore);
}

export async function initVault(): Promise<void> {
  const env = await dbGet<unknown>('kv', VAULT_KEY);
  publish(isEnvelope(env) ? 'locked' : 'none');
}

async function persist() {
  if (!key || !salt) return;
  const env = await encryptWithKey(key, salt, iterations, JSON.stringify(secrets));
  await dbPut('kv', env, VAULT_KEY);
}

/** Create an encrypted vault, carrying over any session secrets. */
export async function createVault(passphrase: string): Promise<void> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  salt = randomBytes(16);
  iterations = PBKDF2_ITERATIONS;
  key = await deriveKey(passphrase, salt, iterations);
  await persist();
  publish('unlocked');
}

export async function unlockVault(passphrase: string): Promise<void> {
  const env = await dbGet<unknown>('kv', VAULT_KEY);
  if (!isEnvelope(env)) throw new Error('No vault found.');
  const s = fromBase64(env.salt);
  const k = await deriveKey(passphrase, s, env.iterations);
  const plain = await decryptWithKey(k, env); // throws on wrong passphrase
  secrets = JSON.parse(plain) as Record<string, string>;
  key = k;
  salt = s;
  iterations = env.iterations;
  publish('unlocked');
}

export function lockVault() {
  const status = vaultStore.get().status;
  secrets = {};
  key = null;
  salt = null;
  publish(status === 'unlocked' ? 'locked' : status === 'session' ? 'none' : status);
}

export async function changePassphrase(current: string, next: string): Promise<void> {
  if (next.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  await unlockVault(current);
  await createVault(next);
}

/** Delete the encrypted vault from disk and forget all secrets. */
export async function destroyVault(): Promise<void> {
  await dbDelete('kv', VAULT_KEY);
  secrets = {};
  key = null;
  salt = null;
  publish('none');
}

export function getSecret(id: string): string | undefined {
  return secrets[id];
}

export function hasSecret(id: string | undefined): boolean {
  return !!id && !!secrets[id];
}

export async function setSecret(id: string, value: string): Promise<void> {
  const status = vaultStore.get().status;
  if (status === 'locked') throw new VaultLockedError();
  const trimmed = value.trim();
  if (!trimmed) return removeSecret(id);
  secrets = { ...secrets, [id]: trimmed };
  if (status === 'unlocked') {
    await persist();
    publish('unlocked');
  } else {
    publish('session');
  }
}

export async function removeSecret(id: string): Promise<void> {
  const status = vaultStore.get().status;
  if (status === 'locked') throw new VaultLockedError();
  const { [id]: _removed, ...rest } = secrets;
  secrets = rest;
  if (status === 'unlocked') {
    await persist();
    publish('unlocked');
  } else {
    publish(Object.keys(secrets).length ? 'session' : 'none');
  }
}

/** The raw encrypted envelope, for inclusion in an (already encrypted) workspace backup. */
export async function exportVaultEnvelope(): Promise<EncryptedEnvelope | null> {
  const env = await dbGet<unknown>('kv', VAULT_KEY);
  return isEnvelope(env) ? env : null;
}

export async function importVaultEnvelope(env: EncryptedEnvelope): Promise<void> {
  await dbPut('kv', env, VAULT_KEY);
  secrets = {};
  key = null;
  salt = null;
  publish('locked');
}
