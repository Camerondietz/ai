import { useSyncExternalStore } from 'react';
import { dbBulkPut, dbClear, dbDelete, dbGetAll, dbPut, type DataStoreName } from './db';

export interface Entity {
  id: string;
}

export interface CollectionState<T> {
  items: T[];
  loaded: boolean;
  error?: string;
}

/**
 * An IndexedDB object store mirrored in memory and observable from React.
 * Loads lazily on first subscription; every write goes to disk first.
 */
export class Collection<T extends Entity> {
  private state: CollectionState<T> = { items: [], loaded: false };
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;

  constructor(
    readonly store: DataStoreName,
    private readonly sort?: (a: T, b: T) => number,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    void this.load();
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): CollectionState<T> => this.state;

  private emit(next: CollectionState<T>) {
    this.state = next;
    this.listeners.forEach((l) => l());
  }

  private setItems(items: T[]) {
    const sorted = this.sort ? [...items].sort(this.sort) : items;
    this.emit({ ...this.state, items: sorted, loaded: true });
  }

  load(): Promise<void> {
    if (!this.loading) {
      this.loading = dbGetAll<T>(this.store).then(
        (items) => this.setItems(items),
        (err: unknown) => this.emit({ items: [], loaded: true, error: String(err) }),
      );
    }
    return this.loading;
  }

  /** Forget cached state (after a wipe or import) and reload from disk. */
  async reload(): Promise<void> {
    this.loading = null;
    this.emit({ items: [], loaded: false });
    await this.load();
  }

  async all(): Promise<T[]> {
    await this.load();
    return this.state.items;
  }

  get(id: string): T | undefined {
    return this.state.items.find((item) => item.id === id);
  }

  async put(item: T): Promise<void> {
    await this.load();
    await dbPut(this.store, item);
    this.setItems([...this.state.items.filter((i) => i.id !== item.id), item]);
  }

  async putMany(items: T[]): Promise<void> {
    await this.load();
    await dbBulkPut(this.store, items);
    const byId = new Map(this.state.items.map((i) => [i.id, i] as const));
    for (const item of items) byId.set(item.id, item);
    this.setItems([...byId.values()]);
  }

  async remove(id: string): Promise<void> {
    await this.load();
    await dbDelete(this.store, id);
    this.setItems(this.state.items.filter((i) => i.id !== id));
  }

  async clear(): Promise<void> {
    await dbClear(this.store);
    this.setItems([]);
  }
}

export function useCollection<T extends Entity>(collection: Collection<T>): CollectionState<T> {
  return useSyncExternalStore(collection.subscribe, collection.getState, collection.getState);
}
