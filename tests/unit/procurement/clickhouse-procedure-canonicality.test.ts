/**
 * Procedure canonicality (P36) is read from ONE published build's own
 * ClickHouse procedure table: the build the Postgres pointer names, resolved
 * once by the caller. A prepared, unpublished build is never read, and every
 * unknown stays unknown. SQL semantics (aliases, NULL handling, privacy) are
 * proven on a real ClickHouse in
 * `tests/integration/procurement/procedure-canonicality-clickhouse.ch.test.ts`.
 */

import { err, ok } from 'neverthrow';
import { afterEach, describe, expect, it } from 'vitest';

import {
  makeClickhouseAnalysisRepo,
  makeUnconfiguredAnalysisRepo,
  PROCEDURE_CANONICALITY_BATCH,
  PROCEDURE_DUPLICATES_CAP,
} from '@/modules/procurement/shell/repo/clickhouse-analysis-repo.js';
import { databaseError } from '@/modules/shared/index.js';

import { compactResponse } from './clickhouse-response.js';

import type { PublishedGeneration } from '@/modules/procurement/core/ports.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** One public procedure row as ClickHouse answers it. */
interface Answer {
  readonly id: string;
  readonly source: string;
  readonly canonical: boolean;
  readonly group: string | null;
}

const row = (id: string, source: string, canonical: boolean, group: string | null): Answer => ({
  id,
  source,
  canonical,
  group,
});

/** Active build 16: the CAN1160189 witness and the other shapes rule A leaves. */
const B16: readonly Answer[] = [
  // A native notice heading its rule-A group, and the SEAP award linked to it.
  row('347436', 'elicitatie', true, '347436'),
  row('573731', 'seap_notice', false, '347436'),
  // An ungrouped native, and a SEAP notice left canonical because its number
  // matches two native notices (ambiguous: rule A links none).
  row('900001', 'elicitatie', true, null),
  row('900002', 'seap_notice', true, null),
  // An older SEAP sibling group.
  row('800001', 'seap_notice', true, '800001'),
  row('800002', 'seap_notice', false, '800001'),
];

/** Prepared build 17, not published: different answers expose a wrong read. */
const B17: readonly Answer[] = [
  row('347436', 'elicitatie', true, null),
  row('573731', 'seap_notice', true, null),
];

const DEFAULT_TABLES: Readonly<Record<string, readonly Answer[]>> = {
  facts_procedures_v2_b16: B16,
  facts_procedures_v2_b17: B17,
  // Build 8 is the retained legacy snapshot: unsuffixed tables.
  facts_procedures_v2: [row('573731', 'seap_notice', true, null)],
};

const published = (buildId: string): PublishedGeneration => ({
  buildId,
  publishedAt: '2026-10-18T01:05:57Z',
  quality: {},
  matrixHash: null,
});

/** The table every reference in the statement names; a mixed read fails. */
const tableOf = (sql: string): string | undefined => {
  const names = new Set(
    [...sql.matchAll(/FROM (facts_procedures_v2(?:_b[0-9]+)?) /gu)].map((m) => m[1])
  );
  return names.size === 1 ? [...names][0] : undefined;
};

/** Answers the canonicality statement from fixtures (ids of the outer IN list). */
const canonicalityAnswer = (sql: string, rows: readonly Answer[]): Response => {
  const lists = [...sql.matchAll(/procedure_id IN \(([0-9, ]+)\)/gu)].map((m) => m[1]);
  const ids = new Set(lists.at(-1)?.split(', ') ?? []);
  return compactResponse(
    rows
      .filter((r) => ids.has(r.id))
      .map((r) => ({ id: r.id, canonical: r.canonical, group_id: r.group })),
    ['id', 'canonical', 'group_id']
  );
};

