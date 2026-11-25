/**
 * Legacy supplier names of persons (owner, 24 Nov: "Masked name"): every legacy read that selects or
 * searches a supplier name reads it through the platform's buyer mask when the supplier code is a
 * person's (`procurement_v3.mask_person_name`, never raw), and an engine-served highlight never
 * quotes such a row's name. A scripted Kysely driver records the SQL (no database, no mocking
 * library); the masking itself is the database function, read back live on deploy.
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

import { makeProcurementRepo } from '@/modules/procurement/shell/repo/procurement-repo.js';

import {
  CODED_NAME,
  ORDINARY_NAME,
  SYNTHETIC_CNP,
} from '../../fixtures/procurement/personal-code.js';

import type { OpenSearchListEngine } from '@/modules/procurement/shell/repo/opensearch-list-repo.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

const contractRow = (id: string, supplierCui: string | null, supplierName: string) => ({
  contract_id: id,
  contract_key: `k${id}`,
  source_system: 'seap_contracts',
  source_url: null,
  procedure_id: null,
  notice_no: null,
  contract_no: null,
  contract_date: '2024-05-01',
  title: 'Servicii de curatenie',
  authority_cui: '4305857',
  authority_name: 'COMUNA EXEMPLU',
  supplier_cui: supplierCui,
  supplier_name: supplierName,
  cpv_code: '45230000',
  value_ron: '1000.00',
  estimated_value_ron: null,
  currency: null,
  status: 'awarded',
  county_name: 'CJ',
  is_canonical: true,
  dup_group_id: null,
  value_state: 'official_exact',
  value_state_detail: { rule: 'own_value' },
  value_ron_comparable: '1000.00',
  value_comparable_basis: 'official',
  value_rules_version: 2,
  value_resolved_at: '2026-07-18T00:00:00+00:00',
  canonical_value_source: 'seap_own',
  value_disagreement: false,
  record_kind: null,
  display_title_candidates: { matchedAwards: [], procedure: null },
});

const PROCEDURE_ROW = {
  procedure_id: '9',
  source_system: 'seap_notice',
  source_url: null,
  notice_no: null,
  notice_kind: null,
  procedure_type: null,
  contract_kind: null,
  title: null,
  authority_cui: '4305857',
  authority_name: 'COMUNA EXEMPLU',
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
};

/** The rows the hydration query answers, by contract id. */
const ROWS = new Map([
  ['1', contractRow('1', '14399840', ORDINARY_NAME)],
  // A person's code: production serves the masked name (this is what the mask would answer).
  ['2', contractRow('2', SYNTHETIC_CNP, 'PO*****U ION')],
  ['3', contractRow('3', null, CODED_NAME)],
]);

