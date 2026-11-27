/**
 * LOC-XMCM (26 November 2026): the salary claims are withheld pending review.
 *
 * `listSalaryClaims` answers an empty page for every CUI and issues no
 * statement, so `primariiEntitySalaryClaims` is an empty connection. A scripted
 * database stands in for PostgreSQL: it would answer claim rows and a count to
 * any statement, and it records every statement it is sent.
 */

import { Kind, parse } from 'graphql';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { makePrimariiResolvers } from '@/modules/primarii-transparency/shell/graphql/resolvers.js';
import { primariiTypeDefs } from '@/modules/primarii-transparency/shell/graphql/typedefs.js';
import { SALARY_CLAIMS_PUBLISHED } from '@/modules/primarii-transparency/shell/repo/constants.js';
import { makePrimariiRepo } from '@/modules/primarii-transparency/shell/repo/primarii-repo.js';
import { buildNextCursor, type ProdDatabase } from '@/modules/shared/index.js';

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

class ScriptedDriver extends DummyDriver {
  constructor(
    private readonly answer: (statement: Statement) => readonly unknown[],
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
        // never streamed by this repo
      },
    });
  }
}

/** Synthetic: its check digit is not valid, so it is the CUI of no town hall. */
const CUI = '90000001';
const CLAIMS = 'primarii_transparency"."salary_amount_claims';
const MARKER_AMOUNT = '987654.32';
const MARKER_ROLE = 'ROL DE TEST';

/** Synthetic stored claims: every statement on the table would be answered. */
const claimRow = (id: string) => ({
  salary_amount_claim_id: id,
  cui: CUI,
  document_pk: null,
  amount_ron: MARKER_AMOUNT,
  role_title: MARKER_ROLE,
  period_start: '2025-01-01',
  period_end: '2025-12-31',
  confidence: 0.9,
});

const world = () => {
  const statements: Statement[] = [];
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new ScriptedDriver((statement) => {
          if (!statement.sql.includes(CLAIMS)) return [];
          return statement.sql.includes('count(*)')
            ? [{ cnt: '3' }]
            : [claimRow('3'), claimRow('2'), claimRow('1')];
        }, statements),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const repo = makePrimariiRepo(db, { territoryFilterAvailable: false });
  return { repo, statements };
};

const EMPTY_PAGE = { items: [], next: null, totalCount: 0 };

describe('the salary claims are withheld pending review', () => {
  it('the switch is off', () => {
    expect(SALARY_CLAIMS_PUBLISHED).toBe(false);
  });

  it('answers an empty page and issues no statement', async () => {
    const { repo, statements } = world();
    const page = (await repo.listSalaryClaims(CUI, { first: 20 }))._unsafeUnwrap();
    expect(page).toEqual(EMPTY_PAGE);
    expect(statements).toEqual([]);
  });

  it('a cursor of an earlier page reads nothing either', async () => {
    const { repo, statements } = world();
    const after = buildNextCursor({
      sort: 'amount_ron',
      dir: 'desc',
      fhash: `salary:${CUI}`,
      lastKeys: [MARKER_AMOUNT, '2'],
    });
    const page = (await repo.listSalaryClaims(`RO${CUI}`, { first: 1, after }))._unsafeUnwrap();
    expect(page).toEqual(EMPTY_PAGE);
    expect(statements).toEqual([]);
  });

  it('a malformed cursor is still refused', async () => {
    const { repo, statements } = world();
    const res = await repo.listSalaryClaims(CUI, { first: 5, after: 'not-a-cursor' });
    expect(res.isErr() && res.error.type).toBe('InvalidInput');
    expect(statements).toEqual([]);
  });

  it('an invalid CUI is still refused', async () => {
    const { repo, statements } = world();
    const res = await repo.listSalaryClaims('not-a-cui', { first: 20 });
    expect(res.isErr() && res.error.type).toBe('InvalidInput');
    expect(statements).toEqual([]);
  });

  it('the GraphQL root is an empty connection with no stored value in it', async () => {
    const { repo, statements } = world();
    const resolvers = makePrimariiResolvers({
      repo,
      identityRepo: {} as never,
      registry: { register: () => undefined, list: () => [], get: () => undefined },
    }) as {
      Query: {
        primariiEntitySalaryClaims: (
          root: unknown,
          args: { cui: string; first?: number | null; after?: string | null }
        ) => Promise<unknown>;
      };
    };
    const connection = await resolvers.Query.primariiEntitySalaryClaims(null, {
      cui: CUI,
      first: 5,
    });
    expect(connection).toEqual({
      edges: [],
      pageInfo: { hasNextPage: false, endCursor: null },
      totalCount: 0,
    });
    const text = JSON.stringify(connection);
    expect(text).not.toContain(MARKER_AMOUNT);
    expect(text).not.toContain(MARKER_ROLE);
    expect(statements).toEqual([]);
  });

  it('the schema still parses and says the query is withheld', () => {
    const document = parse(primariiTypeDefs);
    const descriptions = document.definitions.flatMap((definition) =>
      definition.kind === Kind.OBJECT_TYPE_EXTENSION && definition.name.value === 'Query'
        ? (definition.fields ?? [])
            .filter((field) => field.name.value === 'primariiEntitySalaryClaims')
            .map((field) => field.description?.value ?? '')
        : []
    );
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]).toContain('Withheld pending review');
  });

  it('control: the scripted database records the statements of another read', async () => {
    const { repo, statements } = world();
    await repo.listSnapshots(CUI, { first: 5 });
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.some((s) => s.sql.includes(CLAIMS))).toBe(false);
  });
});
