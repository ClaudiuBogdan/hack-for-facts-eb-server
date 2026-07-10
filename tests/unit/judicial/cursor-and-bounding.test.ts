/**
 * Judicial — keyset cursor SQL shape + the §7.1 bounding rule + the Codex
 * empty-virtual-value bounding bypass. These are SQL-compile / pure-helper tests
 * (no DB).
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { judicialCasesSpec } from '@/modules/judicial/shell/filters/judicial.spec.js';
import { makeJudicialCaseRepo } from '@/modules/judicial/shell/repo/cases-repo.js';
import { keysetCursor, yearBounds, fieldOf } from '@/modules/judicial/shell/repo/filter-helpers.js';
import { fhashFor, type ProdDatabase } from '@/modules/shared/index.js';

const db = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (d) => new PostgresIntrospector(d),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});
const render = (frag: ReturnType<typeof keysetCursor>): string =>
  sql`select 1 where ${frag}`.compile(db).sql;

describe('judicial keysetCursor — (sortExpr, case_id) tiebreak', () => {
  it('desc non-null cursor keeps the IS NULL section reachable + case_id::bigint', () => {
    const s = render(
      keysetCursor(sql`c.latest_source_modified_at`, 'date', '2024-02-01', '100', 'desc')
    );
    expect(s).toContain('is null');
    expect(s).toContain('::bigint');
    expect(s).toContain('::timestamptz');
  });
  it('null-sentinel cursor restricts to the null section by the case_id tiebreak', () => {
    const s = render(keysetCursor(sql`c.latest_source_modified_at`, 'date', '', '100', 'desc'));
    expect(s).toContain('is null');
    expect(s).toContain('::bigint');
  });
});

describe('yearBounds — empty values are NOT a bound (Codex P1)', () => {
  it('between:{} → null (no bound)', () => {
    expect(yearBounds(fieldOf({ year: { between: {} } }, 'year'))).toBeNull();
  });
  it('eq → from=to', () => {
    expect(yearBounds(fieldOf({ year: { eq: 2024 } }, 'year'))).toEqual({ from: 2024, to: 2024 });
  });
  it('gte/lte → bounds', () => {
    expect(yearBounds(fieldOf({ year: { gte: 2020, lte: 2024 } }, 'year'))).toEqual({
      from: 2020,
      to: 2024,
    });
  });
});

describe('case list bounding rule (§7.1) — rejects unbounded BEFORE any SQL', () => {
  // A DB stub that THROWS if any query runs — proves the bounding check short-circuits.
  const throwingDb = {} as unknown as Kysely<ProdDatabase>;
  const repo = makeJudicialCaseRepo(throwingDb);

  it('empty filter → InvalidInput (no court/period bound)', async () => {
    const res = await repo.listCursor({
      filter: {},
      sort: 'modifiedAt',
      dir: 'desc',
      page: { first: 20 },
    });
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('InvalidInput');
  });

  it('courtLevel:{in:[]} does NOT count as a bound (Codex empty-virtual bypass)', async () => {
    const res = await repo.listCursor({
      filter: { courtLevel: { in: [] } },
      sort: 'modifiedAt',
      dir: 'desc',
      page: { first: 20 },
    });
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('InvalidInput');
  });

  it('year:{between:{}} does NOT count as a bound', async () => {
    const res = await repo.listCursor({
      filter: { year: { between: {} } },
      sort: 'modifiedAt',
      dir: 'desc',
      page: { first: 20 },
    });
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('InvalidInput');
  });

  it('modified:{between:{}} does NOT count as a bound (codex P1 — empty date range)', async () => {
    const res = await repo.listCursor({
      filter: { modified: { between: {} } },
      sort: 'modifiedAt',
      dir: 'desc',
      page: { first: 20 },
    });
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('InvalidInput');
  });

  it('a REAL modified bound is accepted (throwing-db proves it passed the gate)', async () => {
    // The bound check passes, so the repo proceeds to the DB and the stub throws →
    // a Database error (NOT InvalidInput). That distinguishes "bounded" from "rejected".
    const res = await repo.listCursor({
      filter: { modified: { gte: '2024-01-01' } },
      sort: 'modifiedAt',
      dir: 'desc',
      page: { first: 20 },
    });
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('Database');
  });
});

describe('fhashFor — stable, filter-bound cursor hash', () => {
  it('same logical filter → same fhash; different → different', () => {
    const a = fhashFor(judicialCasesSpec, { institutionCode: { in: ['JUDX'] } });
    const b = fhashFor(judicialCasesSpec, { institutionCode: { in: ['JUDX'] } });
    const c = fhashFor(judicialCasesSpec, { institutionCode: { in: ['JUDY'] } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
