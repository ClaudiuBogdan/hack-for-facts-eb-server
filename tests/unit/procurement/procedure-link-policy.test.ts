/**
 * P26: a stored contract → procedure link is served only through the one
 * source-supported policy (procedure-link-policy). These pin that every reader
 * path compiles the guard instead of the raw `c.procedure_id`; the behaviour on
 * real DDL is pinned by tests/integration/procurement/procedure-link-policy.test.ts.
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

import { contractDisplayTitleCandidatesSelect } from '@/modules/procurement/shell/repo/contract-display-title-projection.js';
import { makeProcurementDetailRepo } from '@/modules/procurement/shell/repo/detail-repo.js';
import { procedureIdPredicate } from '@/modules/procurement/shell/repo/procedure-link-policy.js';
import { makeProcurementRepo } from '@/modules/procurement/shell/repo/procurement-repo.js';

import type { FilterInput, ProdDatabase } from '@/modules/shared/index.js';

const makeRecordingDb = (sqls: string[]): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      sqls.push(compiled.sql);
      return Promise.resolve({ rows: [] as R[] });
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      yield { rows: [] };
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

const GUARD = 'from procurement.procedures parent';
const compile = (sqls: string[]): Kysely<ProdDatabase> => makeRecordingDb(sqls);

/** The projected procedure id is the guarded subquery, never the raw column. */
const expectGuardedProjection = (sql: string): void => {
  expect(sql).toContain(GUARD);
  expect(sql).toContain(') as "procedure_id"');
  expect(sql).not.toMatch(/"c"\."procedure_id"\s*,/u);
};

describe('procedure link policy is the only served contract → procedure edge', () => {
  it('guards the contract projection on the cursor, detail and offset paths', async () => {
    const sqls: string[] = [];
    const db = compile(sqls);
    await makeProcurementRepo(db).getContract('1');
    await makeProcurementDetailRepo(db).contractsByIds(['1']);
    await makeProcurementRepo(db).searchContractsOffset(
      { authorityCui: '111' },
      { page: 1, pageSize: 10, sort: 'date_desc' }
    );
    const projections = sqls.filter(
      (s) => s.includes('from "procurement"."contracts" as "c"') && s.includes('"c"."contract_key"')
    );
    // getContract, contractsByIds and the offset page each project a contract row.
    expect(projections).toHaveLength(3);
    for (const sql of projections) expectGuardedProjection(sql);
  });

  it('reads the title fallback only through a supported link and a same-buyer award', () => {
    const sqls: string[] = [];
    const compiled = compile(sqls)
      .selectFrom('procurement.contracts as c')
      .select(contractDisplayTitleCandidatesSelect())
      .compile().sql;
    expect(compiled).toContain('where procedure.procedure_id = (');
    expect(compiled).toContain(GUARD);
    // Both buyers present and equal: no `is not false` escape for an unknown buyer.
    expect(compiled).toContain("and nullif(award.authority_cui, '') = nullif(c.authority_cui, '')");
    const start = compiled.lastIndexOf("'matchedAwards'");
    const matchedAwards = compiled.slice(start, compiled.indexOf("'procedure',", start));
    expect(matchedAwards).toContain('award.dup_method');
    expect(matchedAwards).not.toContain('is not false');
    expect(compiled).not.toContain('procedure.procedure_id = c.procedure_id');
  });

  it('compiles the procedureId filter through the guard and rejects a non-id', async () => {
    const eq = procedureIdPredicate({ procedureId: { eq: '42' } }, 'c');
    expect(eq.isOk()).toBe(true);
    const scoped = procedureIdPredicate(
      { procedureId: { isNull: true }, authorityCui: { eq: '4267117' } },
      'c'
    );
    expect(scoped.isOk()).toBe(true);
    expect(procedureIdPredicate({ procedureId: { eq: '42; drop' } }, 'c').isErr()).toBe(true);
    expect(procedureIdPredicate({}, 'c')._unsafeUnwrap()).toBeUndefined();

    const sqls: string[] = [];
    const repo = makeProcurementRepo(compile(sqls));
    await repo.listContracts({ procedureId: { eq: '42' } }, { first: 5 });
    await repo.listContracts(
      { procedureId: { isNull: true }, authorityCui: { eq: '4267117' } },
      { first: 5 }
    );
    expect(sqls).toHaveLength(2);
    const [byId, unlinked] = sqls;
    expect(byId).toMatch(/"c"\."procedure_id" = \$\d+::bigint and \(/u);
    expect(byId).toContain(GUARD);
    expect(unlinked).toMatch(/\) is null/u);
    // The kernel no longer emits the raw column predicate for this field.
    expect(unlinked).not.toContain('"c"."procedure_id" is null');
  });
});

