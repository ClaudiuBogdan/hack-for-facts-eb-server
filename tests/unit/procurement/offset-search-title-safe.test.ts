/**
 * `q` on the SQL search path never confirms a withheld title (PROC-R87F S1):
 * a row matching only through a title the free-text rule withholds is dropped
 * before counting and paging; a row that also matches another column stays,
 * its title still masked; above the cap the total stays an estimate; and the
 * candidates are read under the page's own filters and order.
 *
 * A scripted Kysely driver answers the candidate and hydration queries (no
 * database, no mocking library).
 */
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { SEARCH_COUNT_CAP } from '@/modules/procurement/core/constants.js';
import { makeOffsetSearchRepo } from '@/modules/procurement/shell/repo/offset-search-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

interface Candidate {
  readonly pk: string;
  readonly title: string | null;
  readonly other_match: boolean;
}

const procedureRow = (id: string, title: string | null) => ({
  procedure_id: id,
  source_system: 'seap_notice',
  source_url: null,
  notice_no: null,
  notice_kind: null,
  procedure_type: null,
  contract_kind: null,
  title,
  authority_cui: '4270740',
  authority_name: 'Primaria Sibiu',
  cpv_code: null,
  estimated_value_ron: null,
  awarded_value_ron: null,
  currency: null,
  status: 'awarded',
  county_name: null,
  publication_date: '2025-01-01',
  state_date: null,
  value_state: 'source_missing',
  value_state_detail: { rule: 'no_value' },
  value_ron_comparable: null,
  value_comparable_basis: null,
  value_rules_version: 2,
  value_resolved_at: null,
});

/** A database whose answers the test scripts; every query's SQL is recorded. */
const scriptedDb = (
  candidates: readonly Candidate[],
  titles: ReadonlyMap<string, string | null>
) => {
  const queries: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery: <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      queries.push(query.sql);
      if (query.sql.includes('as other_match')) {
        return Promise.resolve({ rows: candidates as unknown as R[] });
      }
      if (query.sql.includes('= any(cast(')) {
        const pks = (query.parameters[0] as readonly number[]).map(String);
        return Promise.resolve({
          rows: pks.map((pk) => procedureRow(pk, titles.get(pk) ?? null)) as unknown as R[],
        });
      }
      return Promise.resolve({ rows: [] });
    },
    streamQuery: () => {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { repo: makeOffsetSearchRepo(db, 366), queries };
};

const page = { page: 1, pageSize: 25, sort: 'date_desc' } as const;

describe('procedures q on the SQL path (PROC-R87F S1)', () => {
  it('drops a row matching only through a withheld title; keeps one that also matches another column, title masked', async () => {
    const titles = new Map<string, string | null>([
      ['1', 'Servicii PFA Exemplu'],
      ['2', 'Servicii PFA Altul'],
      ['3', 'Servicii de curatenie'],
      ['4', null],
    ]);
    const { repo } = scriptedDb(
      [
        // Withheld title, but the authority name matched too: stays, title masked.
        { pk: '1', title: 'Servicii PFA Exemplu', other_match: true },
        // Withheld title and nothing else matched: dropped.
        { pk: '2', title: 'Servicii PFA Altul', other_match: false },
        { pk: '3', title: 'Servicii de curatenie', other_match: false },
        { pk: '4', title: null, other_match: true },
      ],
      titles
    );
    const result = (await repo.searchProceduresOffset({ q: 'servicii' }, page))._unsafeUnwrap();
    expect(result.items.map((item) => [item.procedureId, item.title])).toEqual([
      ['1', null],
      ['3', 'Servicii de curatenie'],
      ['4', null],
    ]);
    // The exact total counts only the kept rows.
    expect(result).toMatchObject({ total: 3, estimated: false });
    expect(JSON.stringify(result)).not.toContain('PFA');
  });

  it('above the cap the total stays an estimate, whatever was dropped', async () => {
    const candidates: Candidate[] = Array.from({ length: SEARCH_COUNT_CAP + 1 }, (_, i) => ({
      pk: String(i + 1),
      title: i % 2 === 0 ? 'Servicii PFA Exemplu' : 'Servicii de curatenie',
      other_match: false,
    }));
    const titles = new Map(candidates.map((c) => [c.pk, c.title]));
    const { repo } = scriptedDb(candidates, titles);
    const result = (await repo.searchProceduresOffset({ q: 'servicii' }, page))._unsafeUnwrap();
    expect(result).toMatchObject({ total: null, estimated: true });
    expect(result.items).toHaveLength(25);
    expect(result.items.every((item) => item.title === 'Servicii de curatenie')).toBe(true);
  });

  it('reads the candidates under the page’s own filters and order', async () => {
    const { repo, queries } = scriptedDb([], new Map());
    const filter = { authorityCui: '4270740' };
    await repo.searchProceduresOffset(filter, page);
    await repo.searchProceduresOffset({ ...filter, q: 'servicii' }, page);
    const pageSql = queries[0] ?? '';
    const candidateSql = queries.find((q) => q.includes('as other_match')) ?? '';
    const orderOf = (text: string) =>
      text
        .slice(text.indexOf('order by'))
        .split(/\s+limit\s+/u)[0]
        ?.replace(/\s+/gu, ' ')
        .trim();
    expect(orderOf(candidateSql)).toBe(orderOf(pageSql));
    // The page's filter, plus the q predicate, in the same WHERE.
    expect(candidateSql).toContain('"p"."authority_cui" =');
    expect(candidateSql).toContain('"p"."title" ilike');
    expect(candidateSql).toMatch(/limit 10001/u);
  });
});
