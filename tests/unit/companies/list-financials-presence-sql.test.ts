/**
 * The `hasFinancials` virtual filter compiles to an EXISTS over
 * `companies_v2.financials`. Row reads of that table pin
 * `privacy_class = 'public'`; the presence predicate did not, so a company whose
 * only financial rows are non-public answered "present" (and was excluded from
 * the "absent" branch). Both EXISTS branches must apply the same allowlist.
 * Compiled through a driver that executes nothing.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

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

const GATED_EXISTS =
  "exists (select 1 from companies_v2.financials fz where fz.cui = o.cui and fz.privacy_class = 'public')";

describe('companies list — hasFinancials presence applies the financials privacy allowlist', () => {
  it.each([
    { name: 'present', isNull: false, prefix: '' },
    { name: 'absent', isNull: true, prefix: 'not ' },
  ])('$name branch', async ({ isNull, prefix }) => {
    const { db, sql } = recordingDb();
    const res = await makeCompaniesRepo(db).listCompanies({ hasFinancials: { isNull } }, 'name', {
      page: 1,
      pageSize: 10,
    });
    expect(res.isOk()).toBe(true);
    // The rows query and the bounded-total subquery share the predicate.
    const statements = sql.filter((s) => s.includes('companies_v2.financials fz'));
    expect(statements.length).toBeGreaterThanOrEqual(1);
    for (const statement of statements) {
      expect(statement).toContain(`${prefix}${GATED_EXISTS}`);
      expect(statement).not.toContain('fz.cui = o.cui)');
    }
  });
});