describe('procedureId isNull needs an indexed scope (query-shape bound)', () => {
  const list = async (filter: FilterInput) => {
    const sqls: string[] = [];
    const result = await makeProcurementRepo(compile(sqls)).listContracts(filter, { first: 5 });
    return { result, sqls };
  };
  const expectRejected = async (filter: FilterInput, field = 'procedureId'): Promise<void> => {
    const { result, sqls } = await list(filter);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field });
    expect(sqls).toEqual([]);
  };

  it('rejects bare isNull true and false before any query', async () => {
    await expectRejected({ procedureId: { isNull: true } });
    await expectRejected({ procedureId: { isNull: false } });
    const { result } = await list({ procedureId: { isNull: true } });
    expect(result._unsafeUnwrapErr().message).toContain('authorityCui, supplierCui or noticeNo');
  });

  it('accepts a buyer, supplier or notice scope and keeps every predicate', async () => {
    const cases: { filter: FilterInput; scope: RegExp; link: RegExp }[] = [
      {
        filter: { procedureId: { isNull: true }, authorityCui: { eq: 'RO4267117' } },
        scope: /"c"\."authority_cui" = \$\d+/u,
        link: /\) is null/u,
      },
      {
        filter: { procedureId: { isNull: false }, supplierCui: { in: ['123', 'x'] } },
        scope: /"c"\."supplier_cui" in \(/u,
        link: /\) is not null/u,
      },
      {
        filter: { procedureId: { isNull: true }, noticeNo: { eq: 'CAN1150526' } },
        scope: /"c"\."notice_no" = \$\d+/u,
        link: /\) is null/u,
      },
    ];
    for (const { filter, scope, link } of cases) {
      const { result, sqls } = await list(filter);
      expect(result.isOk()).toBe(true);
      expect(sqls).toHaveLength(1);
      expect(sqls[0]).toMatch(scope);
      expect(sqls[0]).toMatch(link);
      expect(sqls[0]).toContain(GUARD);
      expect(sqls[0]).toContain('"c"."is_canonical" = ');
    }
  });

  it('accepts eq plus isNull without another scope', async () => {
    const { result, sqls } = await list({ procedureId: { eq: '42', isNull: false } });
    expect(result.isOk()).toBe(true);
    expect(sqls[0]).toMatch(/"c"\."procedure_id" = \$\d+::bigint and \(/u);
    expect(sqls[0]).toMatch(/\) is not null/u);
  });

  it('does not let empty, blank, normalized-away or excluded scopes bypass the bound', async () => {
    for (const scope of [
      { authorityCui: {} },
      { authorityCui: { in: [] } },
      { authorityCui: { eq: '' } },
      // Normalizes to an empty list, which the kernel compiles to FALSE.
      { authorityCui: { in: ['RO'] } },
      { supplierCui: { in: [' '] } },
      { noticeNo: { eq: '   ' } },
      { cpvCode: { eq: '45000000' } },
    ] as FilterInput[]) {
      const { result, sqls } = await list({ procedureId: { isNull: true }, ...scope });
      expect(result._unsafeUnwrapErr(), JSON.stringify(scope)).toMatchObject({
        type: 'InvalidInput',
        field: 'procedureId',
      });
      expect(sqls).toEqual([]);
    }
    // Operators or negations the scope field does not allow are the kernel's
    // errors, never a scope.
    await expectRejected({ procedureId: { isNull: true }, noticeNo: { in: ['CAN1'] } }, 'noticeNo');
    await expectRejected(
      { procedureId: { isNull: true }, exclude: { authorityCui: { eq: '4267117' } } },
      'authorityCui'
    );
  });

  it('rejects other procedureId operators and a negated procedureId', async () => {
    await expectRejected({ procedureId: { in: ['1'] }, authorityCui: { eq: '1' } });
    await expectRejected({ exclude: { procedureId: { eq: '1' } }, authorityCui: { eq: '1' } });
  });
});
