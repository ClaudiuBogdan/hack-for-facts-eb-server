/**
 * P33 — a record's own e-licitatie.ro page. Pins the accepted rule (user
 * decision 2026-10-14: an exact number and buyer match with exactly one
 * captured notice, never a guessed link) at the core, the batched repo SQL and
 * the GraphQL field. Behaviour on the real DDL is pinned by
 * tests/integration/procurement/elicitatie-page.test.ts.
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
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  elicitatiePageOf,
  portalIdFromRef,
  soleCandidate,
} from '@/modules/procurement/core/elicitatie-page.js';
import { makeProcurementResolvers } from '@/modules/procurement/shell/graphql/resolvers.js';
import { makeElicitatiePageRepo } from '@/modules/procurement/shell/repo/elicitatie-page-repo.js';

import type { AnalysisRepo, ProcurementRepo } from '@/modules/procurement/core/ports.js';
import type {
  ProcurementContract,
  ProcurementDirectAcquisition,
} from '@/modules/procurement/core/types.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

// ── an in-memory Kysely: canned rows in, executed SQL out ─────────────────────

const makeFakeDb = (
  sqls: string[],
  rows: Record<string, unknown>[] = [],
  fail = false
): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      sqls.push(compiled.sql);
      if (fail) return Promise.reject(new Error('connection lost'));
      return Promise.resolve({ rows: rows as R[] });
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

const NOTICE = 'https://e-licitatie.ro/pub/notices/ca-notices/view-c/';

describe('elicitatie page core', () => {
  it('builds the portal page only from a portal id', () => {
    expect(elicitatiePageOf('award_notice', '100426518', 'number_and_buyer')).toEqual({
      url: `${NOTICE}100426518`,
      kind: 'award_notice',
      match: 'number_and_buyer',
    });
    expect(elicitatiePageOf('direct_acquisition', '121372731', 'own_record')?.url).toBe(
      'https://e-licitatie.ro/pub/direct-acquisition/view/121372731'
    );
    for (const bad of [null, '', '0', '012', 'CAN1117949', '12 3', '1'.repeat(20)]) {
      expect(elicitatiePageOf('award_notice', bad, 'own_record')).toBeNull();
    }
  });

  it('reads a portal id only from its own native prefix', () => {
    expect(portalIdFromRef('elicitatie:100426518', 'elicitatie:')).toBe('100426518');
    expect(portalIdFromRef('elicitatie_da:121372731', 'elicitatie_da:')).toBe('121372731');
    expect(portalIdFromRef('seap_notice:abc', 'elicitatie:')).toBeNull();
    expect(portalIdFromRef('seap_da:121372731', 'elicitatie_da:')).toBeNull();
    expect(portalIdFromRef('elicitatie:', 'elicitatie:')).toBeNull();
    expect(portalIdFromRef(null, 'elicitatie:')).toBeNull();
  });

  it('links only on exactly one distinct candidate', () => {
    expect(soleCandidate(['7'])).toBe('7');
    expect(soleCandidate(['7', '7'])).toBe('7');
    expect(soleCandidate(['7', '8'])).toBeNull();
    expect(soleCandidate([])).toBeNull();
    expect(soleCandidate([null])).toBeNull();
    // A candidate that may not be served still counts: never one of two.
    expect(soleCandidate(['7', null])).toBeNull();
  });
});

describe('elicitatie page repo', () => {
  it('matches native award notices on the exact number and buyer, bounded to two', async () => {
    const sqls: string[] = [];
    const repo = makeElicitatiePageRepo(makeFakeDb(sqls));
    await repo.forContracts(['1']);
    await repo.forModifications(['2']);
    await repo.forProcedures(['3']);
    expect(sqls).toHaveLength(3);
    for (const sql of sqls) {
      expect(sql).toContain("native.source_system = 'elicitatie'");
      // Only a public candidate is returned; a restricted one stays a null ref.
      expect(sql).toContain("case when native.privacy_class = 'public' then native.source_ref end");
      expect(sql).toMatch(/native\.notice_no = "?\w"?\."?notice_no"?/u);
      expect(sql).toMatch(/native\.authority_cui = "?\w"?\."?authority_cui"?/u);
      expect(sql).toContain('limit 2');
      // Never a dedup group, a value or a title.
      expect(sql).not.toMatch(/dup_group_id|value_ron|title/u);
      // Raw equality on both sides: no normalization of the matched keys.
      expect(sql).not.toMatch(/(upper|lower|ltrim|replace)\(/u);
    }
    expect(sqls[0]).toContain("c.source_system = 'seap_contracts'");
    expect(sqls[0]).toContain("c.attrs ->> 'ca_notice_id'");
    // A non-prefixed number needs a same-supplier native award within the window.
    expect(sqls[0]).toMatch(/c\.notice_no ~ \$\d+/u);
    expect(sqls[0]).toContain("award.source_system = 'elicitatie_ca_award'");
    expect(sqls[0]).toContain("award.privacy_class = 'public'");
    expect(sqls[0]).toContain("c.privacy_class = 'public'");
    // The corroboration probe rides the candidate's procedure id (indexed).
    expect(sqls[0]).toContain('award.procedure_id = cand.procedure_ids[1]');
    expect(sqls[0]).toContain('award.supplier_cui = c.supplier_cui');
    expect(sqls[0]).toContain('between c.contract_date - 31');
    expect(sqls[0]).toContain('and c.contract_date + 31');
    // Modifications and notices never link on a non-prefixed number.
    expect(sqls[1]).toMatch(/"m"\."notice_no" ~ \$\d+ then null else false/u);
    expect(sqls[2]).toMatch(/"p"\."notice_no" ~ \$\d+ then null else false/u);
    // Only award-number-space data.gov.ro notices take part.
    expect(sqls[2]).toContain("p.source_system = 'seap_notice'");
    expect(sqls[2]).toMatch(/p\.notice_kind in \(\$\d+, \$\d+\)/u);
  });

  it('skips the query when no id is a primary key', async () => {
    const sqls: string[] = [];
    const repo = makeElicitatiePageRepo(makeFakeDb(sqls));
    const pages = await repo.forContracts(['abc', '']);
    expect(pages._unsafeUnwrap().size).toBe(0);
    expect(sqls).toHaveLength(0);
  });

  it('maps own ids, single candidates and ambiguity', async () => {
    const rows = [
      { id: '1', own_ref: '100000001', candidate_refs: null, corroborated: null },
      { id: '2', own_ref: null, candidate_refs: ['elicitatie:100000002'], corroborated: null },
      {
        id: '3',
        own_ref: null,
        candidate_refs: ['elicitatie:100000003', 'elicitatie:100000004'],
        corroborated: null,
      },
      // A non-prefixed number whose sole candidate is not corroborated never links.
      { id: '7', own_ref: null, candidate_refs: ['elicitatie:100000007'], corroborated: false },
      { id: '8', own_ref: null, candidate_refs: ['elicitatie:100000008'], corroborated: true },
      // A restricted second candidate keeps the pair ambiguous.
      {
        id: '10',
        own_ref: null,
        candidate_refs: ['elicitatie:100000010', null],
        corroborated: null,
      },
      { id: '4', own_ref: null, candidate_refs: [], corroborated: null },
      { id: '5', own_ref: null, candidate_refs: null, corroborated: null },
      { id: '6', own_ref: null, candidate_refs: ['seap_notice:100000006'], corroborated: null },
    ];
    const repo = makeElicitatiePageRepo(makeFakeDb([], rows));
    const pages = (
      await repo.forContracts(['1', '2', '3', '4', '5', '6', '7', '8', '10'])
    )._unsafeUnwrap();
    expect(pages.get('1')).toEqual({
      url: `${NOTICE}100000001`,
      kind: 'award_notice',
      match: 'own_record',
    });
    expect(pages.get('2')).toEqual({
      url: `${NOTICE}100000002`,
      kind: 'award_notice',
      match: 'number_and_buyer',
    });
    expect(pages.get('8')?.url).toBe(`${NOTICE}100000008`);
    expect([...pages.keys()]).toEqual(['1', '2', '8']);
  });

  it('gives a public e-licitatie direct purchase its own page', async () => {
    const sqls: string[] = [];
    const rows = [
      { id: '21', own_ref: 'elicitatie_da:121372731', candidate_refs: null, corroborated: null },
      { id: '22', own_ref: null, candidate_refs: null, corroborated: null },
    ];
    const repo = makeElicitatiePageRepo(makeFakeDb(sqls, rows));
    const pages = (await repo.forDirectAcquisitions(['21', '22']))._unsafeUnwrap();
    expect(pages.get('21')).toEqual({
      url: 'https://e-licitatie.ro/pub/direct-acquisition/view/121372731',
      kind: 'direct_acquisition',
      match: 'own_record',
    });
    expect(pages.has('22')).toBe(false);
    expect(sqls[0]).toContain("d.source_system = 'elicitatie_da' and d.privacy_class = 'public'");
  });

  it('reads a native procedure id from its source ref', async () => {
    const rows = [
      { id: '9', own_ref: 'elicitatie:100000009', candidate_refs: null, corroborated: null },
    ];
    const repo = makeElicitatiePageRepo(makeFakeDb([], rows));
    const pages = (await repo.forProcedures(['9']))._unsafeUnwrap();
    expect(pages.get('9')?.url).toBe(`${NOTICE}100000009`);
    expect(pages.get('9')?.match).toBe('own_record');
  });

  it('returns a database error instead of throwing', async () => {
    const repo = makeElicitatiePageRepo(makeFakeDb([], [], true));
    const result = await repo.forContracts(['1']);
    expect(result.isErr()).toBe(true);
  });
});

describe('elicitatiePage GraphQL field', () => {
  const resolvers = (repo: Partial<ProcurementRepo>) =>
    makeProcurementResolvers({
      repo: repo as ProcurementRepo,
      analysis: {} as AnalysisRepo,
    }) as Record<string, Record<string, (parent: unknown) => unknown>>;

  it('resolves direct purchases through their own batched loader', async () => {
    const calls: string[][] = [];
    const field = resolvers({
      elicitatiePagesForDirectAcquisitions: (ids) => {
        calls.push([...ids]);
        return Promise.resolve(ok(new Map()));
      },
    })['ProcurementDirectAcquisition']?.['elicitatiePage'];
    const da = (daId: string) => ({ daId }) as unknown as ProcurementDirectAcquisition;
    const [first, second] = await Promise.all([field?.(da('11')), field?.(da('12'))]);
    expect(calls).toEqual([['11', '12']]);
    expect(first).toBeNull();
    expect(second).toBeNull();
  });

  it('batches contract pages into one repo call and returns null when unlinked', async () => {
    const calls: string[][] = [];
    const field = resolvers({
      elicitatiePagesForContracts: (ids) => {
        calls.push([...ids]);
        return Promise.resolve(
          ok(
            new Map([
              [
                '1',
                {
                  url: `${NOTICE}100000001`,
                  kind: 'award_notice' as const,
                  match: 'number_and_buyer' as const,
                },
              ],
            ])
          )
        );
      },
    })['ProcurementContract']?.['elicitatiePage'];
    const contract = (contractId: string) => ({ contractId }) as unknown as ProcurementContract;
    const [linked, unlinked] = await Promise.all([field?.(contract('1')), field?.(contract('2'))]);
    expect(calls).toEqual([['1', '2']]);
    expect(linked).toMatchObject({ url: `${NOTICE}100000001` });
    expect(unlinked).toBeNull();
  });
});
