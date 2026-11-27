/**
 * JUST-9Q9C (26 November 2026): the judicial module publishes NO party name,
 * for any kind.
 *
 * Neither name read (the id lookup, the name search) returns anything, for a
 * company or for a public entity, and neither touches the database. Courts,
 * case numbers, hearings and the
 * company-litigation counts keep working; a party or a litigation summary just
 * carries no name. (The case object text is withheld by the same switch:
 * no-case-object-text.test.ts.)
 *
 * A small in-memory dictionary stands in for PostgreSQL: it answers a name
 * read with the rows whose kind the statement binds, which is what
 * `party_kind = any($kinds)` does. The proof against a real server is
 * tests/e2e/judicial-no-party-names.test.ts.
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

import { resolveJudicialFilters } from '@/modules/judicial/core/usecases.js';
import { makeJudicialCompanyLinkRepo } from '@/modules/judicial/shell/repo/company-link-repo.js';
import { PARTY_NAMES_PUBLISHED } from '@/modules/judicial/shell/repo/constants.js';
import { makeJudicialCourtRepo } from '@/modules/judicial/shell/repo/courts-repo.js';
import { makeJudicialPartyDictionaryRepo } from '@/modules/judicial/shell/repo/party-dictionary-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

type Answer = (statement: Statement) => readonly unknown[];

class ScriptedDriver extends DummyDriver {
  constructor(
    private readonly answer: Answer,
    private readonly statements: Statement[]
  ) {
    super();
  }

  override acquireConnection(): Promise<DatabaseConnection> {
    const { answer, statements } = this;
    return Promise.resolve({
      executeQuery: (query) => {
        const statement = { sql: query.sql, parameters: query.parameters };
        statements.push(statement);
        return Promise.resolve({ rows: [...answer(statement)] as never[] });
      },
      streamQuery: async function* () {
        // never streamed by the judicial repos
      },
    });
  }
}

const scriptedDb = (answer: Answer): { db: Kysely<ProdDatabase>; statements: Statement[] } => {
  const statements: Statement[] = [];
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(answer, statements),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
};

/** Synthetic dictionary rows; both trace to a party row with a publishable rule. */
const COMPANY = {
  name_key_id: '11',
  display_name: 'FIXTURE ALFA SRL',
  party_kind: 'company',
  legal_form: 'SRL',
};
const PUBLIC_ENTITY = {
  name_key_id: '12',
  display_name: 'FIXTURE ALFA INSTITUTIE',
  party_kind: 'public_entity',
  legal_form: null,
};
const DICTIONARY = 'justice.party_name_keys';

/**
 * The database as it would answer: a dictionary read gets the rows whose kind
 * it binds; the company-litigation summary gets one case of one name key.
 */
const database =
  (linkedNameKey: string): Answer =>
  ({ sql, parameters }) => {
    if (sql.includes(DICTIONARY)) {
      return [COMPANY, PUBLIC_ENTITY].filter((row) => parameters.includes(row.party_kind));
    }
    if (sql.includes('justice.party_company_candidates')) {
      return [{ court_level: 'tribunal', year: 2024, cnt: '1', name_key_id: linkedNameKey }];
    }
    return [];
  };

const onDictionary = (statements: readonly Statement[]): Statement[] =>
  statements.filter((statement) => statement.sql.includes(DICTIONARY));

describe('judicial party names: none is published (JUST-9Q9C)', () => {
  it('party names are switched off', () => {
    expect(PARTY_NAMES_PUBLISHED).toBe(false);
  });

  it('the id lookup returns no name for a company or a public entity, and reads nothing', async () => {
    const { db, statements } = scriptedDb(database('11'));
    const repo = makeJudicialPartyDictionaryRepo(db);
    const names = (await repo.getPublishableNames(['11', '12']))._unsafeUnwrap();
    expect(names.size).toBe(0);
    expect((await repo.getPublishableName('11'))._unsafeUnwrap()).toBeNull();
    expect((await repo.getPublishableName('12'))._unsafeUnwrap()).toBeNull();
    expect(statements).toHaveLength(0);
  });

  it('the name search returns no name for a company or a public entity, and reads nothing', async () => {
    const { db, statements } = scriptedDb(database('11'));
    const dictionary = makeJudicialPartyDictionaryRepo(db);
    expect((await dictionary.resolveCompanyName('alfa', 50))._unsafeUnwrap()).toEqual([]);
    // The same through the discovery usecase every transport calls.
    const repos = { courts: makeJudicialCourtRepo(db), dictionary };
    expect(
      (await resolveJudicialFilters(repos, 'companyName', 'alfa', 50))._unsafeUnwrap()
    ).toEqual([]);
    expect(statements).toHaveLength(0);
  });

  it('company litigation keeps its count and carries no name, whatever the linked key is', async () => {
    for (const linkedNameKey of ['11', '12']) {
      const { db, statements } = scriptedDb(database(linkedNameKey));
      const links = makeJudicialCompanyLinkRepo(db, makeJudicialPartyDictionaryRepo(db));
      const summary = (await links.summaryForCui('900001'))._unsafeUnwrap();
      expect([summary.caseCount, summary.companyName]).toEqual([1, null]);
      expect(onDictionary(statements)).toHaveLength(0);
    }
  });
});
