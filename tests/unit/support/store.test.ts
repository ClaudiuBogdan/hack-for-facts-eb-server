import { describe, expect, it } from 'vitest';

import { makeKeyedStore } from '../../support/index.js';

interface Row {
  id: string;
  group: string;
  tags: string[];
  alias: string | null;
  nested: { count: number };
}

const row = (id: string, group: string, tags: string[] = []): Row => ({
  id,
  group,
  tags,
  alias: null,
  nested: { count: 1 },
});

const makeStore = () =>
  makeKeyedStore<string, Row>({
    keyOf: (value) => value.id,
    indexes: {
      byGroup: (value) => value.group,
      byTag: (value) => value.tags,
      byAlias: (value) => value.alias,
    },
  });

describe('makeKeyedStore', () => {
  it('clones on write, return, and read so callers cannot mutate stored values', () => {
    const store = makeStore();
    const input = row('one', 'alpha');
    const returned = store.put(input);

    input.nested.count = 10;
    returned.nested.count = 20;
    const firstRead = store.get('one');
    expect(firstRead?.nested.count).toBe(1);

    if (firstRead !== undefined) {
      firstRead.nested.count = 30;
    }
    expect(store.get('one')?.nested.count).toBe(1);
  });

  it('keeps list insertion order when an existing key is upserted', () => {
    const store = makeStore();
    store.put(row('one', 'old'));
    store.put(row('two', 'second'));
    store.put(row('one', 'updated'));

    expect(store.list().map((value) => `${value.id}:${value.group}`)).toEqual([
      'one:updated',
      'two:second',
    ]);
  });

  it('reindexes values after update and isolates the updater input', () => {
    const store = makeStore();
    store.put(row('one', 'old', ['first']));

    const updated = store.update('one', (current) => {
      current.group = 'new';
      current.tags.push('second');
      return current;
    });

    expect(updated?.group).toBe('new');
    expect(store.byIndex('byGroup', 'old')).toEqual([]);
    expect(store.byIndex('byGroup', 'new').map((value) => value.id)).toEqual(['one']);
    expect(store.byIndex('byTag', 'second').map((value) => value.id)).toEqual(['one']);
  });

  it('isolates values returned by list, byIndex, and update from the store', () => {
    const store = makeStore();
    store.put(row('one', 'alpha', ['first']));

    const [listed] = store.list();
    if (listed !== undefined) {
      listed.group = 'mutated-via-list';
      listed.tags.push('mutated');
    }
    expect(store.get('one')?.group).toBe('alpha');
    expect(store.get('one')?.tags).toEqual(['first']);

    const [indexed] = store.byIndex('byGroup', 'alpha');
    if (indexed !== undefined) {
      indexed.group = 'mutated-via-index';
    }
    expect(store.get('one')?.group).toBe('alpha');
    expect(store.byIndex('byGroup', 'alpha')).toHaveLength(1);

    const updated = store.update('one', (current) => ({ ...current, group: 'beta' }));
    if (updated !== undefined) {
      updated.group = 'mutated-via-update-result';
      updated.tags.push('mutated');
    }
    expect(store.get('one')?.group).toBe('beta');
    expect(store.get('one')?.tags).toEqual(['first']);
  });

  it('supports multi-valued and nullable indexes and rejects unknown names', () => {
    const store = makeStore();
    const first = row('one', 'alpha', ['shared', 'first']);
    const second = { ...row('two', 'beta', ['shared']), alias: 'secondary' };
    store.seed([first, second]);

    expect(store.byIndex('byTag', 'shared').map((value) => value.id)).toEqual(['one', 'two']);
    expect(store.byIndex('byAlias', 'secondary').map((value) => value.id)).toEqual(['two']);
    expect(store.byIndex('byAlias', 'missing')).toEqual([]);
    expect(() => store.byIndex('unknown', 'key')).toThrow('Unknown store index: unknown');
  });

  it('provides clone-safe query, snapshot, deletion, and clearing operations', () => {
    const store = makeStore();
    store.seed([row('one', 'alpha'), row('two', 'beta'), row('three', 'alpha')]);

    const filtered = store.filter((value) => value.group === 'alpha');
    const found = store.find((value) => value.id === 'two');
    const snapshot = store.snapshot();
    filtered[0]?.tags.push('mutated');
    found?.tags.push('mutated');
    snapshot[0]?.tags.push('mutated');

    expect(store.get('one')?.tags).toEqual([]);
    expect(store.get('two')?.tags).toEqual([]);
    expect(store.has('three')).toBe(true);
    expect(store.delete('three')).toBe(true);
    expect(store.delete('three')).toBe(false);
    expect(store.size()).toBe(2);
    store.clear();
    expect(store.list()).toEqual([]);
    expect(store.byIndex('byGroup', 'alpha')).toEqual([]);
  });

  it('uses an overridable clone for values structuredClone cannot copy', () => {
    interface RichValue {
      id: string;
      calculate(): number;
    }

    const store = makeKeyedStore<string, RichValue>({
      keyOf: (value) => value.id,
      clone: (value) => ({ ...value }),
    });
    store.put({ id: 'rich', calculate: () => 7 });

    expect(store.get('rich')?.calculate()).toBe(7);
  });
});
