/**
 * Workspace backup and restore. A backup is one JSON file containing the
 * selected collections and settings. It can be encrypted with a passphrase.
 * API keys are only included as the vault's own encrypted envelope, and only
 * when the user opts in.
 */
import type { Collection, Entity } from '../lib/collection';
import { decryptString, encryptString, isEnvelope, type EncryptedEnvelope } from '../lib/crypto';
import { dbDestroy } from '../lib/db';
import { ALL_COLLECTIONS, type CollectionKey } from './collections';
import { getSettings, replaceSettings, type Settings } from './settings';
import { destroyVault, exportVaultEnvelope, importVaultEnvelope } from './vault';

export const WORKSPACE_FORMAT = 'ai-workbench/workspace';

export interface WorkspaceFile {
  format: typeof WORKSPACE_FORMAT;
  version: 1;
  exportedAt: string;
  settings?: Settings;
  collections: Partial<Record<CollectionKey, unknown[]>>;
  vault?: EncryptedEnvelope;
}

export interface EncryptedWorkspaceFile {
  format: typeof WORKSPACE_FORMAT;
  version: 1;
  encrypted: EncryptedEnvelope;
}

export interface ExportOptions {
  collections: CollectionKey[];
  includeSettings: boolean;
  includeVault: boolean;
  passphrase?: string;
}

export async function buildWorkspaceExport(opts: ExportOptions): Promise<WorkspaceFile | EncryptedWorkspaceFile> {
  const collections: WorkspaceFile['collections'] = {};
  for (const key of opts.collections) collections[key] = await ALL_COLLECTIONS[key].all();
  const file: WorkspaceFile = {
    format: WORKSPACE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    collections,
  };
  if (opts.includeSettings) file.settings = getSettings();
  if (opts.includeVault) {
    const env = await exportVaultEnvelope();
    if (env) file.vault = env;
  }
  if (!opts.passphrase) return file;
  return { format: WORKSPACE_FORMAT, version: 1, encrypted: await encryptString(opts.passphrase, JSON.stringify(file)) };
}

export function isEncryptedWorkspace(value: unknown): value is EncryptedWorkspaceFile {
  return !!value && typeof value === 'object' && isEnvelope((value as { encrypted?: unknown }).encrypted);
}

export async function parseWorkspaceFile(text: string, passphrase?: string): Promise<WorkspaceFile> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Not a JSON file.');
  }
  if (isEncryptedWorkspace(value)) {
    if (!passphrase) throw new Error('This backup is encrypted. Enter its passphrase.');
    value = JSON.parse(await decryptString(passphrase, value.encrypted));
  }
  const file = value as WorkspaceFile;
  if (file?.format !== WORKSPACE_FORMAT || !file.collections) throw new Error('Not an AI Workbench workspace file.');
  return file;
}

export interface ImportSummary {
  counts: Partial<Record<CollectionKey, number>>;
  settings: boolean;
  vault: boolean;
}

/** Merge (upsert by id) or replace collections from a parsed backup. */
export async function importWorkspace(
  file: WorkspaceFile,
  opts: { mode: 'merge' | 'replace'; importSettings: boolean; importVault: boolean },
): Promise<ImportSummary> {
  const summary: ImportSummary = { counts: {}, settings: false, vault: false };
  for (const [key, items] of Object.entries(file.collections) as [CollectionKey, unknown[]][]) {
    const collection = ALL_COLLECTIONS[key] as unknown as Collection<Entity> | undefined;
    if (!collection || !Array.isArray(items)) continue;
    const valid = items.filter((i): i is Entity => !!i && typeof (i as { id?: unknown }).id === 'string');
    if (opts.mode === 'replace') await collection.clear();
    await collection.putMany(valid);
    summary.counts[key] = valid.length;
  }
  if (opts.importSettings && file.settings) {
    replaceSettings(file.settings);
    summary.settings = true;
  }
  if (opts.importVault && file.vault && isEnvelope(file.vault)) {
    await importVaultEnvelope(file.vault);
    summary.vault = true;
  }
  return summary;
}

/** Permanently delete everything this app stores in the browser. */
export async function wipeAllData(): Promise<void> {
  await destroyVault();
  await dbDestroy();
  if ('caches' in globalThis) {
    for (const name of await caches.keys()) await caches.delete(name);
  }
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // storage may be unavailable
  }
}
