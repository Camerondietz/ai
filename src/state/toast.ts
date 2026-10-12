import { createStore, useStore } from '../lib/store';

export type ToastKind = 'info' | 'success' | 'error' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: { label: string; run: () => void };
}

let nextId = 1;
export const toastStore = createStore<Toast[]>([]);

export function toast(message: string, kind: ToastKind = 'info', action?: Toast['action'], ttlMs?: number) {
  const id = nextId++;
  toastStore.set((prev) => [...prev.slice(-4), { id, kind, message, action }]);
  const ttl = ttlMs ?? (kind === 'error' ? 9000 : action ? 8000 : 4000);
  setTimeout(() => dismissToast(id), ttl);
}

export function toastError(err: unknown, prefix?: string) {
  const message = err instanceof Error ? err.message : String(err);
  toast(prefix ? `${prefix}: ${message}` : message, 'error');
}

export function dismissToast(id: number) {
  toastStore.set((prev) => prev.filter((t) => t.id !== id));
}

export function useToasts(): Toast[] {
  return useStore(toastStore);
}
