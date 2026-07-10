export type IndexKey = string | number;

export interface KeyedStoreOptions<K, V> {
  keyOf(value: V): K;
  /** Named secondary indexes. Return null to omit a value from an index. */
  indexes?: Record<string, (value: V) => IndexKey | IndexKey[] | null>;
  /** Clone applied on writes and reads. Defaults to structuredClone. */
  clone?(value: V): V;
}

export interface KeyedStore<K, V> {
  get(key: K): V | undefined;
  has(key: K): boolean;
  put(value: V): V;
  update(key: K, fn: (current: V) => V): V | undefined;
  delete(key: K): boolean;
  list(): V[];
  filter(pred: (value: V) => boolean): V[];
  find(pred: (value: V) => boolean): V | undefined;
  byIndex(name: string, key: IndexKey): V[];
  size(): number;
  clear(): void;
  seed(values: Iterable<V>): void;
  snapshot(): V[];
}

interface StoreIndex<K, V> {
  readonly indexOf: (value: V) => IndexKey | IndexKey[] | null;
  readonly primaryKeys: Map<IndexKey, Set<K>>;
}

const toIndexKeys = (value: IndexKey | IndexKey[] | null): readonly IndexKey[] => {
  if (value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

export function makeKeyedStore<K, V>(options: KeyedStoreOptions<K, V>): KeyedStore<K, V> {
  const clone = options.clone ?? ((value: V): V => structuredClone(value));
  const values = new Map<K, V>();
  const indexes = new Map<string, StoreIndex<K, V>>();

  for (const [name, indexOf] of Object.entries(options.indexes ?? {})) {
    indexes.set(name, { indexOf, primaryKeys: new Map() });
  }

  const addToIndexes = (key: K, value: V): void => {
    for (const index of indexes.values()) {
      for (const indexKey of toIndexKeys(index.indexOf(value))) {
        let primaryKeys = index.primaryKeys.get(indexKey);
        if (primaryKeys === undefined) {
          primaryKeys = new Set<K>();
          index.primaryKeys.set(indexKey, primaryKeys);
        }
        primaryKeys.add(key);
      }
    }
  };

  const removeFromIndexes = (key: K, value: V): void => {
    for (const index of indexes.values()) {
      for (const indexKey of toIndexKeys(index.indexOf(value))) {
        const primaryKeys = index.primaryKeys.get(indexKey);
        if (primaryKeys !== undefined) {
          primaryKeys.delete(key);
          if (primaryKeys.size === 0) {
            index.primaryKeys.delete(indexKey);
          }
        }
      }
    }
  };

  const put = (value: V): V => {
    const stored = clone(value);
    const key = options.keyOf(stored);

    if (values.has(key)) {
      removeFromIndexes(key, values.get(key) as V);
    }
    values.set(key, stored);
    addToIndexes(key, stored);
    return clone(stored);
  };

  const get = (key: K): V | undefined => {
    if (!values.has(key)) {
      return undefined;
    }
    return clone(values.get(key) as V);
  };

  const update = (key: K, fn: (current: V) => V): V | undefined => {
    if (!values.has(key)) {
      return undefined;
    }

    const current = values.get(key) as V;
    const next = clone(fn(clone(current)));
    const nextKey = options.keyOf(next);
    const keyIsUnchanged = new Set<K>([key]).has(nextKey);

    removeFromIndexes(key, current);
    if (keyIsUnchanged) {
      values.set(key, next);
    } else {
      values.delete(key);
      if (values.has(nextKey)) {
        removeFromIndexes(nextKey, values.get(nextKey) as V);
      }
      values.set(nextKey, next);
    }
    addToIndexes(nextKey, next);
    return clone(next);
  };

  const deleteValue = (key: K): boolean => {
    if (!values.has(key)) {
      return false;
    }
    removeFromIndexes(key, values.get(key) as V);
    return values.delete(key);
  };

  const list = (): V[] => [...values.values()].map((value) => clone(value));

  const filter = (pred: (value: V) => boolean): V[] => {
    const matches: V[] = [];
    for (const value of values.values()) {
      const candidate = clone(value);
      if (pred(candidate)) {
        matches.push(candidate);
      }
    }
    return matches;
  };

  const find = (pred: (value: V) => boolean): V | undefined => {
    for (const value of values.values()) {
      const candidate = clone(value);
      if (pred(candidate)) {
        return candidate;
      }
    }
    return undefined;
  };

  const byIndex = (name: string, key: IndexKey): V[] => {
    const index = indexes.get(name);
    if (index === undefined) {
      throw new Error(`Unknown store index: ${name}`);
    }

    const primaryKeys = index.primaryKeys.get(key);
    if (primaryKeys === undefined) {
      return [];
    }

    const matches: V[] = [];
    for (const [primaryKey, value] of values) {
      if (primaryKeys.has(primaryKey)) {
        matches.push(clone(value));
      }
    }
    return matches;
  };

  const clear = (): void => {
    values.clear();
    for (const index of indexes.values()) {
      index.primaryKeys.clear();
    }
  };

  const seed = (seedValues: Iterable<V>): void => {
    for (const value of seedValues) {
      put(value);
    }
  };

  return {
    get,
    has: (key: K): boolean => values.has(key),
    put,
    update,
    delete: deleteValue,
    list,
    filter,
    find,
    byIndex,
    size: (): number => values.size,
    clear,
    seed,
    snapshot: list,
  };
}
