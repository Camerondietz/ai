/**
 * Hugging Face Hub REST client (read side). Uses the public Hub API and the
 * dataset viewer API; the user's token is attached only for the configured
 * Hugging Face hosts.
 */
import { HF_TOKEN_SECRET } from '../providers/presets';
import { httpError } from '../providers/types';
import { getSettings } from '../state/settings';
import type { Row } from '../state/types';
import { getSecret } from '../state/vault';
import { inspectGGUF, type GGUFInfo } from './gguf';
import { guardedFetch } from './net';
import { parseOnnx, type OnnxInfo } from './onnx';
import { inspectSafetensorsRemote, mergeSummaries, type WeightsSummary } from './safetensors';

export type RepoType = 'model' | 'dataset' | 'space';

export function hubUrl(): string {
  return getSettings().hf.endpoint.replace(/\/+$/, '');
}

function datasetsServer(): string {
  return getSettings().hf.datasetsServer.replace(/\/+$/, '');
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function authHeaders(url: string): Record<string, string> {
  const token = getSecret(HF_TOKEN_SECRET);
  if (!token) return {};
  const host = new URL(url).hostname;
  const trusted = [new URL(hubUrl()).hostname, new URL(datasetsServer()).hostname];
  return trusted.includes(host) ? { Authorization: `Bearer ${token}` } : {};
}

async function hfGet(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await guardedFetch(url, { headers: { ...authHeaders(url), ...headers } }, 'huggingface');
  if (!res.ok) throw await httpError(res);
  return res;
}

export async function hfJSON<T>(url: string): Promise<T> {
  return (await (await hfGet(url)).json()) as T;
}

export function repoPrefix(type: RepoType): string {
  return type === 'dataset' ? 'datasets/' : type === 'space' ? 'spaces/' : '';
}

export function repoPageUrl(type: RepoType, id: string): string {
  return `${hubUrl()}/${repoPrefix(type)}${id}`;
}

export function resolveUrl(type: RepoType, id: string, path: string, revision = 'main'): string {
  return `${hubUrl()}/${repoPrefix(type)}${encodePath(id)}/resolve/${encodeURIComponent(revision)}/${encodePath(path)}`;
}

// ---------------------------------------------------------------------------
// Search + repo info

export interface HFRepoSummary {
  id: string;
  likes?: number;
  downloads?: number;
  pipeline_tag?: string;
  library_name?: string;
  tags?: string[];
  createdAt?: string;
  lastModified?: string;
  private?: boolean;
  gated?: boolean | string;
  trendingScore?: number;
  description?: string;
}

export interface HFRepoInfo extends HFRepoSummary {
  sha?: string;
  author?: string;
  siblings?: { rfilename: string }[];
  cardData?: Record<string, unknown>;
  config?: Record<string, unknown>;
  safetensors?: { parameters?: Record<string, number>; total?: number };
  gguf?: { total?: number; architecture?: string; context_length?: number };
}

export interface SearchParams {
  search?: string;
  author?: string;
  pipelineTag?: string;
  library?: string;
  filter?: string;
  sort?: 'downloads' | 'likes' | 'trendingScore' | 'lastModified' | 'createdAt';
  limit?: number;
}

export async function searchRepos(type: 'model' | 'dataset', p: SearchParams): Promise<HFRepoSummary[]> {
  const url = new URL(`${hubUrl()}/api/${type}s`);
  if (p.search) url.searchParams.set('search', p.search);
  if (p.author) url.searchParams.set('author', p.author);
  if (type === 'model' && p.pipelineTag) url.searchParams.set('pipeline_tag', p.pipelineTag);
  if (type === 'model' && p.library) url.searchParams.set('library', p.library);
  if (p.filter) url.searchParams.set('filter', p.filter);
  url.searchParams.set('sort', p.sort ?? 'downloads');
  url.searchParams.set('direction', '-1');
  url.searchParams.set('limit', String(p.limit ?? 30));
  return hfJSON<HFRepoSummary[]>(url.href);
}

export function repoInfo(type: RepoType, id: string): Promise<HFRepoInfo> {
  return hfJSON<HFRepoInfo>(`${hubUrl()}/api/${type}s/${encodePath(id)}`);
}

export interface TreeEntry {
  type: 'file' | 'directory';
  path: string;
  size?: number;
  lfs?: { size?: number; oid?: string };
}

export function repoTree(type: RepoType, id: string, revision = 'main'): Promise<TreeEntry[]> {
  return hfJSON<TreeEntry[]>(
    `${hubUrl()}/api/${type}s/${encodePath(id)}/tree/${encodeURIComponent(revision)}?recursive=true&expand=false`,
  );
}

export async function fetchRepoText(type: RepoType, id: string, path: string, revision = 'main'): Promise<string> {
  const res = await hfGet(resolveUrl(type, id, path, revision));
  return (await res.text()).slice(0, 2_000_000);
}

export async function fetchRepoJSON<T>(type: RepoType, id: string, path: string, revision = 'main'): Promise<T> {
  return JSON.parse(await fetchRepoText(type, id, path, revision)) as T;
}

export interface WhoAmI {
  name: string;
  fullname?: string;
  type?: string;
  orgs?: { name: string }[];
  auth?: { accessToken?: { displayName?: string; role?: string } };
}

export function whoAmI(): Promise<WhoAmI> {
  return hfJSON<WhoAmI>(`${hubUrl()}/api/whoami-v2`);
}

// ---------------------------------------------------------------------------
// Byte ranges (inspect weights without downloading them)

async function readPrefix(res: Response, n: number): Promise<ArrayBuffer> {
  if (!res.body) return (await res.arrayBuffer()).slice(0, n);
  const reader = res.body.getReader();
  const out = new Uint8Array(n);
  let offset = 0;
  while (offset < n) {
    const { value, done } = await reader.read();
    if (done) break;
    const take = Math.min(value.length, n - offset);
    out.set(value.subarray(0, take), offset);
    offset += take;
  }
  await reader.cancel().catch(() => undefined);
  return out.slice(0, offset).buffer;
}

export async function fetchRange(url: string, start: number, endInclusive: number): Promise<ArrayBuffer> {
  const res = await guardedFetch(
    url,
    { headers: { ...authHeaders(url), Range: `bytes=${start}-${endInclusive}` } },
    'huggingface',
  );
  if (!res.ok) throw await httpError(res);
  if (res.status === 206) return res.arrayBuffer();
  // The server ignored the Range header: read only what we need, then stop.
  if (start !== 0) throw new Error('Server does not support HTTP range requests');
  return readPrefix(res, endInclusive + 1);
}

export async function inspectRemoteSafetensors(
  id: string,
  revision = 'main',
  onProgress?: (done: number, total: number) => void,
): Promise<WeightsSummary & { shards: string[] }> {
  const info = await repoInfo('model', id);
  const files = info.siblings?.map((s) => s.rfilename) ?? [];
  let shards: string[];
  const index = files.includes('model.safetensors.index.json')
    ? 'model.safetensors.index.json'
    : files.find((f) => f.endsWith('.safetensors.index.json'));
  if (files.includes('model.safetensors')) {
    shards = ['model.safetensors'];
  } else if (index) {
    const idx = await fetchRepoJSON<{ weight_map: Record<string, string> }>('model', id, index, revision);
    const dir = index.includes('/') ? index.slice(0, index.lastIndexOf('/') + 1) : '';
    shards = [...new Set(Object.values(idx.weight_map))].map((f) => dir + f);
  } else {
    shards = files.filter((f) => f.endsWith('.safetensors'));
  }
  if (!shards.length) throw new Error('No .safetensors weights found in this repo (try a .gguf or .onnx file instead).');
  if (shards.length > 200) throw new Error(`Too many shards (${shards.length}) to inspect.`);

  const parts: WeightsSummary[] = [];
  let done = 0;
  const queue = [...shards];
  const worker = async () => {
    for (let shard = queue.shift(); shard; shard = queue.shift()) {
      const url = resolveUrl('model', id, shard, revision);
      parts.push(await inspectSafetensorsRemote((s, e) => fetchRange(url, s, e)));
      onProgress?.(++done, shards.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, shards.length) }, worker));
  return { ...mergeSummaries(parts), shards };
}

