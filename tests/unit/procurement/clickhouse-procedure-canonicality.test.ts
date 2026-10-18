/**
 * Procedure canonicality (P36) is read from the ACTIVE generation's own
 * ClickHouse procedure table: the Postgres pointer picks the build, a prepared
 * but unpublished build is never read, and every unknown stays unknown.
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

interface FactRow {
  readonly procedure_id: string;
  readonly source_system: string;
  readonly is_canonical: boolean;
  readonly dup_group_id: string | null;
}

const row = (
  procedureId: string,
  sourceSystem: string,
  isCanonical: boolean,
  dupGroupId: string | null
): FactRow => ({
  procedure_id: procedureId,
  source_system: sourceSystem,
  is_canonical: isCanonical,
  dup_group_id: dupGroupId,
});

/** Active build 16: the CAN1160189 witness and the other shapes rule A leaves. */
const B16: readonly FactRow[] = [
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
const B17: readonly FactRow[] = [
  row('347436', 'elicitatie', true, null),
  row('573731', 'seap_notice', true, null),
];

const published = (buildId: string): PublishedGeneration => ({
  buildId,
  publishedAt: '2026-10-18T01:05:57Z',
  quality: {},
  matrixHash: null,
});

const tableRows = (sql: string, tables: Readonly<Record<string, readonly FactRow[]>>) => {
  const name = /FROM (facts_procedures_v2_b[0-9]+)/u.exec(sql)?.[1];
  return name === undefined ? undefined : tables[name];
};

/** Answers the canonicality statement the way ClickHouse would, from fixtures. */
function harness(
  options: {
    active?: string | null;
    tables?: Readonly<Record<string, readonly FactRow[]>>;
    respond?: (sql: string) => Response | undefined;
  } = {}
) {
  const queries: string[] = [];
  const tables = options.tables ?? {
    facts_procedures_v2_b16: B16,
    facts_procedures_v2_b17: B17,
  };
  globalThis.fetch = (_url, init) => {
    const sql = typeof init?.body === 'string' ? init.body : '';
    queries.push(sql);
    const custom = options.respond?.(sql);
    if (custom !== undefined) return Promise.resolve(custom);
    const rows = tableRows(sql, tables);
    if (rows === undefined) return Promise.resolve(new Response('Unknown table', { status: 404 }));
    const ids = new Set(/IN \(([0-9, ]+)\)/u.exec(sql)?.[1]?.split(', ') ?? []);
    return Promise.resolve(
      compactResponse(
        rows
          .filter((r) => ids.has(r.procedure_id))
          .map((r) => ({
            id: r.procedure_id,
            canonical: r.is_canonical,
            group_id: r.dup_group_id,
          })),
        ['id', 'canonical', 'group_id']
      )
    );
  };
  const active = options.active === undefined ? '16' : options.active;
  const repo = makeClickhouseAnalysisRepo({ url: 'http://ch.invalid', database: 'proto' }, () =>
    Promise.resolve(ok(active === null ? null : published(active)))
  );
  return { repo, queries };
}

describe('procedureCanonicality', () => {
  it('reads the active build table only, never a prepared one', async () => {
    const { repo, queries } = harness();
    const read = await repo.procedureCanonicality(['573731', '347436', '900001', '900002']);
    expect(read._unsafeUnwrap()).toEqual(
      new Map([
        ['347436', { isCanonical: true, dupGroupId: '347436' }],
        ['573731', { isCanonical: false, dupGroupId: '347436' }],
        ['900001', { isCanonical: true, dupGroupId: null }],
        ['900002', { isCanonical: true, dupGroupId: null }],
      ])
    );
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('FROM facts_procedures_v2_b16 ');
    expect(queries.join('\n')).not.toContain('_b17');
  });

  it('follows the pointer when it moves', async () => {
    const { repo, queries } = harness({ active: '17' });
    const read = await repo.procedureCanonicality(['573731']);
    expect(read._unsafeUnwrap()?.get('573731')).toEqual({ isCanonical: true, dupGroupId: null });
    expect(queries[0]).toContain('FROM facts_procedures_v2_b17 ');
  });

  it('leaves a procedure the generation does not hold out of the answer', async () => {
    const { repo } = harness();
    const read = (await repo.procedureCanonicality(['573731', '999999']))._unsafeUnwrap();
    expect(read?.has('999999')).toBe(false);
    expect(read?.size).toBe(1);
  });

  it('answers null without a query when nothing is published', async () => {
    const { repo, queries } = harness({ active: null });
    expect((await repo.procedureCanonicality(['573731']))._unsafeUnwrap()).toBeNull();
    expect(queries).toEqual([]);
  });

  it('never interpolates anything but a bigint id', async () => {
    const { repo, queries } = harness();
    const read = await repo.procedureCanonicality([
      '1) OR (1',
      '0',
      '-5',
      '9223372036854775808',
      '573731',
      '573731',
    ]);
    expect([...(read._unsafeUnwrap()?.keys() ?? [])]).toEqual(['573731']);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('WHERE procedure_id IN (573731)');
  });

  it('splits a large request into bounded statements', async () => {
    const { repo, queries } = harness();
    const ids = Array.from({ length: PROCEDURE_CANONICALITY_BATCH + 1 }, (_, i) => String(i + 1));
    expect((await repo.procedureCanonicality(ids)).isOk()).toBe(true);
    expect(queries).toHaveLength(2);
  });

  it('fails on a backend error, a missing table or a repeated row', async () => {
    const failing = harness({ respond: () => new Response('boom', { status: 500 }) });
    expect((await failing.repo.procedureCanonicality(['573731'])).isErr()).toBe(true);

    const missing = harness({ tables: { facts_procedures_v2_b15: B16 } });
    expect((await missing.repo.procedureCanonicality(['573731'])).isErr()).toBe(true);
    expect(missing.queries[0]).toContain('FROM facts_procedures_v2_b16 ');

    const repeated = harness({
      tables: { facts_procedures_v2_b16: [...B16, row('573731', 'seap_notice', true, null)] },
    });
    const read = await repeated.repo.procedureCanonicality(['573731']);
    expect(read._unsafeUnwrapErr().message).toContain('not unique');
  });

  it('propagates a pointer read failure', async () => {
    globalThis.fetch = () => Promise.reject(new Error('must not be called'));
    const repo = makeClickhouseAnalysisRepo({ url: 'http://ch.invalid', database: 'proto' }, () =>
      Promise.resolve(err(databaseError('pointer read failed')))
    );
    expect((await repo.procedureCanonicality(['573731'])).isErr()).toBe(true);
    expect((await repo.procedureDuplicates('573731')).isErr()).toBe(true);
  });
});

/** Answers the group statement: the procedure first, then its group by id. */
const groupResponder =
  (rows: readonly FactRow[], mutate?: (out: FactRow[]) => FactRow[]) =>
  (sql: string): Response | undefined => {
    const anchor = /WHERE procedure_id = ([0-9]+) OR/u.exec(sql)?.[1];
    if (anchor === undefined) return undefined;
    const limit = Number(/LIMIT ([0-9]+) FORMAT JSONCompact$/u.exec(sql)?.[1]);
    const self = rows.filter((r) => r.procedure_id === anchor);
    const group = self[0]?.dup_group_id ?? null;
    const others = rows
      .filter((r) => r.procedure_id !== anchor && group !== null && r.dup_group_id === group)
      .sort((a, b) => Number(BigInt(a.procedure_id) - BigInt(b.procedure_id)));
    const out = (mutate ?? ((x: FactRow[]) => x))([...self, ...others]).slice(0, limit);
    return compactResponse(
      out.map((r) => ({
        id: r.procedure_id,
        source: r.source_system,
        group_id: r.dup_group_id,
      })),
      ['id', 'source', 'group_id']
    );
  };

describe('procedureDuplicates', () => {
  it('lists the rest of the group from the active build, the procedure excluded', async () => {
    const { repo, queries } = harness({ respond: groupResponder(B16) });
    expect((await repo.procedureDuplicates('573731'))._unsafeUnwrap()).toEqual([
      { sourceSystem: 'elicitatie', id: '347436' },
    ]);
    expect((await repo.procedureDuplicates('347436'))._unsafeUnwrap()).toEqual([
      { sourceSystem: 'seap_notice', id: '573731' },
    ]);
    expect((await repo.procedureDuplicates('800002'))._unsafeUnwrap()).toEqual([
      { sourceSystem: 'seap_notice', id: '800001' },
    ]);
    // One statement per procedure, on one table, both references pinned to it.
    for (const sql of queries) {
      expect(sql.match(/facts_procedures_v2_b16 /gu)).toHaveLength(2);
      expect(sql).not.toContain('_b17');
    }
  });

  it('answers [] for an ungrouped procedure and null for one the build lacks', async () => {
    const { repo } = harness({ respond: groupResponder(B16) });
    expect((await repo.procedureDuplicates('900002'))._unsafeUnwrap()).toEqual([]);
    expect((await repo.procedureDuplicates('999999'))._unsafeUnwrap()).toBeNull();
  });

  it('answers null without a query when nothing is published or the id is invalid', async () => {
    const unpublished = harness({ active: null, respond: groupResponder(B16) });
    expect((await unpublished.repo.procedureDuplicates('573731'))._unsafeUnwrap()).toBeNull();
    expect(unpublished.queries).toEqual([]);
    const invalid = harness({ respond: groupResponder(B16) });
    expect((await invalid.repo.procedureDuplicates('1 OR 1=1'))._unsafeUnwrap()).toBeNull();
    expect(invalid.queries).toEqual([]);
  });

  it('caps the list', async () => {
    const big = [
      row('1000', 'elicitatie', true, '1000'),
      ...Array.from({ length: PROCEDURE_DUPLICATES_CAP + 5 }, (_, i) =>
        row(String(2000 + i), 'seap_notice', false, '1000')
      ),
    ];
    const { repo } = harness({ respond: groupResponder(big) });
    const list = (await repo.procedureDuplicates('1000'))._unsafeUnwrap();
    expect(list).toHaveLength(PROCEDURE_DUPLICATES_CAP);
    expect(list?.[0]).toEqual({ sourceSystem: 'seap_notice', id: '2000' });
  });

  it('fails on a repeated procedure or a member of another group', async () => {
    const repeated = harness({
      respond: groupResponder(B16, (out) => [...out.slice(0, 1), ...out]),
    });
    expect((await repeated.repo.procedureDuplicates('573731')).isErr()).toBe(true);
    const foreign = harness({
      respond: groupResponder(B16, (out) => [
        ...out,
        row('800002', 'seap_notice', false, '800001'),
      ]),
    });
    expect((await foreign.repo.procedureDuplicates('573731')).isErr()).toBe(true);
  });
});

describe('without a ClickHouse backend', () => {
  it('fails both reads explicitly', async () => {
    const repo = makeUnconfiguredAnalysisRepo();
    expect((await repo.procedureCanonicality(['573731']))._unsafeUnwrapErr().message).toContain(
      'not configured'
    );
    expect((await repo.procedureDuplicates('573731')).isErr()).toBe(true);
  });
});
