/**
 * Inference worker: runs Transformers.js (ONNX Runtime Web) off the main
 * thread. Every network request it makes is checked against the same network
 * policy as the main thread and reported back for the activity log.
 */
import {
  AutoTokenizer,
  InterruptableStoppingCriteria,
  RawImage,
  TextStreamer,
  env,
  pipeline,
} from '@huggingface/transformers';
import { checkUrl, NetworkBlockedError, redactUrl, requestUrl, type NetPolicy } from '../lib/netPolicy';
import { pipelineKey, type LoadSpec, type LocalDevice, type WorkerConfig, type WorkerRequest, type WorkerResponse } from './protocol';

type AnyPipeline = ((...args: unknown[]) => Promise<unknown>) & {
  tokenizer?: unknown;
  dispose?: () => Promise<void>;
};

interface Tokenizer {
  encode(text: string): number[];
  decode(ids: number[], options?: { skip_special_tokens?: boolean }): string;
}

const scope = self as unknown as Worker;
function post(msg: WorkerResponse) {
  scope.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Network guard inside the worker

const nativeFetch = self.fetch.bind(self);
let policy: NetPolicy = { mode: 'allowlist', allowlist: [] };
let appOrigin = '';

async function workerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(requestUrl(input), self.location.href);
  const method = (init?.method ?? 'GET').toUpperCase();
  const base = { ts: Date.now(), initiator: 'local-inference', method, url: redactUrl(url), host: url.host };
  const verdict = checkUrl(url, policy, appOrigin);
  if (!verdict.allowed) {
    post({ type: 'net', entry: { ...base, blocked: true, error: verdict.reason } });
    throw new NetworkBlockedError(url.host, verdict.reason ?? 'blocked');
  }
  const started = performance.now();
  try {
    const res = await nativeFetch(input, { ...init, referrerPolicy: 'no-referrer', credentials: 'omit' });
    const length = Number(res.headers.get('content-length'));
    post({
      type: 'net',
      entry: {
        ...base,
        status: res.status,
        durationMs: Math.round(performance.now() - started),
        bytes: Number.isFinite(length) && length > 0 ? length : undefined,
      },
    });
    return res;
  } catch (err) {
    post({
      type: 'net',
      entry: { ...base, durationMs: Math.round(performance.now() - started), error: errorMessage(err) },
    });
    throw err;
  }
}

self.fetch = workerFetch as typeof fetch;

function applyConfig(config: WorkerConfig) {
  policy = config.policy;
  appOrigin = config.appOrigin;
  env.allowRemoteModels = config.allowRemoteModels;
  // Only probe the self-hosted model folder when remote downloads are off;
  // otherwise every load would first 404 against this site.
  env.allowLocalModels = !config.allowRemoteModels;
  env.localModelPath = config.localModelPath;
  env.remoteHost = config.remoteHost;
  env.useBrowserCache = true;
  env.useWasmCache = false;
  env.fetch = workerFetch;

  // Serve the ONNX Runtime WebAssembly from this site rather than a CDN.
  const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown } };
  if (onnx.wasm) {
    const ua = self.navigator.userAgent;
    const safariWithoutWebGPU = /^((?!chrome|android).)*safari/i.test(ua) && !('gpu' in self.navigator);
    const suffix = safariWithoutWebGPU ? '' : '.asyncify';
    onnx.wasm.wasmPaths = {
      mjs: `${config.ortBase}ort-wasm-simd-threaded${suffix}.mjs`,
      wasm: `${config.ortBase}ort-wasm-simd-threaded${suffix}.wasm`,
    };
  }
}

// ---------------------------------------------------------------------------
// Device + pipeline management

let webgpu: Promise<boolean> | null = null;

