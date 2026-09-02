/**
 * The legacy dimension SQL shape (capturing Kysely, no DB): the legacy
 * predicates reproduced — ilike OR pg_trgm similarity for descriptions (escaped
 * wildcards), the compat view for funding sources, functional code-prefix vs
 * economic contains (both unaccented, wildcards unescaped as legacy) for
 * classifications, one predicate for rows AND count, ordering, limit/offset,
 * and the count fallback on an empty page.
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

import {
  escapeLike,
  isCodeLike,
  makeLegacyDimensionRepo,
} from '@/modules/budget/shell/repo/legacy-dimension-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const makeCapturingDb = (
  captured: Captured[],
  rowsFor: (sql: string) => unknown[] = () => []
): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: query.sql, parameters: query.parameters });
      return Promise.resolve({ rows: rowsFor(query.sql) as R[] });
    },
    streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      throw new Error('streamQuery not supported');
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
  return new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
};

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();

describe('helpers', () => {
  it('escapes LIKE wildcards as the legacy escapeLikePattern did', () => {
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });
  it('treats digits and dots as a code-like term', () => {
    expect(isCodeLike('10.01')).toBe(true);
    expect(isCodeLike('65')).toBe(true);
    expect(isCodeLike('salarii')).toBe(false);
    expect(isCodeLike('10.01 x')).toBe(false);
  });
});

describe('legacy sectors SQL', () => {
  it('ilike OR similarity > 0.1, id list, order by id, limit/offset, COUNT(*) OVER()', async () => {
    const captured: Captured[] = [];
    const repo = makeLegacyDimensionRepo(
      makeCapturingDb(captured, () => [
        { sector_id: 2, sector_description: 'Bugetul local', total_count: '1' },
      ])
    );
    const result = await repo.listSectors({ search: 'lo%cal', ids: [1, 2], limit: 20, offset: 40 });
    expect(result.isOk() && result.value).toEqual({
      rows: [{ sectorId: 2, sectorDescription: 'Bugetul local' }],
      totalCount: 1,
    });
    expect(captured).toHaveLength(1);
    const q = flat(captured[0]?.sql ?? '');
    expect(q).toContain('count(*) over() as total_count from budget.budget_sectors as s');
    expect(q).toContain(
      '("s"."sector_description" ilike $1 or similarity("s"."sector_description", $2) > $3)'
    );
    expect(q).toContain('s.sector_id in ($4, $5)');
    expect(q).toContain('order by s.sector_id asc limit $6 offset $7');
    expect(captured[0]?.parameters).toEqual(['%lo\\%cal%', 'lo%cal', 0.1, 1, 2, 20, 40]);
  });

  it('falls back to a count statement when the page is empty (legacy answered 0)', async () => {
    const captured: Captured[] = [];
    const repo = makeLegacyDimensionRepo(
      makeCapturingDb(captured, (sql) => (sql.includes('over()') ? [] : [{ total_count: '5' }]))
    );
    const result = await repo.listSectors({ limit: 20, offset: 100 });
    expect(result.isOk() && result.value).toEqual({ rows: [], totalCount: 5 });
    expect(captured).toHaveLength(2);
    expect(flat(captured[1]?.sql ?? '')).toBe(
      'select count(*) as total_count from budget.budget_sectors as s'
    );
  });
});

describe('legacy funding sources SQL', () => {
  it('reads the compat view, excludes the synthetic row, same search shape', async () => {
    const captured: Captured[] = [];
    const repo = makeLegacyDimensionRepo(
      makeCapturingDb(captured, () => [
        { source_id: 1, source_description: 'Integral de la buget', total_count: '10' },
      ])
    );
    const result = await repo.listFundingSources({ search: 'buget', limit: 10, offset: 0 });
    expect(result.isOk() && result.value.totalCount).toBe(10);
    const q = flat(captured[0]?.sql ?? '');
    expect(q).toContain(
      'from budget.v_funding_sources_compat as fs where fs.source_code is not null and'
    );
    expect(q).toContain('similarity("fs"."source_description", $2) > $3');
    expect(q).toContain('order by fs.source_id asc limit $4 offset $5');
  });
});

describe('legacy classifications SQL', () => {
  it('functional + code-like term → prefix on the code; count shares the predicate (legacy count bug fixed)', async () => {
    const captured: Captured[] = [];
    const repo = makeLegacyDimensionRepo(
      makeCapturingDb(captured, () => [{ code: '65.02', name: 'Invatamant', total_count: '19' }])
    );
    const result = await repo.listClassifications('functional', {
      search: '65.02',
      limit: 100,
      offset: 0,
    });
    expect(result.isOk() && result.value).toEqual({
      rows: [{ code: '65.02', name: 'Invatamant' }],
      totalCount: 19,
    });
    const q = flat(captured[0]?.sql ?? '');
    expect(q).toContain(
      'select "d"."functional_code" as code, "d"."functional_name" as name, count(*) over() as total_count from "budget"."functional_classifications" as d where "d"."functional_code" ilike $1'
    );
    expect(q).toContain('order by "d"."functional_code" asc limit $2 offset $3');
    expect(captured[0]?.parameters).toEqual(['65.02%', 100, 0]);
  });

  it('economic + code-like term → CONTAINS on code or name (legacy economic repo never used a prefix)', async () => {
    const captured: Captured[] = [];
    const repo = makeLegacyDimensionRepo(makeCapturingDb(captured, () => []));
    await repo.listClassifications('economic', { search: '10.01', limit: 100, offset: 0 });
    const q = flat(captured[0]?.sql ?? '');
    expect(q).toContain(
      'from "budget"."economic_classifications" as d where (unaccent("d"."economic_code") ilike unaccent($1) or unaccent("d"."economic_name") ilike unaccent($2))'
    );
    expect(captured[0]?.parameters).toEqual(['%10.01%', '%10.01%', 100, 0]);
  });

  it('text term → lower-cased, unaccented contains on code OR name (S1-9), wildcards NOT escaped (legacy), plus the code list', async () => {
    const captured: Captured[] = [];
    const repo = makeLegacyDimensionRepo(makeCapturingDb(captured, () => []));
    await repo.listClassifications('functional', {
      search: 'Sana%tate',
      codes: ['65.02', '51.02'],
      limit: 2000,
      offset: 0,
    });
    const q = flat(captured[0]?.sql ?? '');
    expect(q).toContain(
      'from "budget"."functional_classifications" as d where (unaccent("d"."functional_code") ilike unaccent($1) or unaccent("d"."functional_name") ilike unaccent($2)) and "d"."functional_code" in ($3, $4)'
    );
    expect(captured[0]?.parameters).toEqual([
      '%sana%tate%',
      '%sana%tate%',
      '65.02',
      '51.02',
      2000,
      0,
    ]);
    // Empty page → the count statement carries the SAME predicate.
    expect(flat(captured[1]?.sql ?? '')).toContain(
      'select count(*) as total_count from "budget"."functional_classifications" as d where (unaccent('
    );
  });
});
