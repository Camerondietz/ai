/**
 * Network guard: every outbound request made by the app goes through
 * guardedFetch(), which enforces the user's network policy and records a
 * metadata-only log entry (no headers, no bodies, no query strings).
 *
 * installFetchGuard() also wraps window.fetch so third-party library code is
 * subject to the same policy.
 */
import { createStore, useStore } from './store';
import { checkUrl, NetworkBlockedError, redactUrl, requestUrl, type NetLogEntry, type NetPolicy } from './netPolicy';

export * from './netPolicy';

let policy: NetPolicy = { mode: 'allowlist', allowlist: [] };

export function setNetPolicy(next: NetPolicy) {
  policy = next;
}

export function getNetPolicy(): NetPolicy {
  return policy;
}

// ---------------------------------------------------------------------------
// In-memory request log (never persisted)

const MAX_LOG = 1000;
let nextId = 1;
export const netLog = createStore<NetLogEntry[]>([]);

function pushLog(entry: Omit<NetLogEntry, 'id'>): number {
  const id = nextId++;
  netLog.set((prev) => {
    const next = [...prev, { ...entry, id }];
    return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next;
  });
  return id;
}

function patchLog(id: number, patch: Partial<NetLogEntry>) {
  netLog.set((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
}

/** Record an entry produced elsewhere (e.g. inside the inference worker). */
export function recordNetEvent(entry: Omit<NetLogEntry, 'id'>) {
  pushLog(entry);
}

export function clearNetLog() {
  netLog.set([]);
}

export function useNetLog(): NetLogEntry[] {
  return useStore(netLog);
}

// ---------------------------------------------------------------------------
// Fetch wrappers

const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export async function guardedFetch(input: RequestInfo | URL, init: RequestInit | undefined, initiator: string): Promise<Response> {
  const url = new URL(requestUrl(input), globalThis.location?.href);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const base = { ts: Date.now(), initiator, method, url: redactUrl(url), host: url.host };
  const appOrigin = globalThis.location?.origin ?? '';

  const verdict = checkUrl(url, policy, appOrigin);
  if (!verdict.allowed) {
    pushLog({ ...base, blocked: true, error: verdict.reason });
    throw new NetworkBlockedError(url.host, verdict.reason ?? 'blocked');
  }

  const id = pushLog(base);
  const started = performance.now();
  try {
    const res = await nativeFetch(input, {
      ...init,
      // Never leak the page URL or cookies to third-party APIs.
      referrerPolicy: 'no-referrer',
      credentials: url.origin === appOrigin ? init?.credentials : 'omit',
    });
    const length = Number(res.headers.get('content-length'));
    patchLog(id, {
      status: res.status,
      durationMs: Math.round(performance.now() - started),
      bytes: Number.isFinite(length) && length > 0 ? length : undefined,
    });
    return res;
  } catch (err) {
    patchLog(id, {
      durationMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** A fetch-compatible function bound to an initiator label (for SDKs that accept a custom fetch). */
export function makeFetch(initiator: string): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => guardedFetch(input, init, initiator)) as typeof fetch;
}

let installed = false;

/** Route every window.fetch call through the guard (defense in depth). */
export function installFetchGuard() {
  if (installed) return;
  installed = true;
  globalThis.fetch = makeFetch('other');
}
