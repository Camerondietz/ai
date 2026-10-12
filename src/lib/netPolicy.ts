/**
 * Pure network-policy logic, shared by the main thread and the inference
 * worker (so it must not import React or app state).
 */
export type NetMode = 'open' | 'allowlist' | 'local-only';

export interface NetPolicy {
  mode: NetMode;
  /** Host patterns: "api.example.com" (exact) or "*.example.com" (any subdomain). */
  allowlist: string[];
}

export interface NetLogEntry {
  id: number;
  ts: number;
  initiator: string;
  method: string;
  /** origin + path; query strings are never recorded */
  url: string;
  host: string;
  status?: number;
  durationMs?: number;
  bytes?: number;
  blocked?: boolean;
  error?: string;
}

export class NetworkBlockedError extends Error {
  constructor(
    readonly host: string,
    readonly reason: string,
  ) {
    super(`Blocked by network policy: ${host} (${reason})`);
    this.name = 'NetworkBlockedError';
  }
}

export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function hostMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) return host.endsWith(p.slice(1));
  return host === p;
}

export function checkUrl(url: URL, policy: NetPolicy, appOrigin: string): { allowed: boolean; reason?: string } {
  if (url.protocol === 'blob:' || url.protocol === 'data:') return { allowed: true };
  if (url.origin === appOrigin) return { allowed: true };
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { allowed: false, reason: `protocol ${url.protocol} not allowed` };
  }
  if (isLocalHost(url.hostname)) return { allowed: true };
  if (url.protocol === 'http:') return { allowed: false, reason: 'plain HTTP to remote hosts is blocked' };
  if (policy.mode === 'open') return { allowed: true };
  if (policy.mode === 'local-only') return { allowed: false, reason: 'local-only mode' };
  if (policy.allowlist.some((p) => hostMatches(url.hostname, p))) return { allowed: true };
  return { allowed: false, reason: 'host not in allowlist' };
}

export function redactUrl(url: URL): string {
  return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`;
}

export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
