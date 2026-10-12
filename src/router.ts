/**
 * Hash-based routing (#/chat/123). Works on static hosts like GitHub Pages
 * without server rewrites.
 */
import { useSyncExternalStore } from 'react';

export interface Route {
  /** path segments, e.g. ["chat", "abc"] */
  segments: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  return {
    segments: path.split('/').filter(Boolean).map(decodeURIComponent),
    query: new URLSearchParams(qs),
  };
}

let current = parse();
const listeners = new Set<() => void>();

window.addEventListener('hashchange', () => {
  current = parse();
  listeners.forEach((l) => l());
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => current);
}

export function href(path: string, query?: Record<string, string | undefined>): string {
  const qs = query
    ? new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined)).toString()
    : '';
  return `#/${path.replace(/^\/+/, '')}${qs ? `?${qs}` : ''}`;
}

export function navigate(path: string, query?: Record<string, string | undefined>) {
  location.hash = href(path, query);
}