export function inspectRemoteGGUF(id: string, file: string, revision = 'main'): Promise<GGUFInfo> {
  const url = resolveUrl('model', id, file, revision);
  return inspectGGUF((n) => fetchRange(url, 0, n - 1));
}

export async function inspectRemoteOnnx(id: string, file: string, revision = 'main'): Promise<OnnxInfo> {
  const res = await hfGet(resolveUrl('model', id, file, revision));
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > 300 * 1024 * 1024) {
    await res.body?.cancel();
    throw new Error('This ONNX graph embeds its weights (>300 MB). Download it and inspect the file locally instead.');
  }
  return parseOnnx(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Dataset viewer API (rows from any public or accessible dataset)

export async function datasetSplits(dataset: string): Promise<{ config: string; split: string }[]> {
  const json = await hfJSON<{ splits: { config: string; split: string }[] }>(
    `${datasetsServer()}/splits?dataset=${encodeURIComponent(dataset)}`,
  );
  return json.splits ?? [];
}

interface RowsPage {
  features: { name: string }[];
  rows: { row_idx: number; row: Row }[];
  num_rows_total: number;
}

export async function fetchDatasetRows(
  dataset: string,
  config: string,
  split: string,
  limit: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ columns: string[]; rows: Row[]; total: number }> {
  const rows: Row[] = [];
  let columns: string[] = [];
  let total = 0;
  for (let offset = 0; offset < limit; offset += 100) {
    const url = new URL(`${datasetsServer()}/rows`);
    url.searchParams.set('dataset', dataset);
    url.searchParams.set('config', config);
    url.searchParams.set('split', split);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('length', String(Math.min(100, limit - offset)));
    const page = await hfJSON<RowsPage>(url.href);
    if (!columns.length) columns = page.features.map((f) => f.name);
    total = page.num_rows_total;
    rows.push(...page.rows.map((r) => r.row));
    onProgress?.(rows.length, Math.min(limit, total));
    if (page.rows.length < 100 || rows.length >= total) break;
  }
  return { columns, rows, total };
}
