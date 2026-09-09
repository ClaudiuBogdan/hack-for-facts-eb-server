/**
 * Every `core.organizations` read in the companies repo pins
 * `privacy_class = 'public'`, the same gate the kernel identity repo applies
 * (review M/M02). All rows are public today; the platform gates on class, not
 * distribution, and a company profile, list row, name hit, registration-number
 * hit or entity slice must never be built from a restricted organization row.
 * Compiled through a driver that executes nothing and records statements.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';
import { upstreamError } from '@/modules/shared/core/errors.js';

import type { MeiliClient, ProdDatabase } from '@/modules/shared/index.js';

const recordingDb = (): { db: Kysely<ProdDatabase>; sql: string[] } => {
  const captured: string[] = [];
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') captured.push(event.query.sql.replace(/\s+/gu, ' '));
    },
  });
  return { db, sql: captured };
};

/** Every statement that reads the organizations table. */
const organizationReads = (sql: readonly string[]): string[] =>
  sql.filter((s) => s.includes('"core"."organizations"') || s.includes('core.organizations o'));

const GATE = /"?o?"?\.?"privacy_class" = \$\d+|o\."privacy_class" = \$\d+/u;

const meiliDown = {
  searchEntities: () => Promise.resolve(err(upstreamError('meili unreachable', 'meilisearch'))),
  healthCheck: () => Promise.resolve(err(upstreamError('down', 'meilisearch'))),
} as unknown as MeiliClient;

const meiliWithHit = {
  searchEntities: () =>
    Promise.resolve(
      ok({
        hits: [
          {
            id: 'company_2816464',
            docType: 'company',
            title: 'DEDEMAN SRL',
            snippet: null,
            score: 0.9,
            source: 'meili' as const,
            attrs: {},
            docKey: '2816464',
            cuis: ['2816464'],
          },
        ],
        facetDistribution: {},
        estimatedTotalHits: 1,
      })
    ),
  healthCheck: () => Promise.resolve(ok(undefined)),
} as unknown as MeiliClient;

describe('companies repo — every organizations read pins privacy_class = public', () => {
  it.each([
    [
      'getProfileData',
      (db: Kysely<ProdDatabase>) => makeCompaniesRepo(db).getProfileData('2816464'),
    ],
    [
      'listCompanies (rows + bounded total)',
      (db: Kysely<ProdDatabase>) =>
        makeCompaniesRepo(db).listCompanies({}, 'name', { page: 1, pageSize: 10 }),
    ],
    [
      'resolveByName pg fallback (engine down)',
      (db: Kysely<ProdDatabase>) => makeCompaniesRepo(db).resolveByName('dedeman', 8, meiliDown),
    ],
    [
      'resolveByName hit validation (engine up)',
      (db: Kysely<ProdDatabase>) => makeCompaniesRepo(db).resolveByName('dedeman', 8, meiliWithHit),
    ],
    [
      'findByRegistrationNumber',
      (db: Kysely<ProdDatabase>) => makeCompaniesRepo(db).findByRegistrationNumber('J40/1/2000'),
    ],
    ['countBy status', (db: Kysely<ProdDatabase>) => makeCompaniesRepo(db).countBy('status', {})],
    ['profileSlice', (db: Kysely<ProdDatabase>) => makeCompaniesRepo(db).profileSlice('2816464')],
    [
      'profileSlicesForCuis',
      (db: Kysely<ProdDatabase>) => makeCompaniesRepo(db).profileSlicesForCuis(['2816464', '111']),
    ],
    [
      'presenceCounts',
      (db: Kysely<ProdDatabase>) => makeCompaniesRepo(db).presenceCounts('2816464'),
    ],
  ])('%s', async (_name, run) => {
    const { db, sql } = recordingDb();
    const res = await run(db);
    expect(res.isOk()).toBe(true);
    const reads = organizationReads(sql);
    expect(reads.length, 'expected at least one organizations read').toBeGreaterThanOrEqual(1);
    for (const statement of reads) {
      expect(statement).toMatch(GATE);
    }
  });
});
