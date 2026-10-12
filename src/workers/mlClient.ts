/** Main-thread client for the inference worker. */
import { getNetPolicy, recordNetEvent } from '../lib/net';
import { getSettings, settingsStore } from '../state/settings';
import type { LoadSpec, ProgressEvent, WorkerConfig, WorkerRequest, WorkerResponse } from './protocol';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ResultMessage = Extract<WorkerResponse, { type: 'result' }>;

interface Pending {
  resolve: (msg: ResultMessage) => void;
  reject: (err: Error) => void;
  onProgress?: (event: ProgressEvent) => void;
  onToken?: (text: string) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let ready: Promise<{ webgpu: boolean }> | null = null;

function buildConfig(): WorkerConfig {
  const s = getSettings();
  const base = new URL('./', document.baseURI).href;
  return {
    ortBase: new URL('ort/', base).href,
    allowRemoteModels: s.local.allowRemoteModels,
    localModelPath: new URL(s.local.localModelPath || './models/', base).href,
    remoteHost: s.hf.endpoint.replace(/\/?$/, '/'),
    policy: getNetPolicy(),
    appOrigin: location.origin,
  };
}

function handle(msg: WorkerResponse) {
  if (msg.type === 'net') {
    recordNetEvent(msg.entry);
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  switch (msg.type) {
    case 'progress':
      p.onProgress?.(msg.event);
      break;
    case 'token':
      p.onToken?.(msg.text);
      break;
    case 'result':
      pending.delete(msg.id);
      p.resolve(msg);
      break;
    case 'error':
      pending.delete(msg.id);
      p.reject(new Error(msg.message));
      break;
  }
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./ml.worker.ts', import.meta.url), { type: 'module', name: 'ml-worker' });
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => handle(ev.data);
    worker.onerror = (ev: ErrorEvent) => {
      const err = new Error(ev.message || 'The inference worker crashed (possibly out of memory).');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      worker?.terminate();
      worker = null;
      ready = null;
    };
  }
  return worker;
}

function send(msg: DistributiveOmit<WorkerRequest, 'id'>, handlers: Omit<Pending, 'resolve' | 'reject'> = {}): Promise<ResultMessage> {
  const id = nextId++;
  const w = getWorker();
  return new Promise<ResultMessage>((resolve, reject) => {
    pending.set(id, { resolve, reject, ...handlers });
    w.postMessage({ ...msg, id } as WorkerRequest);
  });
}

// Keep the worker's network policy and model settings in sync.
settingsStore.subscribe(() => {
  if (worker && ready) void send({ type: 'init', config: buildConfig() }).catch(() => undefined);
});

export function ensureReady(): Promise<{ webgpu: boolean }> {
  if (!ready) {
    ready = send({ type: 'init', config: buildConfig() }).then((m) => m.data as { webgpu: boolean });
    ready.catch(() => {
      ready = null;
    });
  }
  return ready;
}

export async function loadModel(spec: LoadSpec, onProgress?: (e: ProgressEvent) => void): Promise<{ device: string }> {
  await ensureReady();
  const msg = await send({ type: 'load', spec }, { onProgress });
  return { device: msg.device ?? 'unknown' };
}

export async function runModel<T = unknown>(
  spec: LoadSpec,
  input: unknown,
  options?: Record<string, unknown>,
  handlers: { onProgress?: (e: ProgressEvent) => void; onToken?: (t: string) => void } = {},
): Promise<{ data: T; device?: string; ms?: number }> {
  await ensureReady();
  const msg = await send({ type: 'run', spec, input, options }, handlers);
  return { data: msg.data as T, device: msg.device, ms: msg.ms };
}

export async function tokenize(model: string, text: string): Promise<{ ids: number[]; pieces: string[] }> {
  await ensureReady();
  const msg = await send({ type: 'tokenize', model, text });
  return msg.data as { ids: number[]; pieces: string[] };
}

export function interruptGeneration() {
  if (worker) void send({ type: 'interrupt' }).catch(() => undefined);
}

export async function unloadModels(key?: string) {
  if (!worker) return;
  await send({ type: 'unload', key });
}

/** Kill the worker outright, releasing all model memory (GPU + WASM heap). */
export function terminateWorker() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  ready = null;
  const err = new Error('Inference worker stopped.');
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

export function isWorkerRunning(): boolean {
  return worker !== null;
}

// ---------------------------------------------------------------------------
// Browser model cache (Cache API, managed by Transformers.js)

const CACHE_NAME = 'transformers-cache';

export async function modelCacheInfo(): Promise<{ entries: { url: string; bytes?: number }[]; bytes: number }> {
  if (!('caches' in globalThis)) return { entries: [], bytes: 0 };
  const cache = await caches.open(CACHE_NAME);
  const requests = await cache.keys();
  const entries: { url: string; bytes?: number }[] = [];
  let bytes = 0;
  for (const req of requests) {
    const res = await cache.match(req);
    const len = Number(res?.headers.get('content-length'));
    const size = Number.isFinite(len) && len > 0 ? len : undefined;
    if (size) bytes += size;
    entries.push({ url: req.url, bytes: size });
  }
  return { entries, bytes };
}

export async function clearModelCache(): Promise<void> {
  if ('caches' in globalThis) await caches.delete(CACHE_NAME);
}

/**
 * Import a Transformers.js model folder from disk (config.json, tokenizer
 * files, onnx/*.onnx). Files are written into the browser model cache under
 * the URLs Transformers.js would download them from, so the model loads with
 * no network access as `local/<name>`.
 */
export async function importModelFiles(files: File[], name: string): Promise<{ id: string; files: number; bytes: number }> {
  if (!('caches' in globalThis)) throw new Error('This browser does not support the Cache API.');
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'model';
  const id = `local/${slug}`;
  const host = getSettings().hf.endpoint.replace(/\/?$/, '/');
  const cache = await caches.open(CACHE_NAME);
  let count = 0;
  let bytes = 0;
  for (const file of files) {
    // webkitRelativePath is "<folder>/<path inside folder>"; drop the folder.
    const rel = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
    if (!rel || rel.split('/').some((part) => part.startsWith('.'))) continue;
    const headers = { 'content-type': file.type || 'application/octet-stream', 'content-length': String(file.size) };
    await cache.put(new Request(`${host}${id}/resolve/main/${rel}`), new Response(file, { headers }));
    count++;
    bytes += file.size;
  }
  if (!count) throw new Error('No model files found in the selected folder.');
  return { id, files: count, bytes };
}
