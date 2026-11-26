/**
 * JUST-9Q9C (26 November 2026): the case OBJECT text is not published and
 * cannot be searched.
 *
 * While `PARTY_NAMES_PUBLISHED` is false:
 *  - every case read (by id, by natural key, the list) answers `object: null`,
 *    and no statement reads the column out;
 *  - the `q` filter on that text is refused on the list AND on the caseload
 *    aggregate, before any SQL, with a message that never repeats the query;
 *  - a null `q`, the presence filter and every other filter behave as before.
 *
 * The scripted database answers every case read WITH an object text, as a
 * server that had been asked for the column would. The proof against a real
 * server is tests/e2e/judicial-no-party-names.test.ts.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { makeJudicialCaseRepo } from '@/modules/judicial/shell/repo/cases-repo.js';

import type { FilterInput, ProdDatabase } from '@/modules/shared/index.js';

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const OBJECT_TEXT = 'obiect de test cu MARCAJ ALFA';
const NEEDLE = 'MARCAJ ALFA';
const COURT = 'TEST_OBJECT_TRIBUNAL';

/** One case row as PostgreSQL would return it had the object been selected. */
const CASE_ROW = {
  case_id: '9',
  source_slug: 'portal_just',
  institution_code: COURT,
  case_number: '9/1/2024',
  case_number_old: null,
  department: null,
  category: 'civil',
  category_name: 'Civil',
  stage: 'fond',
  stage_name: 'Fond',
  object: OBJECT_TEXT,
  source_opened_at: '2024-01-02',
  latest_source_modified_at: '2024-01-03T00:00:00.000Z',
  sort_key: '2024-01-03 00:00:00+00',
};

class ScriptedDriver extends DummyDriver {
  constructor(private readonly statements: Statement[]) {
    super();
  }

  override acquireConnection(): Promise<DatabaseConnection> {
    const { statements } = this;
    return Promise.resolve({
      executeQuery: (query) => {
        statements.push({ sql: query.sql, parameters: query.parameters });
        const rows = query.sql.includes('justice.cases') ? [{ ...CASE_ROW }] : [];
        return Promise.resolve({ rows: rows as never[] });
      },
      streamQuery: async function* () {
        // never streamed by the judicial repos
      },
    });
  }
}

const scriptedDb = (): { db: Kysely<ProdDatabase>; statements: Statement[] } => {
  const statements: Statement[] = [];
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(statements),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
};

const BOUND: FilterInput = { institutionCode: { in: [COURT] } };
const LIST = { sort: 'modifiedAt', dir: 'desc', page: { first: 10 } } as const;

/**
 * No statement asks PostgreSQL for the object text, and none carries the
 * needle: once the null that stands in for the column is set aside, the word
 * `object` does not occur in the SQL at all, under any alias or quoting.
 */
const expectObjectNeverRead = (statements: readonly Statement[]): void => {
  expect(statements.length).toBeGreaterThan(0);
  for (const statement of statements) {
    expect(statement.sql).toContain('null::text as object');
    expect(statement.sql.replaceAll('null::text as object', '')).not.toMatch(/object/iu);
    expect(JSON.stringify(statement.parameters)).not.toContain(NEEDLE);
  }
};

describe('judicial case object text: not published, not searchable (JUST-9Q9C)', () => {
  it('a case read by id carries no object text', async () => {
    const { db, statements } = scriptedDb();
    const found = (await makeJudicialCaseRepo(db).getById('9'))._unsafeUnwrap();
    expect(found).toMatchObject({ caseId: '9', caseNumber: '9/1/2024', category: 'civil' });
    expect(found?.object).toBeNull();
    expectObjectNeverRead(statements);
  });

  it('a case read by its natural key carries no object text', async () => {
    const { db, statements } = scriptedDb();
    const found = (
      await makeJudicialCaseRepo(db).getByNaturalKey(COURT, '9/1/2024')
    )._unsafeUnwrap();
    expect(found?.caseId).toBe('9');
    expect(found?.object).toBeNull();
    expectObjectNeverRead(statements);
  });

  it('the case list carries no object text', async () => {
    const { db, statements } = scriptedDb();
    const page = (
      await makeJudicialCaseRepo(db).listCursor({ ...LIST, filter: BOUND })
    )._unsafeUnwrap();
    expect(page.items.map((item) => [item.node.caseId, item.node.object])).toEqual([['9', null]]);
    expect(JSON.stringify(page)).not.toContain(NEEDLE);
    expectObjectNeverRead(statements);
  });

  it('the q filter is refused on the list, before any SQL, without repeating the query', async () => {
    const { db, statements } = scriptedDb();
    const res = await makeJudicialCaseRepo(db).listCursor({
      ...LIST,
      filter: { ...BOUND, q: { contains: NEEDLE } },
    });
    expect(res.isErr()).toBe(true);
    const error = res._unsafeUnwrapErr();
    expect([error.type, 'field' in error ? error.field : null]).toEqual(['InvalidInput', 'q']);
    expect(error.message).not.toContain(NEEDLE);
    expect(statements).toHaveLength(0);
  });

  it('the q filter is refused on the caseload aggregate too', async () => {
    for (const groupBy of ['court', 'category', 'year', 'courtLevel'] as const) {
      const { db, statements } = scriptedDb();
      const res = await makeJudicialCaseRepo(db).aggregate({
        groupBy,
        filter: { ...BOUND, q: { contains: NEEDLE } },
      });
      expect(res.isErr()).toBe(true);
      const error = res._unsafeUnwrapErr();
      expect([error.type, 'field' in error ? error.field : null]).toEqual(['InvalidInput', 'q']);
      expect(error.message).not.toContain(NEEDLE);
      expect(statements).toHaveLength(0);
    }
  });

  it('a null q and the presence filter are still accepted', async () => {
    for (const filter of [
      { ...BOUND, q: null },
      { ...BOUND, q: { contains: null } },
      { ...BOUND, hasObject: { isNull: false } },
    ]) {
      const { db } = scriptedDb();
      const res = await makeJudicialCaseRepo(db).listCursor({
        ...LIST,
        filter: filter as unknown as FilterInput,
      });
      expect(res.isOk()).toBe(true);
    }
  });
});