function hasWebGPU(): Promise<boolean> {
  if (!webgpu) {
    webgpu = (async () => {
      const gpu = (self.navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      if (!gpu) return false;
      try {
        return !!(await gpu.requestAdapter());
      } catch {
        return false;
      }
    })();
  }
  return webgpu;
}

async function resolveDevice(device: LocalDevice): Promise<'webgpu' | 'wasm'> {
  if (device === 'wasm') return 'wasm';
  if (device === 'webgpu') return 'webgpu';
  return (await hasWebGPU()) ? 'webgpu' : 'wasm';
}

const createPipeline = pipeline as unknown as (
  task: string,
  model: string,
  options: Record<string, unknown>,
) => Promise<AnyPipeline>;

const pipelines = new Map<string, Promise<{ pipe: AnyPipeline; device: string }>>();

function getPipeline(spec: LoadSpec, requestId: number) {
  const key = pipelineKey(spec);
  let entry = pipelines.get(key);
  if (!entry) {
    entry = (async () => {
      const device = await resolveDevice(spec.device);
      const options: Record<string, unknown> = {
        device,
        progress_callback: (info: Record<string, unknown>) =>
          post({
            type: 'progress',
            id: requestId,
            event: {
              status: String(info.status ?? ''),
              file: typeof info.file === 'string' ? info.file : undefined,
              progress: typeof info.progress === 'number' ? info.progress : undefined,
              loaded: typeof info.loaded === 'number' ? info.loaded : undefined,
              total: typeof info.total === 'number' ? info.total : undefined,
            },
          }),
      };
      if (spec.dtype && spec.dtype !== 'auto') options.dtype = spec.dtype;
      const pipe = await createPipeline(spec.task, spec.model, options);
      return { pipe, device };
    })();
    pipelines.set(key, entry);
    entry.catch(() => pipelines.delete(key));
  }
  return entry;
}

const tokenizers = new Map<string, Promise<Tokenizer>>();

function getTokenizer(model: string): Promise<Tokenizer> {
  let entry = tokenizers.get(model);
  if (!entry) {
    entry = AutoTokenizer.from_pretrained(model) as unknown as Promise<Tokenizer>;
    tokenizers.set(model, entry);
    entry.catch(() => tokenizers.delete(model));
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Output helpers

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Convert library outputs (Tensors, typed arrays, bigints) into structured-clone friendly data. */
function toPlain(value: unknown, depth = 0): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value == null || typeof value !== 'object') return value;
  if (depth > 8) return '[…]';
  if (value instanceof Blob) return value;
  const tensor = value as { tolist?: () => unknown; dims?: unknown; type?: unknown };
  if (typeof tensor.tolist === 'function' && Array.isArray(tensor.dims)) {
    return { dims: tensor.dims, type: tensor.type, data: toPlain(tensor.tolist(), depth + 1) };
  }
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<number | bigint>, (x) => Number(x));
  }
  if (Array.isArray(value)) return value.map((x) => toPlain(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = toPlain(v, depth + 1);
  return out;
}

function extractGenerated(out: unknown): string {
  let first: unknown = out;
  while (Array.isArray(first)) first = first[0];
  const generated = (first as { generated_text?: unknown } | undefined)?.generated_text;
  if (typeof generated === 'string') return generated;
  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1] as { content?: unknown } | undefined;
    return typeof last?.content === 'string' ? last.content : JSON.stringify(last);
  }
  return JSON.stringify(toPlain(out));
}

// ---------------------------------------------------------------------------
// Request handling

let activeStop: InterruptableStoppingCriteria | null = null;

async function run(req: Extract<WorkerRequest, { type: 'run' }>) {
  const { pipe, device } = await getPipeline(req.spec, req.id);
  const options = req.options ?? {};
  const started = performance.now();
  let data: unknown;

  switch (req.spec.task) {
    case 'text-generation': {
      const stop = new InterruptableStoppingCriteria();
      activeStop = stop;
      const streamer = new TextStreamer(pipe.tokenizer as never, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text: string) => post({ type: 'token', id: req.id, text }),
      });
      try {
        const out = await pipe(req.input, {
          max_new_tokens: 512,
          do_sample: false,
          ...options,
          streamer,
          stopping_criteria: stop,
        });
        data = extractGenerated(out);
      } finally {
        if (activeStop === stop) activeStop = null;
      }
      break;
    }
    case 'feature-extraction': {
      data = toPlain(await pipe(req.input, { pooling: 'mean', normalize: true, ...options }));
      break;
    }
    case 'zero-shot-classification': {
      const { text, labels } = req.input as { text: string; labels: string[] };
      data = toPlain(await pipe(text, labels, options));
      break;
    }
    case 'question-answering': {
      const { question, context } = req.input as { question: string; context: string };
      data = toPlain(await pipe(question, context, options));
      break;
    }
    case 'image-classification':
    case 'object-detection':
    case 'image-to-text': {
      const image = await RawImage.fromBlob(req.input as Blob);
      data = toPlain(await pipe(image, options));
      break;
    }
    default:
      data = toPlain(await pipe(req.input, options));
  }

  post({ type: 'result', id: req.id, data, device, ms: performance.now() - started });
}

async function unload(key?: string) {
  const keys = key ? [key] : [...pipelines.keys()];
  for (const k of keys) {
    const entry = pipelines.get(k);
    pipelines.delete(k);
    if (entry) {
      try {
        await (await entry).pipe.dispose?.();
      } catch {
        // ignore disposal failures
      }
    }
  }
  if (!key) tokenizers.clear();
}

async function handle(req: WorkerRequest) {
  try {
    switch (req.type) {
      case 'init':
        applyConfig(req.config);
        post({ type: 'result', id: req.id, data: { webgpu: await hasWebGPU() } });
        break;
      case 'load': {
        const { device } = await getPipeline(req.spec, req.id);
        post({ type: 'result', id: req.id, data: { device }, device });
        break;
      }
      case 'run':
        await run(req);
        break;
      case 'tokenize': {
        const tok = await getTokenizer(req.model);
        const ids = Array.from(tok.encode(req.text), (x) => Number(x));
        const pieces = ids.map((i) => tok.decode([i]));
        post({ type: 'result', id: req.id, data: { ids, pieces } });
        break;
      }
      case 'interrupt':
        activeStop?.interrupt();
        post({ type: 'result', id: req.id, data: null });
        break;
      case 'unload':
        await unload(req.key);
        post({ type: 'result', id: req.id, data: null });
        break;
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: errorMessage(err) });
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data);
});