/** A database that records every statement; the contract hydration answers ROWS. */
const scriptedDb = () => {
  const queries: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery: <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      queries.push(query.sql);
      // The procedure of a procedure detail, so its contracts are read too.
      if (
        query.sql.includes('from "procurement"."procedures" as "p" where "p"."procedure_id" = $1')
      ) {
        return Promise.resolve({ rows: [PROCEDURE_ROW] as unknown as R[] });
      }
      // The SQL q path's candidates (PROC-R87F): one, so the page is hydrated too.
      if (query.sql.includes('as other_match')) {
        return Promise.resolve({
          rows: [{ pk: '1', title: 'Servicii de curatenie', other_match: true }] as unknown as R[],
        });
      }
      if (/\bc\.contract_id = any\(cast\(/u.test(query.sql)) {
        const pks = (query.parameters[0] as readonly (number | string)[]).map(String);
        return Promise.resolve({
          rows: pks.flatMap((pk) => {
            const row = ROWS.get(pk);
            return row === undefined ? [] : [row];
          }) as unknown as R[],
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
  return { db, queries };
};

/** The masked-or-raw expression, as compiled, for any table alias. */
const MASKED =
  /case when coalesce\("(\w+)"\."supplier_cui", "\1"\."attrs" #>> '\{source_party_cuis,supplier\}'\) is null or length\(coalesce\("\1"\."supplier_cui", "\1"\."attrs" #>> '\{source_party_cuis,supplier\}'\)\) > 10 then procurement_v3\.mask_person_name\("\1"\."supplier_name"\) else "\1"\."supplier_name" end/gu;

/** A statement's raw supplier-name reads: what is left once every masked read is removed. */
const rawSupplierNameReads = (statement: string): string[] =>
  statement
    .replace(MASKED, 'MASKED')
    .replace(/ as "supplier_name"/gu, '')
    .match(/"supplier_name"/gu) ?? [];

const page = { page: 1, pageSize: 5, sort: 'date_desc' } as const;

describe('legacy reads mask a person supplier name in SQL', () => {
  it('every statement that reads a supplier name reads it masked, on every legacy path', async () => {
    const { db, queries } = scriptedDb();
    const repo = makeProcurementRepo(db, 366);
    const calls: readonly (readonly [string, () => Promise<unknown>])[] = [
      ['listContracts', () => repo.listContracts({}, { first: 5 })],
      ['getContract', () => repo.getContract('1')],
      ['getContractDetail', () => repo.getContractDetail('1')],
      ['getProcedureDetail', () => repo.getProcedureDetail('9')],
      ['contractsByIds', () => repo.contractsByIds(['1'])],
      ['supplierRecords', () => repo.supplierRecords('14399840', 5, undefined, false)],
      ['listModifications', () => repo.listModifications({}, { first: 5 })],
      ['modificationsForContracts', () => repo.modificationsForContracts(['1'])],
      [
        'listDirectAcquisitions',
        () => repo.listDirectAcquisitions({ authorityCui: { in: ['4305857'] } }, { first: 5 }),
      ],
      ['getDirectAcquisition', () => repo.getDirectAcquisition('1')],
      ['searchContractsOffset (q)', () => repo.searchContractsOffset({ q: 'popescu' }, page)],
      [
        'searchModificationsOffset (q)',
        () => repo.searchModificationsOffset({ q: 'popescu' }, page),
      ],
      [
        'searchDirectAcquisitionsOffset (q)',
        () => repo.searchDirectAcquisitionsOffset({ authorityCui: '4305857', q: 'popescu' }, page),
      ],
    ];
    const readsByPath: Record<string, { statements: number; masked: number; raw: string[] }> = {};
    for (const [label, call] of calls) {
      const before = queries.length;
      await call();
      const statements = queries.slice(before).filter((q) => q.includes('supplier_name'));
      readsByPath[label] = {
        statements: statements.length,
        masked: statements.filter((q) => new RegExp(MASKED.source, 'u').test(q)).length,
        raw: statements.flatMap(rawSupplierNameReads),
      };
    }
    for (const [label, reads] of Object.entries(readsByPath)) {
      // Each path reads a supplier name, every read masked, none raw.
      expect({ label, ...reads }).toEqual({
        label,
        statements: reads.statements,
        masked: reads.statements,
        raw: [],
      });
      expect(reads.statements, label).toBeGreaterThan(0);
    }
  });
});

describe('the SQL q path', () => {
  it('matches party names and modification text with their digits removed, the supplier masked', async () => {
    const { db, queries } = scriptedDb();
    const repo = makeProcurementRepo(db, 366);
    await repo.searchContractsOffset({ q: 'popescu' }, page);
    await repo.searchModificationsOffset({ q: 'popescu' }, page);
    await repo.searchProceduresOffset({ q: 'popescu' }, page);
    const qStatements = queries.filter((q) => q.includes(' ilike '));
    expect(qStatements.length).toBeGreaterThanOrEqual(3);
    for (const statement of qStatements) {
      // No name or modification text is matched raw: each is wrapped, digits removed.
      expect(statement).not.toMatch(
        /"\w+"\."(authority_name|supplier_name|modification_type)" ilike/u
      );
      expect(statement).not.toMatch(/ end ilike/u);
    }
    const joined = qStatements.join('\n');
    expect(joined).toContain(`regexp_replace("c"."authority_name", '[0-9]', '', 'g') ilike`);
    expect(joined).toContain(`regexp_replace("m"."modification_type", '[0-9]', '', 'g') ilike`);
    expect(joined).toMatch(
      new RegExp(
        `regexp_replace\\(${MASKED.source.replace(/\(\\w\+\)/u, '(c)').replace(/\\1/gu, 'c')}, '\\[0-9\\]', '', 'g'\\) ilike`,
        'u'
      )
    );
  });
});

describe('engine-served highlights (repository wiring)', () => {
  it('never quote a person supplier name or a name carrying a personal code', async () => {
    const { db } = scriptedDb();
    const engine: OpenSearchListEngine = {
      canServe: (grain) => grain === 'contracts',
      search: () =>
        Promise.resolve(
          ok({
            pks: [1, 2, 3],
            total: 3,
            totalExhaustive: true,
            facets: [],
            asOf: '2026-11-24T00:00:00Z',
            highlights: [
              { id: '1', supplierName: '⟦FIRMA⟧ EXEMPLU SRL' },
              // The index holds the raw name; neither fragment quotes a digit.
              { id: '2', supplierName: '⟦POPESCU⟧ ION' },
              { id: '3', supplierName: '⟦POPESCU⟧ ION', authorityName: '⟦COMUNA⟧ EXEMPLU' },
            ],
          })
        ),
    };
    const repo = makeProcurementRepo(db, 366, engine);
    const result = (await repo.searchContractsOffset({ q: 'popescu' }, page))._unsafeUnwrap();
    expect(result.items.map((item) => item.contractId)).toEqual(['1', '2', '3']);
    expect(result.highlights).toEqual([
      { id: '1', supplierName: '⟦FIRMA⟧ EXEMPLU SRL' },
      { id: '3', authorityName: '⟦COMUNA⟧ EXEMPLU' },
    ]);
  });
});