/** Answers the group statement: the procedure first, then its group by id. */
const groupAnswer = (
  sql: string,
  rows: readonly Answer[],
  mutate: (out: Answer[]) => Answer[] = (out) => out
): Response => {
  const anchor = /\(procedure_id = ([0-9]+) OR/u.exec(sql)?.[1];
  const limit = Number(/LIMIT ([0-9]+) FORMAT JSONCompact$/u.exec(sql)?.[1]);
  const self = rows.filter((r) => r.id === anchor);
  const group = self[0]?.group ?? null;
  const others = rows
    .filter((r) => r.id !== anchor && group !== null && r.group === group)
    .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
  return compactResponse(
    mutate([...self, ...others])
      .slice(0, limit)
      .map((r) => ({ id: r.id, source: r.source, group_id: r.group })),
    ['id', 'source', 'group_id']
  );
};

function harness(
  options: {
    active?: string | null;
    tables?: Readonly<Record<string, readonly Answer[]>>;
    respond?: (sql: string) => Response | undefined;
    mutateGroup?: (out: Answer[]) => Answer[];
  } = {}
) {
  const queries: string[] = [];
  const tables = options.tables ?? DEFAULT_TABLES;
  globalThis.fetch = (_url, init) => {
    const sql = typeof init?.body === 'string' ? init.body : '';
    queries.push(sql);
    const custom = options.respond?.(sql);
    if (custom !== undefined) return Promise.resolve(custom);
    const name = tableOf(sql);
    const rows = name === undefined ? undefined : tables[name];
    if (rows === undefined) return Promise.resolve(new Response('Unknown table', { status: 404 }));
    return Promise.resolve(
      sql.includes('source_system AS source')
        ? groupAnswer(sql, rows, options.mutateGroup)
        : canonicalityAnswer(sql, rows)
    );
  };
  const active = options.active === undefined ? '16' : options.active;
  const repo = makeClickhouseAnalysisRepo({ url: 'http://ch.invalid', database: 'proto' }, () =>
    Promise.resolve(ok(active === null ? null : published(active)))
  );
  return { repo, queries };
}

describe('procedureCanonicalityBuild', () => {
  it('names the published build without touching ClickHouse', async () => {
    const { repo, queries } = harness({ active: '16' });
    expect((await repo.procedureCanonicalityBuild())._unsafeUnwrap()).toBe('16');
    const unpublished = harness({ active: null });
    expect((await unpublished.repo.procedureCanonicalityBuild())._unsafeUnwrap()).toBeNull();
    expect([...queries, ...unpublished.queries]).toEqual([]);
  });

  it('propagates a pointer read failure', async () => {
    globalThis.fetch = () => Promise.reject(new Error('must not be called'));
    const repo = makeClickhouseAnalysisRepo({ url: 'http://ch.invalid', database: 'proto' }, () =>
      Promise.resolve(err(databaseError('pointer read failed')))
    );
    expect((await repo.procedureCanonicalityBuild()).isErr()).toBe(true);
  });
});

describe('procedureCanonicality', () => {
  it('reads the named build table only, never a prepared one', async () => {
    const { repo, queries } = harness();
    const read = await repo.procedureCanonicality('16', ['573731', '347436', '900001', '900002']);
    expect(read._unsafeUnwrap()).toEqual(
      new Map([
        ['347436', { isCanonical: true, dupGroupId: '347436' }],
        ['573731', { isCanonical: false, dupGroupId: '347436' }],
        ['900001', { isCanonical: true, dupGroupId: null }],
        ['900002', { isCanonical: true, dupGroupId: null }],
      ])
    );
    expect(queries).toHaveLength(1);
    expect(tableOf(queries[0] ?? '')).toBe('facts_procedures_v2_b16');
    expect(queries.join('\n')).not.toContain('_b17');
    // Public procedures only, and a group target only when it is public too.
    expect(queries[0]).toContain("WHERE privacy_class = 'public' AND procedure_id IN");
    expect(queries[0]).toContain("AND privacy_class = 'public' FORMAT JSONCompact");
  });

  it('reads whichever build the caller pinned, legacy build 8 included', async () => {
    const { repo, queries } = harness();
    expect((await repo.procedureCanonicality('17', ['573731']))._unsafeUnwrap()).toEqual(
      new Map([['573731', { isCanonical: true, dupGroupId: null }]])
    );
    expect((await repo.procedureCanonicality('8', ['573731']))._unsafeUnwrap()).toEqual(
      new Map([['573731', { isCanonical: true, dupGroupId: null }]])
    );
    expect(queries.map(tableOf)).toEqual(['facts_procedures_v2_b17', 'facts_procedures_v2']);
  });

  it('refuses an invalid build id before any query', async () => {
    const { repo, queries } = harness();
    for (const build of ['0', 'x', '16; DROP', '9223372036854775808']) {
      expect((await repo.procedureCanonicality(build, ['573731'])).isErr()).toBe(true);
      expect((await repo.procedureDuplicates(build, '573731')).isErr()).toBe(true);
    }
    expect(queries).toEqual([]);
  });

  it('leaves a procedure the build does not hold out of the answer', async () => {
    const { repo } = harness();
    const read = (await repo.procedureCanonicality('16', ['573731', '999999']))._unsafeUnwrap();
    expect(read.has('999999')).toBe(false);
    expect(read.size).toBe(1);
  });

  it('never interpolates anything but a bigint id', async () => {
    const { repo, queries } = harness();
    const read = await repo.procedureCanonicality('16', [
      '1) OR (1',
      '0',
      '-5',
      '9223372036854775808',
      '573731',
      '573731',
    ]);
    expect([...read._unsafeUnwrap().keys()]).toEqual(['573731']);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('WHERE procedure_id IN (573731) AND dup_group_id IS NOT NULL');
    expect(queries[0]).toContain(
      "FROM facts_procedures_v2_b16 WHERE procedure_id IN (573731) AND privacy_class = 'public'"
    );
  });

  it('splits a large request into bounded statements', async () => {
    const { repo, queries } = harness();
    const ids = Array.from({ length: PROCEDURE_CANONICALITY_BATCH + 1 }, (_, i) => String(i + 1));
    expect((await repo.procedureCanonicality('16', ids)).isOk()).toBe(true);
    expect(queries).toHaveLength(2);
  });

  it('fails on a backend error, a missing table or a repeated row', async () => {
    const failing = harness({ respond: () => new Response('boom', { status: 500 }) });
    expect((await failing.repo.procedureCanonicality('16', ['573731'])).isErr()).toBe(true);

    const missing = harness({ tables: { facts_procedures_v2_b15: B16 } });
    expect((await missing.repo.procedureCanonicality('16', ['573731'])).isErr()).toBe(true);

    const repeated = harness({
      tables: { facts_procedures_v2_b16: [...B16, row('573731', 'seap_notice', true, null)] },
    });
    const read = await repeated.repo.procedureCanonicality('16', ['573731']);
    expect(read._unsafeUnwrapErr().message).toContain('not unique');
  });
});

describe('procedureDuplicates', () => {
  it('lists the rest of the group from the pinned build, the procedure excluded', async () => {
    const { repo, queries } = harness();
    expect((await repo.procedureDuplicates('16', '573731'))._unsafeUnwrap()).toEqual([
      { sourceSystem: 'elicitatie', id: '347436' },
    ]);
    expect((await repo.procedureDuplicates('16', '347436'))._unsafeUnwrap()).toEqual([
      { sourceSystem: 'seap_notice', id: '573731' },
    ]);
    expect((await repo.procedureDuplicates('16', '800002'))._unsafeUnwrap()).toEqual([
      { sourceSystem: 'seap_notice', id: '800001' },
    ]);
    // One statement per procedure, both references on the pinned table.
    for (const sql of queries) {
      expect(sql.match(/facts_procedures_v2_b16 /gu)).toHaveLength(2);
      expect(sql).toContain("WHERE privacy_class = 'public' AND (procedure_id =");
    }
  });

  it('answers [] for an ungrouped procedure and null for one the build lacks', async () => {
    const { repo, queries } = harness();
    expect((await repo.procedureDuplicates('16', '900002'))._unsafeUnwrap()).toEqual([]);
    expect((await repo.procedureDuplicates('16', '999999'))._unsafeUnwrap()).toBeNull();
    expect((await repo.procedureDuplicates('17', '573731'))._unsafeUnwrap()).toEqual([]);
    expect(queries.map(tableOf)).toEqual([
      'facts_procedures_v2_b16',
      'facts_procedures_v2_b16',
      'facts_procedures_v2_b17',
    ]);
  });

  it('answers null without a query for an invalid id', async () => {
    const { repo, queries } = harness();
    expect((await repo.procedureDuplicates('16', '1 OR 1=1'))._unsafeUnwrap()).toBeNull();
    expect(queries).toEqual([]);
  });

  it('caps the list', async () => {
    const big = [
      row('1000', 'elicitatie', true, '1000'),
      ...Array.from({ length: PROCEDURE_DUPLICATES_CAP + 5 }, (_, i) =>
        row(String(2000 + i), 'seap_notice', false, '1000')
      ),
    ];
    const { repo } = harness({ tables: { facts_procedures_v2_b16: big } });
    const list = (await repo.procedureDuplicates('16', '1000'))._unsafeUnwrap();
    expect(list).toHaveLength(PROCEDURE_DUPLICATES_CAP);
    expect(list?.[0]).toEqual({ sourceSystem: 'seap_notice', id: '2000' });
  });

  it('fails on a repeated procedure or a member of another group', async () => {
    const repeated = harness({ mutateGroup: (out) => [...out.slice(0, 1), ...out] });
    expect((await repeated.repo.procedureDuplicates('16', '573731')).isErr()).toBe(true);
    const foreign = harness({
      mutateGroup: (out) => [...out, row('800002', 'seap_notice', false, '800001')],
    });
    expect((await foreign.repo.procedureDuplicates('16', '573731')).isErr()).toBe(true);
  });
});

describe('without a ClickHouse backend', () => {
  it('fails every read explicitly', async () => {
    const repo = makeUnconfiguredAnalysisRepo();
    expect((await repo.procedureCanonicalityBuild())._unsafeUnwrapErr().message).toContain(
      'not configured'
    );
    expect((await repo.procedureCanonicality('16', ['573731'])).isErr()).toBe(true);
    expect((await repo.procedureDuplicates('16', '573731')).isErr()).toBe(true);
  });
});
