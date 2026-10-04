/**
 * Judicial A3 — the input contract, through the REAL module (SDL + resolvers +
 * usecases + repos + MCP tools) with the REAL kernel scalar resolvers, over an
 * in-memory scripted Kysely driver that records every statement. No database.
 *
 * What this file pins: typed InvalidInput / INVALID_INPUT BEFORE any SQL or
 * repo access; null-at-optional-position meaning absent on every surface; the
 * compiled year interval (its parameters are the intersection, its form native
 * January boundaries or native extract); discovery and groupBy validation; the
 * direct-ID int8 guard; the repaired company query/cursor; and the A3
 * filter-semantics case-cursor identity. What PostgreSQL decides (row
 * membership, 42P10, session years, aggregate keys) is proven on actual DDL by
 * tests/integration/judicial/judicial-a3.pg.test.ts.
 *
 * Surfaces differ on purpose: GraphQL itself rejects a fractional or
 * out-of-range Int, a string for an Int and a null member of a non-null list
 * (a GraphQL validation error, before any resolver); only values GraphQL admits
 * (zero, compound years, an unknown court level in the String-typed case
 * filter, nulls at optional positions, unknown dim / limit 0) reach the module.
 * MCP has its schema plus the direct handler; both are exercised.
 */

import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql } from 'graphql';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  getCourtCaseload,
  listCases,
  resolveJudicialFilters,
  type JudicialRepos,
} from '@/modules/judicial/core/usecases.js';
import { makeJudicialModule } from '@/modules/judicial/index.js';
import { judicialCasesSpec } from '@/modules/judicial/shell/filters/judicial.spec.js';
import { makeJudicialMcpTools } from '@/modules/judicial/shell/mcp/tools.js';
import { makeJudicialCaseRepo } from '@/modules/judicial/shell/repo/cases-repo.js';
import {
  buildNextCursor,
  createContributorRegistry,
  decodeCursor,
  fhashFor,
  kernelToolInputSchema,
  type FilterInput,
  type KernelMcpTool,
  type McpToolOutput,
  type ProdDatabase,
} from '@/modules/shared/index.js';
import { scalarResolvers, scalarTypeDefs } from '@/modules/shared/shell/graphql/scalars.js';

const GLUE_TYPEDEFS =
  `${scalarTypeDefs}\n` +
  'type PageInfo { hasNextPage: Boolean! endCursor: String }\n' +
  'type LegalAct { actId: BigInt }\n' +
  'type Query { ping: String }\n';

interface Executed {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

type Respond = (query: Executed) => readonly unknown[];

const scriptedDb = (respond: Respond, executed: Executed[]): Kysely<ProdDatabase> => {
  class ScriptedDriver extends DummyDriver {
    override acquireConnection() {
      return Promise.resolve({
        executeQuery: (query: CompiledQuery) => {
          const q = { sql: query.sql, parameters: query.parameters };
          executed.push(q);
          return Promise.resolve({ rows: [...respond(q)] as never[] });
        },
        streamQuery: () => {
          throw new Error('unused');
        },
      });
    }
  }
  return new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
};

const fixture = (respond: Respond = () => []) => {
  const executed: Executed[] = [];
  const db = scriptedDb(respond, executed);
  const module = makeJudicialModule({
    db,
    registry: createContributorRegistry(),
    legalActLoader: () => undefined,
  });
  const schema = makeExecutableSchema({
    typeDefs: GLUE_TYPEDEFS + module.graphqlSlice.typeDefs,
    resolvers: {
      ...scalarResolvers,
      ...(module.graphqlResolvers as Record<string, never>),
    },
  });
  const run = async (source: string, variableValues?: Record<string, unknown>) => {
    const result = await graphql({
      schema,
      source,
      ...(variableValues !== undefined && { variableValues }),
    });
    return {
      data: result.data ?? null,
      errors: result.errors?.map((e) => ({ message: e.message, code: e.extensions['code'] })),
    };
  };
  const tool = (name: string): KernelMcpTool => {
    const found = module.mcpTools.find((t) => t.name === name);
    if (found === undefined) throw new Error(`tool ${name} missing`);
    return found;
  };
  /** The REAL MCP input schema decision for these arguments. */
  const schemaAccepts = (name: string, args: Record<string, unknown>): boolean =>
    kernelToolInputSchema(tool(name)).safeParse(args).success;
  /** Through the schema, then the handler (the external MCP path). */
  const mcp = async (name: string, args: Record<string, unknown>): Promise<McpToolOutput> => {
    const parsed = kernelToolInputSchema(tool(name)).safeParse(args);
    if (!parsed.success) throw new Error(`mcp schema rejected ${name}`);
    return tool(name).handler(parsed.data);
  };
  /** The handler alone (a direct invocation that bypasses the schema). */
  const direct = (name: string, args: Record<string, unknown>): Promise<McpToolOutput> =>
    tool(name).handler(args);
  return { executed, run, schemaAccepts, mcp, direct, db };
};

const COURT = 'TEST_A3_COURT';
const BOUND = { institutionCode: { in: [COURT] } };

const LIST = `query ($filter: JudicialCasesFilter, $first: Int, $after: String) {
  judicialCases(filter: $filter, first: $first, after: $after) {
    edges { cursor node { caseId } } pageInfo { hasNextPage endCursor } } }`;
const CASELOAD = `query ($groupBy: JudicialAggregateGroupBy!, $filter: JudicialCasesFilter) {
  judicialCaseload(groupBy: $groupBy, filter: $filter) { groups { key caseCount } denominator coverage } }`;
const DETAIL = `query ($id: BigInt) { judicialCase(caseId: $id) { case { caseId } } }`;
const CITING = `query ($id: BigInt!, $after: String) { judicialCasesCitingAct(targetActId: $id, first: 1, after: $after) {
  edges { cursor node { caseId } } pageInfo { endCursor } } }`;
const RESOLVE = `query ($dim: String!, $q: String!, $limit: Int) { judicialResolve(dim: $dim, q: $q, limit: $limit) { value } }`;
const COMPANY = `query ($courtLevel: [JudicialCourtLevel!], $category: [String!], $yearFrom: Int, $yearTo: Int) {
  judicialCompanyLitigation(cui: "RO123", courtLevel: $courtLevel, category: $category, yearFrom: $yearFrom, yearTo: $yearTo) {
    caseCount years { year count } courtLevels { courtLevel count } caveats } }`;
const COMPANY_CASES = `query ($first: Int, $after: String, $courtLevel: [JudicialCourtLevel!], $yearFrom: Int, $yearTo: Int, $category: [String!]) {
  judicialCompanyLitigationCases(cui: "RO123", first: $first, after: $after, courtLevel: $courtLevel, yearFrom: $yearFrom, yearTo: $yearTo, category: $category) {
    edges { cursor node { caseId institutionCode caseNumber category sourceOpenedAt } } pageInfo { hasNextPage endCursor } } }`;

const isCaseList = (q: Executed): boolean =>
  q.sql.includes('from justice.cases c') && q.sql.includes(' as sort_key');
const listQuery = (executed: readonly Executed[]): Executed => {
  const q = executed.find(isCaseList);
  if (q === undefined) throw new Error('no case-list statement ran');
  return q;
};

const INVALID = 'INVALID_INPUT';
/** A year BOUND compiled through native extract (the display select also uses extract). */
const YEAR_EXTRACT_BOUND = /extract\(year from c\.source_opened_at\) (>=|<=)/u;

// ── virtual fields: court level and year ───────────────────────────────────────

describe('A3 virtual fields — validated by the repo before any SQL', () => {
  const LEVELS = [
    'judecatorie',
    'tribunal',
    'tribunal_militar',
    'curte_de_apel',
    'curte_militara_apel',
    'inalta_curte',
  ] as const;

  it('an unknown case-filter courtLevel is INVALID_INPUT with zero SQL (GraphQL types it as String)', async () => {
    const f = fixture();
    const res = await f.run(LIST, { filter: { courtLevel: { in: ['iccj'] } }, first: 2 });
    expect(res.data).toBeNull();
    expect(res.errors?.[0]?.code).toBe(INVALID);
    expect(res.errors?.[0]?.message).toMatch(/^courtLevel must be one of judecatorie, tribunal/u);
    expect(f.executed).toEqual([]);
  });

  it('every real court level still binds as a SQL parameter', async () => {
    const f = fixture();
    const res = await f.run(LIST, { filter: { courtLevel: { in: [...LEVELS] } }, first: 2 });
    expect(res.errors).toBeUndefined();
    expect(listQuery(f.executed).parameters).toEqual([...LEVELS, 3]);
  });

  it.each([
    ['an unsupported year operator', { ...BOUND, year: { gt: 2020 } }],
    ['an unsupported courtLevel operator', { ...BOUND, courtLevel: { eq: 'tribunal' } }],
    ['a scalar year filter', { ...BOUND, year: 2024 }],
    ['a list year filter', { ...BOUND, year: [2024] }],
    ['a scalar between', { ...BOUND, year: { between: 2024 } }],
    ['a between with another key', { ...BOUND, year: { between: { from: 2020, upto: 2024 } } }],
    ['a scalar courtLevel in', { ...BOUND, courtLevel: { in: 'tribunal' } }],
    ['a numeric courtLevel member', { ...BOUND, courtLevel: { in: [1] } }],
    ['a null courtLevel member', { ...BOUND, courtLevel: { in: ['tribunal', null] } }],
    ['a null institution member', { institutionCode: { in: [COURT, null] } }],
    ['a numeric category member (never stringified)', { ...BOUND, category: { in: [5] } }],
    ['an object category member', { ...BOUND, category: { in: [{}] } }],
    ['a scalar field filter', { institutionCode: COURT }],
    ['an unknown field', { ...BOUND, partyName: { in: ['x'] } }],
    ['a non-boolean isNull', { ...BOUND, hasObject: { isNull: 'true' } }],
    ['a non-string date bound', { modified: { gte: 20240101 } }],
    ['a list as the filter', [BOUND]],
  ])('direct: %s is InvalidInput before any SQL', async (_label, filter) => {
    const f = fixture();
    const repos = { cases: makeJudicialCaseRepo(f.db) };
    const res = await listCases(repos, {
      filter: filter as never,
      sort: 'modifiedAt',
      dir: 'desc',
      page: { first: 2 },
    });
    expect(res._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(f.executed).toEqual([]);
  });
});

describe('A3 year operands — original nonzero 32-bit integers on every surface', () => {
  it.each([
    ['zero', 0],
    ['a fraction', 2024.5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['above Int', 2_147_483_648],
    ['below Int', -2_147_483_649],
    ['a numeric string', '2024'],
    ['a boolean', true],
  ])('direct: %s is InvalidInput before any SQL', async (_label, year) => {
    for (const filter of [
      { ...BOUND, year: { eq: year } },
      { ...BOUND, year: { gte: year } },
      { ...BOUND, year: { lte: year } },
      { ...BOUND, year: { between: { from: year } } },
      { ...BOUND, year: { between: { to: year } } },
    ]) {
      const f = fixture();
      const res = await listCases(
        { cases: makeJudicialCaseRepo(f.db) },
        { filter, sort: 'modifiedAt', dir: 'desc', page: { first: 2 } }
      );
      expect(res._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'year' });
      expect(f.executed).toEqual([]);
    }
  });

  it('GraphQL: year 0 reaches the module and is INVALID_INPUT with zero SQL', async () => {
    const f = fixture();
    const res = await f.run(LIST, { filter: { ...BOUND, year: { eq: 0 } }, first: 2 });
    expect(res.errors).toEqual([
      {
        message: 'year operands must be nonzero 32-bit integers (1 BC is -1, 2 BC is -2)',
        code: INVALID,
      },
    ]);
    expect(f.executed).toEqual([]);
  });

  it('GraphQL itself rejects a fraction, a string and an out-of-range Int (before any resolver)', async () => {
    for (const year of [2024.5, '2024', 2_147_483_648]) {
      const f = fixture();
      const res = await f.run(LIST, { filter: { ...BOUND, year: { eq: year } }, first: 2 });
      expect(res.errors?.[0]?.code).not.toBe(INVALID);
      expect(res.errors?.length).toBe(1);
      expect(f.executed).toEqual([]);
    }
  });

  it('MCP: the schema and the direct handler reject the same operands, typed', async () => {
    for (const year of [0, 2024.5, 2_147_483_648, -2_147_483_649, '2024']) {
      const f = fixture();
      const args = { groupBy: 'court', institutionCode: [COURT], yearFrom: year };
      expect(f.schemaAccepts('get_court_caseload', args)).toBe(false);
      const out = await f.direct('get_court_caseload', args);
      expect(out).toMatchObject({ ok: false, errorType: 'InvalidInput', errorCode: INVALID });
      expect(f.executed).toEqual([]);
    }
    const f = fixture();
    expect(f.schemaAccepts('get_court_caseload', { groupBy: 'court', yearFrom: -1 })).toBe(true);
    expect(f.schemaAccepts('get_court_caseload', { groupBy: 'court', yearTo: 2_147_483_647 })).toBe(
      true
    );
  });
});

describe('A3 year interval — intersected once, compiled once', () => {
  const compiled = async (year: Record<string, unknown>) => {
    const f = fixture();
    const res = await f.run(LIST, { filter: { ...BOUND, year }, first: 2 });
    expect(res.errors).toBeUndefined();
    return listQuery(f.executed);
  };

  it.each([
    // [operators, literal parameters after the court and before the limit]
    ['eq 2024 + gte 2020 (only 2024)', { eq: 2024, gte: 2020 }, [2024, 2025]],
    ['eq 2024 + lte 2026 (only 2024)', { eq: 2024, lte: 2026 }, [2024, 2025]],
    ['gte 2020 + lte 2024', { gte: 2020, lte: 2024 }, [2020, 2025]],
    [
      'gte 2021 + between 2020..2024',
      { gte: 2021, between: { from: 2020, to: 2024 } },
      [2021, 2025],
    ],
    [
      'lte 2022 + between 2020..2024',
      { lte: 2022, between: { from: 2020, to: 2024 } },
      [2020, 2023],
    ],
    [
      'eq + gte + lte + between all agreeing',
      { eq: 2023, gte: 2020, lte: 2024, between: { from: 2021, to: 2025 } },
      [2023, 2024],
    ],
    ['gte only', { gte: 2023 }, [2023]],
    ['lte only (upper boundary is next January)', { lte: 2023 }, [2024]],
    ['between.from only', { between: { from: 2023 } }, [2023]],
    ['between.to null is absent', { between: { from: 2023, to: null } }, [2023]],
    ['eq null is absent beside a real bound', { eq: null, gte: 2023 }, [2023]],
  ])('%s', async (_label, year, params) => {
    const q = await compiled(year);
    expect(q.parameters).toEqual([COURT, ...params, 3]);
    expect(q.sql).toContain('isfinite(c.source_opened_at)');
    expect(q.sql).not.toMatch(YEAR_EXTRACT_BOUND);
  });

  it.each([
    ['eq 2024 + lte 2023', { eq: 2024, lte: 2023 }],
    ['gte 2025 + lte 2024', { gte: 2025, lte: 2024 }],
    ['between 2024..2020 (reversed)', { between: { from: 2024, to: 2020 } }],
    ['eq 2020 + eq-like between 2021', { eq: 2020, between: { from: 2021, to: 2021 } }],
  ])('contradictory %s compiles to FALSE and builds no date', async (_label, year) => {
    const q = await compiled(year);
    expect(q.parameters).toEqual([COURT, 3]);
    expect(q.sql).toContain(' and false');
    expect(q.sql).not.toContain('make_date');
    expect(q.sql).not.toMatch(YEAR_EXTRACT_BOUND);
  });

  it.each([
    ['1 BC', { eq: -1 }, 'extract', [-1, -1]],
    ['4714 BC to 4713 BC', { between: { from: -4714, to: -4713 } }, 'extract', [-4714, -4713]],
    ['an expanded year', { eq: 10000 }, 'extract', [10000, 10000]],
    ['the timestamp-domain year', { eq: 294276 }, 'extract', [294276, 294276]],
    ['the session spillover year', { eq: 294277 }, 'extract', [294277, 294277]],
    [
      'the Int extremes',
      { gte: -2_147_483_648, lte: 2_147_483_647 },
      'extract',
      [-2_147_483_648, 2_147_483_647],
    ],
    ['AD 1 (ordinary boundary)', { eq: 1 }, 'native', [1, 2]],
    ['AD 9999 (last ordinary boundary)', { eq: 9999 }, 'native', [9999, 10000]],
  ])('%s uses the %s form', async (_label, year, form, params) => {
    const q = await compiled(year);
    expect(q.parameters).toEqual([COURT, ...params, 3]);
    expect(q.sql).toContain('isfinite(c.source_opened_at)');
    if (form === 'extract') {
      expect(q.sql).toContain('extract(year from c.source_opened_at) >=');
      expect(q.sql).not.toContain('make_date');
    } else {
      expect(q.sql).toContain('c.source_opened_at >= make_date(');
      expect(q.sql).toContain('c.source_opened_at < make_date(');
    }
  });

  it('a mixed interval uses each form for its own bound (BC lower, ordinary upper)', async () => {
    const q = await compiled({ gte: -5, lte: 2000 });
    expect(q.parameters).toEqual([COURT, -5, 2001, 3]);
    expect(q.sql).toContain('extract(year from c.source_opened_at) >=');
    expect(q.sql).toContain('c.source_opened_at < make_date(');
  });

  it('the aggregate compiles the SAME interval and the honest year key', async () => {
    const f = fixture();
    const res = await f.run(CASELOAD, {
      groupBy: 'year',
      filter: { ...BOUND, year: { eq: 2024, gte: 2020 } },
    });
    expect(res.errors).toBeUndefined();
    expect(f.executed).toHaveLength(2);
    for (const q of f.executed) {
      expect(q.parameters).toEqual(expect.arrayContaining([COURT, 2024, 2025]));
      expect(q.parameters).not.toContain(2020);
      expect(q.sql).toContain(
        'when not isfinite(c.source_opened_at) then c.source_opened_at::text'
      );
      expect(q.sql).not.toContain('date_part');
    }
  });

  it('a contradictory interval is checked AFTER the cursor: a bad cursor still errors', async () => {
    const f = fixture();
    const res = await f.run(LIST, {
      filter: { ...BOUND, year: { eq: 2024, lte: 2023 } },
      first: 2,
      after: 'not a cursor!',
    });
    expect(res.errors?.[0]).toMatchObject({ code: INVALID });
    expect(res.errors?.[0]?.message).toMatch(/restart pagination/u);
    expect(f.executed).toEqual([]);
  });
});

// ── optional nulls ─────────────────────────────────────────────────────────────

describe('A3 optional nulls — null means absent; required stays required', () => {
  const listSql = async (filter: unknown) => {
    const f = fixture();
    const res = await f.run(LIST, { filter, first: 2 });
    expect(res.errors).toBeUndefined();
    return listQuery(f.executed);
  };

  it('omitted vs null fields, operators and endpoints compile identically', async () => {
    const plain = await listSql({ ...BOUND, year: { lte: 2024 } });
    for (const filter of [
      { ...BOUND, year: { lte: 2024 }, courtLevel: null, modified: null, category: null },
      { ...BOUND, year: { lte: 2024, eq: null, gte: null, between: null } },
      { ...BOUND, year: { lte: 2024 }, modified: { gte: null, lte: null, between: null } },
      { ...BOUND, year: { lte: 2024, between: { from: null, to: null } } },
      { ...BOUND, year: { lte: 2024 }, q: { contains: null }, hasObject: { isNull: null } },
    ]) {
      expect(await listSql(filter)).toEqual(plain);
    }
  });

  it.each([
    ['a null filter', null],
    ['null fields only', { institutionCode: null, courtLevel: null, year: null, modified: null }],
    ['a year with null operators', { year: { eq: null, gte: null } }],
    ['a year between of nulls', { year: { between: { from: null, to: null } } }],
    ['an empty modified between', { modified: { between: {} } }],
    ['a modified between of nulls', { modified: { between: { from: null } } }],
    ['an empty court-level list', { courtLevel: { in: [] } }],
    ['an empty institution list', { institutionCode: { in: [] } }],
  ])('%s is still UNBOUNDED (typed, zero SQL)', async (_label, filter) => {
    const f = fixture();
    const res = await f.run(LIST, { filter, first: 2 });
    expect(res.errors).toEqual([
      { message: 'judicial case list requires a court or period bound', code: INVALID },
    ]);
    expect(f.executed).toEqual([]);
  });

  it('beside a real bound, an explicit case-filter in:[] matches nothing', async () => {
    for (const filter of [
      { ...BOUND, category: { in: [] } },
      { ...BOUND, courtLevel: { in: [] } },
    ]) {
      const q = await listSql(filter);
      expect(q.sql).toMatch(/ and false/u);
    }
  });

  it('GraphQL itself rejects a null member of a non-null list (before any resolver)', async () => {
    const f = fixture();
    const res = await f.run(LIST, { filter: { institutionCode: { in: [COURT, null] } }, first: 2 });
    expect(res.errors?.[0]?.code).not.toBe(INVALID);
    expect(f.executed).toEqual([]);
  });

  it('courts: null filter parts are absent; a null level member is typed', async () => {
    const f = fixture();
    const res = await f.run(
      'query ($f: JudicialCourtsFilter) { judicialCourts(filter: $f) { institutionCode } }',
      { f: { level: null, countyCode: { in: null }, specialization: { eq: null } } }
    );
    expect(res.errors).toBeUndefined();
    expect(f.executed[0]?.parameters).toEqual([]);
    const g = fixture();
    const repoRes = await (
      await import('@/modules/judicial/shell/repo/courts-repo.js')
    )
      .makeJudicialCourtRepo(g.db)
      .list({ filter: { level: { in: ['tribunal', null] } } as never });
    expect(repoRes._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(g.executed).toEqual([]);
  });

  it('MCP: the schema accepts null optionals and the handler treats them as omitted', async () => {
    const omitted = fixture();
    await omitted.mcp('get_court_caseload', { groupBy: 'court', institutionCode: [COURT] });
    const nulls = fixture();
    const args = {
      groupBy: 'court',
      institutionCode: [COURT],
      courtLevel: null,
      category: null,
      yearFrom: null,
      yearTo: null,
    };
    expect(nulls.schemaAccepts('get_court_caseload', args)).toBe(true);
    await nulls.mcp('get_court_caseload', args);
    const direct = fixture();
    await direct.direct('get_court_caseload', args);
    expect(nulls.executed).toEqual(omitted.executed);
    expect(direct.executed).toEqual(omitted.executed);
  });

  it('MCP direct: null or wrongly typed list members are typed failures, never stringified', async () => {
    for (const args of [
      { groupBy: 'court', institutionCode: [COURT, null] },
      { groupBy: 'court', institutionCode: [COURT], category: [7] },
      { groupBy: 'court', institutionCode: COURT },
    ]) {
      const f = fixture();
      expect(f.schemaAccepts('get_court_caseload', args)).toBe(false);
      const out = await f.direct('get_court_caseload', args);
      expect(out).toMatchObject({ ok: false, errorType: 'InvalidInput', errorCode: INVALID });
      expect(f.executed).toEqual([]);
    }
  });

  it('GraphQL first: null and limit: null mean their defaults', async () => {
    const f = fixture();
    await f.run(LIST, { filter: BOUND, first: null });
    expect(listQuery(f.executed).parameters).toEqual([COURT, 21]);
  });
});

// ── flat company arguments ─────────────────────────────────────────────────────

describe('A3 flat company arguments — null is absent, empty lists keep no-narrowing', () => {
  const companySql = (executed: readonly Executed[]) => {
    const q = executed.find((x) => x.sql.includes('party_company_candidates'));
    if (q === undefined) throw new Error('no company statement ran');
    return q;
  };

  it('explicit nulls compile exactly like omission (the pre-A3 code threw on a null list)', async () => {
    const omitted = fixture();
    const a = await omitted.run(COMPANY, {});
    expect(a.errors).toBeUndefined();
    const nulls = fixture();
    const b = await nulls.run(COMPANY, {
      courtLevel: null,
      category: null,
      yearFrom: null,
      yearTo: null,
    });
    expect(b.errors).toBeUndefined();
    expect(b.data).toEqual(a.data);
    expect(companySql(nulls.executed)).toEqual(companySql(omitted.executed));
    // Never Number(null): no year predicate, no make_date(1, ...) upper bound.
    expect(companySql(nulls.executed).sql).not.toContain('make_date');
  });

  it('an empty list does not narrow (the existing flat semantics)', async () => {
    const omitted = fixture();
    await omitted.run(COMPANY, {});
    const empty = fixture();
    await empty.run(COMPANY, { courtLevel: [], category: [] });
    expect(companySql(empty.executed)).toEqual(companySql(omitted.executed));
  });

  it('years are validated and compiled with the shared interval (finite, intersection, no make_date(0))', async () => {
    const f = fixture();
    await f.run(COMPANY, { yearFrom: 2020, yearTo: 2024 });
    const q = companySql(f.executed);
    expect(q.parameters).toEqual(['published', '123', 2020, 2025]);
    expect(q.sql).toContain('isfinite(c.source_opened_at)');
    const zero = fixture();
    const res = await zero.run(COMPANY, { yearFrom: 0 });
    expect(res.errors).toEqual([
      {
        message: 'year operands must be nonzero 32-bit integers (1 BC is -1, 2 BC is -2)',
        code: INVALID,
      },
    ]);
    expect(zero.executed).toEqual([]);
    const contradictory = fixture();
    await contradictory.run(COMPANY, { yearFrom: 2025, yearTo: 2020 });
    expect(companySql(contradictory.executed).sql).toContain(' and false');
  });

  it('MCP: schema and direct handler agree on nulls, years and members', async () => {
    const omitted = fixture();
    await omitted.mcp('get_company_litigation', { cui: 'RO123' });
    const nulls = fixture();
    const args = { cui: 'RO123', courtLevel: null, category: null, yearFrom: null, yearTo: null };
    expect(nulls.schemaAccepts('get_company_litigation', args)).toBe(true);
    await nulls.mcp('get_company_litigation', args);
    expect(nulls.executed).toEqual(omitted.executed);
    for (const bad of [
      { cui: 'RO123', yearFrom: '2020' },
      { cui: 'RO123', yearTo: 0 },
      { cui: 'RO123', yearTo: 1.5 },
      { cui: 'RO123', courtLevel: ['iccj'] },
      { cui: 'RO123', courtLevel: 'tribunal' },
      { cui: 'RO123', category: [null] },
    ]) {
      const f = fixture();
      expect(f.schemaAccepts('get_company_litigation', bad)).toBe(false);
      const out = await f.direct('get_company_litigation', bad);
      expect(out).toMatchObject({ ok: false, errorType: 'InvalidInput', errorCode: INVALID });
      expect(f.executed).toEqual([]);
    }
  });
});

// ── the company query and cursor ───────────────────────────────────────────────

describe('A3 company case list — numeric DISTINCT key, strict cursor, truthful date', () => {
  const linkRows = [
    {
      case_id_sort: '9007199254740993',
      case_id: '9007199254740993',
      institution_code: COURT,
      case_number: '1/1/2024',
      category: null,
      source_opened_at: '0001-12-31 BC',
    },
    {
      case_id_sort: '100',
      case_id: '100',
      institution_code: COURT,
      case_number: '2/1/2024',
      category: 'civil',
      source_opened_at: 'infinity',
    },
    {
      case_id_sort: '10',
      case_id: '10',
      institution_code: COURT,
      case_number: '3/1/2024',
      category: null,
      source_opened_at: null,
    },
  ];
  /** The pre-A3 company identity, written out independently (it must NOT change). */
  const COMPANY_FHASH =
    'judicial_company_cases:123:{"courtLevels":[],"categories":[],"yearFrom":null,"yearTo":null}';

  it('selects the native id in the DISTINCT list, orders numerically and keeps the key internal', async () => {
    const f = fixture((q) => (q.sql.includes('party_company_candidates') ? linkRows : []));
    const res = await f.run(COMPANY_CASES, { first: 2 });
    expect(res.errors).toBeUndefined();
    const q = f.executed[0];
    expect(q?.sql).toContain(
      'select distinct c.case_id as case_id_sort, c.case_id::text as case_id'
    );
    expect(q?.sql).toContain('order by c.case_id desc');
    const conn = res.data?.['judicialCompanyLitigationCases'] as {
      edges: { cursor: string; node: Record<string, unknown> }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
    expect(conn.edges.map((e) => e.node)).toEqual([
      {
        caseId: '9007199254740993',
        institutionCode: COURT,
        caseNumber: '1/1/2024',
        category: null,
        sourceOpenedAt: '0001-12-31 BC',
      },
      {
        caseId: '100',
        institutionCode: COURT,
        caseNumber: '2/1/2024',
        category: 'civil',
        sourceOpenedAt: 'infinity',
      },
    ]);
    for (const edge of conn.edges) {
      expect(Object.keys(edge.node)).not.toContain('caseIdSort');
    }
    const expected = { sort: 'caseId', dir: 'desc', fhash: COMPANY_FHASH } as const;
    expect(conn.edges.map((e) => decodeCursor(e.cursor, expected)._unsafeUnwrap().keys)).toEqual([
      ['9007199254740993'],
      ['100'],
    ]);
    expect(conn.pageInfo).toEqual({ hasNextPage: true, endCursor: conn.edges[1]?.cursor });
  });

  it('following an edge cursor sends the exact id; a numeric or non-canonical key fails before SQL', async () => {
    const f = fixture((q) => (q.sql.includes('party_company_candidates') ? linkRows : []));
    const first = await f.run(COMPANY_CASES, { first: 1 });
    const cursor = (
      first.data?.['judicialCompanyLitigationCases'] as { edges: { cursor: string }[] }
    ).edges[0]?.cursor;
    await f.run(COMPANY_CASES, { first: 1, after: cursor });
    expect(f.executed[1]?.parameters).toContain('9007199254740993');
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    for (const bad of [
      b64(
        `{"v":1,"sort":"caseId","dir":"desc","keys":[9007199254740993],"fhash":${JSON.stringify(COMPANY_FHASH)}}`
      ),
      b64(
        JSON.stringify({ v: 1, sort: 'caseId', dir: 'desc', keys: ['007'], fhash: COMPANY_FHASH })
      ),
      b64(
        JSON.stringify({
          v: 1,
          sort: 'caseId',
          dir: 'desc',
          keys: ['1', '2'],
          fhash: COMPANY_FHASH,
        })
      ),
      b64(
        JSON.stringify({ v: 1, sort: 'caseId', dir: 'desc', keys: [null], fhash: COMPANY_FHASH })
      ),
    ]) {
      const g = fixture();
      const res = await g.run(COMPANY_CASES, { first: 1, after: bad });
      expect(res.errors?.[0]?.code).toBe(INVALID);
      expect(res.errors?.[0]?.message).toMatch(/restart pagination/u);
      expect(g.executed).toEqual([]);
    }
  });

  it('a pre-A3 valid company token keeps its identity and still resumes', async () => {
    const f = fixture();
    const token = buildNextCursor({
      sort: 'caseId',
      dir: 'desc',
      fhash: COMPANY_FHASH,
      lastKeys: ['100'],
    });
    const res = await f.run(COMPANY_CASES, { first: 1, after: token });
    expect(res.errors).toBeUndefined();
    expect(f.executed[0]?.parameters).toContain('100');
  });

  it('the summary keeps totals and levels, omits non-calendar years, and discloses it', async () => {
    const f = fixture((q) =>
      q.sql.includes('party_company_candidates')
        ? [
            { court_level: 'tribunal', year: 2024, cnt: '2', name_key_id: null },
            { court_level: 'tribunal', year: null, cnt: '3', name_key_id: null },
          ]
        : []
    );
    const res = await f.run(COMPANY, {});
    expect(res.errors).toBeUndefined();
    expect(res.data?.['judicialCompanyLitigation']).toEqual({
      caseCount: 5,
      years: [{ year: 2024, count: 2 }],
      courtLevels: [{ courtLevel: 'tribunal', count: 5 }],
      caveats: [
        '3 published case(s) with a null or infinite sourceOpenedAt are counted in caseCount and courtLevels but omitted from years',
      ],
    });
    const q = f.executed[0];
    expect(q?.sql).toContain('isfinite(c.source_opened_at)');
    expect(q?.sql).not.toContain('date_part');
  });
});

// ── discovery and groupBy ──────────────────────────────────────────────────────

describe('A3 discovery — dim, q and limit validated before any repo access', () => {
  const spyRepos = () => {
    const courts = {
      resolveCourt: vi.fn(async () => ok([])),
      resolveCategory: vi.fn(async () => ok([])),
    };
    const dictionary = { resolveCompanyName: vi.fn(async () => ok([])) };
    const calls = () =>
      courts.resolveCourt.mock.calls.length +
      courts.resolveCategory.mock.calls.length +
      dictionary.resolveCompanyName.mock.calls.length;
    return {
      repos: { courts, dictionary } as unknown as Pick<JudicialRepos, 'courts' | 'dictionary'>,
      courts,
      dictionary,
      calls,
    };
  };

  it.each([
    ['an unknown dim', 'person', 'Ion Popescu', 10, 'dim'],
    ['a non-string dim', 1, 'x', 10, 'dim'],
    ['a missing q', 'court', undefined, 10, 'q'],
    ['a numeric q', 'court', 5, 10, 'q'],
    ['limit 0', 'court', 'x', 0, 'limit'],
    ['limit 51', 'court', 'x', 51, 'limit'],
    ['a fractional limit', 'court', 'x', 1.5, 'limit'],
    ['a NaN limit', 'court', 'x', Number.NaN, 'limit'],
    ['an infinite limit', 'court', 'x', Number.POSITIVE_INFINITY, 'limit'],
    ['a string limit', 'court', 'x', '10', 'limit'],
  ])('%s is InvalidInput with zero repo calls and no echo', async (_l, dim, q, limit, field) => {
    const s = spyRepos();
    const res = await resolveJudicialFilters(s.repos, dim, q, limit);
    const error = res._unsafeUnwrapErr();
    expect(error).toMatchObject({ type: 'InvalidInput', field });
    expect(error.message).not.toContain('Ion');
    expect(s.calls()).toBe(0);
  });

  it('null or omitted limit means 10; 1 and 50 pass through unchanged', async () => {
    for (const [limit, expected] of [
      [undefined, 10],
      [null, 10],
      [1, 1],
      [50, 50],
    ] as const) {
      const s = spyRepos();
      await resolveJudicialFilters(s.repos, 'court', 'Buc', limit);
      expect(s.courts.resolveCourt).toHaveBeenCalledWith('Buc', expected);
    }
  });

  it('all four dimensions still dispatch', async () => {
    const s = spyRepos();
    for (const dim of ['court', 'courtLevel', 'companyName', 'category']) {
      expect((await resolveJudicialFilters(s.repos, dim, 'x', 5)).isOk()).toBe(true);
    }
    expect(s.calls()).toBe(3); // courtLevel is a static enum match
  });

  it('GraphQL: an unknown dim and limit 0 are INVALID_INPUT with zero SQL; null limit is the default', async () => {
    for (const vars of [
      { dim: 'person', q: 'Ion Popescu' },
      { dim: 'court', q: 'x', limit: 0 },
      { dim: 'court', q: 'x', limit: 51 },
    ]) {
      const f = fixture();
      const res = await f.run(RESOLVE, vars);
      expect(res.errors?.[0]?.code).toBe(INVALID);
      expect(JSON.stringify(res.errors)).not.toContain('Ion');
      expect(f.executed).toEqual([]);
    }
    const f = fixture();
    const res = await f.run(RESOLVE, { dim: 'court', q: 'Buc', limit: null });
    expect(res.errors).toBeUndefined();
    expect(f.executed[0]?.parameters.at(-1)).toBe(10);
  });

  it('MCP: the schema and the direct handler agree; failures are typed', async () => {
    for (const args of [
      { dim: 'person', q: 'Ion Popescu' },
      { dim: 'court', q: 'x', limit: 0 },
      { dim: 'court', q: 'x', limit: 1.5 },
      { dim: 'court', q: 7 },
    ]) {
      const f = fixture();
      expect(f.schemaAccepts('resolve_judicial_filters', args)).toBe(false);
      const out = await f.direct('resolve_judicial_filters', args);
      expect(out).toMatchObject({ ok: false, errorType: 'InvalidInput', errorCode: INVALID });
      expect(JSON.stringify(out)).not.toContain('Ion');
      expect(f.executed).toEqual([]);
    }
    const f = fixture();
    expect(f.schemaAccepts('resolve_judicial_filters', { dim: 'court', q: 'x', limit: null })).toBe(
      true
    );
    const out = await f.mcp('resolve_judicial_filters', { dim: 'court', q: 'Buc', limit: null });
    expect(out.ok).toBe(true);
    expect(f.executed[0]?.parameters.at(-1)).toBe(10);
  });
});

describe('A3 aggregate groupBy — validated before the aggregate fallback', () => {
  it('an unknown groupBy is InvalidInput with zero repo calls (usecase) and zero SQL (repo)', async () => {
    const aggregate = vi.fn();
    const res = await getCourtCaseload(
      { cases: { aggregate } as unknown as JudicialRepos['cases'] },
      'party',
      BOUND
    );
    expect(res._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'groupBy' });
    expect(aggregate).not.toHaveBeenCalled();
    const f = fixture();
    const repoRes = await makeJudicialCaseRepo(f.db).aggregate({
      groupBy: 'party' as never,
      filter: BOUND,
    });
    expect(repoRes._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(f.executed).toEqual([]);
  });

  it('MCP: the schema rejects it and the direct handler returns a typed failure', async () => {
    const f = fixture();
    const args = { groupBy: 'party', institutionCode: [COURT] };
    expect(f.schemaAccepts('get_court_caseload', args)).toBe(false);
    expect(await f.direct('get_court_caseload', args)).toMatchObject({
      ok: false,
      errorType: 'InvalidInput',
      errorCode: INVALID,
    });
    expect(f.executed).toEqual([]);
  });
});

// ── direct external IDs ────────────────────────────────────────────────────────

describe('A3 direct IDs — digit strings within int8, checked before SQL', () => {
  const REJECTED = [
    '9223372036854775808',
    '99999999999999999999',
    '-1',
    '-0',
    '1e3',
    ' 1',
    '1.0',
    'abc',
  ];
  const ACCEPTED = ['0', '007', '9', '10', '100', '9007199254740993', '9223372036854775807'];

  it.each(REJECTED)('case lookup %s is INVALID_INPUT with zero SQL', async (id) => {
    const f = fixture();
    const res = await f.run(DETAIL, { id });
    expect(res.errors?.[0]).toMatchObject({ code: INVALID });
    expect(f.executed).toEqual([]);
  });

  it.each(ACCEPTED)(
    'case lookup %s reaches SQL with its own spelling; absent is null',
    async (id) => {
      const f = fixture();
      const res = await f.run(DETAIL, { id });
      expect(res).toEqual({ data: { judicialCase: null }, errors: undefined });
      expect(f.executed).toHaveLength(1);
      expect(f.executed[0]?.parameters).toEqual([id]);
    }
  );

  it('a null caseId is absent (null detail), not an error', async () => {
    const f = fixture();
    expect(await f.run(DETAIL, { id: null })).toEqual({
      data: { judicialCase: null },
      errors: undefined,
    });
    expect(f.executed).toEqual([]);
  });

  it.each(REJECTED)('legal references by case %s: typed MCP failure, zero SQL', async (caseId) => {
    const f = fixture();
    const out = await f.mcp('get_case_legal_references', { caseId });
    expect(out).toMatchObject({ ok: false, errorType: 'InvalidInput', errorCode: INVALID });
    expect(f.executed).toEqual([]);
  });

  it.each(ACCEPTED)('legal references by case %s reach SQL', async (caseId) => {
    const f = fixture();
    const out = await f.mcp('get_case_legal_references', { caseId });
    expect(out.ok).toBe(true);
    expect(f.executed[0]?.parameters[0]).toBe(caseId);
  });

  it.each(REJECTED)('reverse references by act %s: INVALID_INPUT, zero SQL', async (id) => {
    const f = fixture();
    const res = await f.run(CITING, { id });
    expect(res.errors?.[0]).toMatchObject({ code: INVALID });
    expect(f.executed).toEqual([]);
  });

  it('a valid reverse target keeps its original spelling in the cursor identity', async () => {
    const f = fixture((q) =>
      q.sql.includes('case_legal_references')
        ? [
            {
              ref_id: '5',
              case_id: '9',
              institution_code: COURT,
              case_number: '1',
              act_type: null,
              act_number: null,
              act_year: null,
            },
            {
              ref_id: '4',
              case_id: '9',
              institution_code: COURT,
              case_number: '1',
              act_type: null,
              act_number: null,
              act_year: null,
            },
          ]
        : []
    );
    const res = await f.run(CITING, { id: '007' });
    const cursor = (res.data?.['judicialCasesCitingAct'] as { edges: { cursor: string }[] })
      .edges[0]?.cursor;
    expect(
      decodeCursor(cursor ?? '', {
        sort: 'refId',
        dir: 'desc',
        fhash: 'judicial_cases_citing:007',
      })._unsafeUnwrap().keys
    ).toEqual(['5']);
    expect(f.executed[0]?.parameters[0]).toBe('007');
  });

  it('the case-detail child read keeps its existing guard (a stored negative id is not a new failure)', async () => {
    const f = fixture((q) =>
      q.sql.includes('from justice.cases c') && q.sql.includes('c.case_number =')
        ? [
            {
              case_id: '-5',
              source_slug: 'portal_just',
              institution_code: COURT,
              case_number: 'N/1',
              case_number_old: null,
              department: null,
              category: null,
              category_name: null,
              stage: null,
              stage_name: null,
              object: null,
              source_opened_at: null,
              latest_source_modified_at: null,
            },
          ]
        : []
    );
    const res = await f.run(
      `{ judicialCase(institutionCode: "${COURT}", caseNumber: "N/1") { case { caseId } legalReferences { caseId } } }`
    );
    expect(res).toEqual({
      data: { judicialCase: { case: { caseId: '-5' }, legalReferences: [] } },
      errors: undefined,
    });
  });
});

// ── case-cursor identity (filter semantics version) ────────────────────────────

describe('A3 case cursors — the filter-semantics version is part of the identity', () => {
  const caseFhash = (filter: FilterInput) =>
    `judicial_cases:cursor-v2:filters-a3:${fhashFor(judicialCasesSpec, filter)}`;
  const rows = [
    {
      case_id: '9',
      source_slug: 'portal_just',
      institution_code: COURT,
      case_number: '9/1/2024',
      case_number_old: null,
      department: null,
      category: null,
      category_name: null,
      stage: null,
      stage_name: null,
      object: null,
      source_opened_at: '2024-01-01',
      latest_source_modified_at: null,
      sort_key: null,
    },
  ];

  it('edges carry the A3 identity of the SAME normalized filter the SQL used', async () => {
    const f = fixture((q) => (isCaseList(q) ? rows : []));
    const res = await f.run(LIST, {
      filter: { ...BOUND, year: { eq: 2024, gte: 2020 }, courtLevel: null },
      first: 1,
    });
    const edge = (res.data?.['judicialCases'] as { edges: { cursor: string }[] }).edges[0];
    const identity = {
      sort: 'modifiedAt',
      dir: 'desc',
      fhash: caseFhash({ ...BOUND, year: { eq: 2024, gte: 2020 } }),
    } as const;
    expect(decodeCursor(edge?.cursor ?? '', identity)._unsafeUnwrap().keys).toEqual(['', '9']);
  });

  it('a pre-A3 token (cursor-v2 identity without the semantics version) gets the typed restart', async () => {
    const f = fixture();
    const filter = { ...BOUND, year: { eq: 2024, gte: 2020 } };
    const preA3 = buildNextCursor({
      sort: 'modifiedAt',
      dir: 'desc',
      fhash: `judicial_cases:cursor-v2:${fhashFor(judicialCasesSpec, filter)}`,
      lastKeys: ['', '9'],
    });
    const res = await f.run(LIST, { filter, first: 1, after: preA3 });
    expect(res.errors).toEqual([
      { message: 'cursor/filter mismatch; restart pagination', code: INVALID },
    ]);
    expect(f.executed).toEqual([]);
  });
});

// ── r1: a supplied malformed id or date literal never becomes absent ───────────

/** A natural-key case row: the fallback WOULD succeed if a malformed id fell through. */
const naturalKeyRow = {
  case_id: '9',
  source_slug: 'portal_just',
  institution_code: COURT,
  case_number: 'N/1',
  case_number_old: null,
  department: null,
  category: null,
  category_name: null,
  stage: null,
  stage_name: null,
  object: null,
  source_opened_at: null,
  latest_source_modified_at: null,
};
const isNaturalKeyLookup = (q: Executed): boolean =>
  q.sql.includes('from justice.cases c') && q.sql.includes('c.case_number =');
const isIdLookup = (q: Executed): boolean =>
  q.sql.includes('from justice.cases c') && q.sql.includes('c.case_id = ');

describe('r1 MCP get_judicial_case — a supplied caseId is validated, never dropped', () => {
  /** Spy repos: the natural key resolves, so a fall-through would SUCCEED. */
  const spyTools = () => {
    const theCase = {
      caseId: '9',
      sourceSlug: 'portal_just',
      institutionCode: COURT,
      caseNumber: 'N/1',
      caseNumberOld: null,
      department: null,
      category: null,
      categoryName: null,
      stage: null,
      stageName: null,
      object: null,
      sourceOpenedAt: null,
      sourceOpenedAtBasis: 'portal_header_data' as const,
      latestSourceModifiedAt: null,
    };
    const getById = vi.fn(async (id: string) => ok(id === '9' || id === '009' ? theCase : null));
    const getByNaturalKey = vi.fn(async () => ok(theCase));
    const empty = vi.fn(async () => ok([]));
    const repos = {
      courts: {},
      cases: {
        getById,
        getByNaturalKey,
        getAsOf: vi.fn(async (sourceSlug: string) =>
          ok({
            asOf: null,
            estimated: true,
            sourceSlug,
            basis: 'max_stored_source_modified_at' as const,
            captureFreshnessAt: null,
            loadFreshnessAt: null,
          })
        ),
      },
      hearings: { listForCase: empty },
      appeals: { listForCase: empty },
      parties: { listForCase: empty },
      legalRefs: { listForCase: empty },
      lineage: { lineageForCase: empty },
      dictionary: { getPublishableNames: vi.fn(async () => ok(new Map())) },
      companyLinks: {},
    } as unknown as JudicialRepos;
    const tool = makeJudicialMcpTools({ repos, clientBaseUrl: 'https://example.invalid' }).find(
      (t) => t.name === 'get_judicial_case'
    );
    if (tool === undefined) throw new Error('get_judicial_case missing');
    return { tool, getById, getByNaturalKey };
  };
  const FALLBACK = { institutionCode: COURT, caseNumber: 'N/1' };

  it.each([
    ['an empty caseId', ''],
    ['a whitespace caseId', ' '],
    ['an overflowing caseId', '9223372036854775808'],
    ['a negative caseId', '-1'],
  ])(
    '%s WITH a usable natural key: schema accepts, handler fails typed, zero repo calls',
    async (_l, caseId) => {
      const s = spyTools();
      const args = { caseId, ...FALLBACK };
      expect(kernelToolInputSchema(s.tool).safeParse(args).success).toBe(true);
      const out = await s.tool.handler(args);
      expect(out).toMatchObject({
        ok: false,
        errorType: 'InvalidInput',
        errorCode: INVALID,
        error: 'caseId must be a decimal digit string of at most 9223372036854775807',
      });
      expect(s.getById).not.toHaveBeenCalled();
      expect(s.getByNaturalKey).not.toHaveBeenCalled();
    }
  );

  it('a non-string caseId (direct handler) is typed with zero repo calls', async () => {
    const s = spyTools();
    const out = await s.tool.handler({ caseId: 9, ...FALLBACK });
    expect(out).toMatchObject({ ok: false, errorType: 'InvalidInput', errorCode: INVALID });
    expect(s.getById).not.toHaveBeenCalled();
    expect(s.getByNaturalKey).not.toHaveBeenCalled();
  });

  it.each([
    ['an explicit null caseId', { caseId: null, ...FALLBACK }],
    ['an omitted caseId', { ...FALLBACK }],
  ])('%s still uses the natural-key fallback', async (_l, args) => {
    const s = spyTools();
    expect(kernelToolInputSchema(s.tool).safeParse(args).success).toBe(true);
    const out = await s.tool.handler(args);
    expect(out).toMatchObject({ ok: true, item: { case: { caseId: '9' } } });
    expect(s.getByNaturalKey).toHaveBeenCalledTimes(1);
    expect(s.getById).not.toHaveBeenCalled();
  });

  it.each([
    ['0', false],
    ['009', true],
    ['9223372036854775807', false],
  ])(
    'caseId %s is admitted and looked up by id (its own spelling), never by natural key',
    async (caseId, found) => {
      const s = spyTools();
      const out = await s.tool.handler({ caseId, ...FALLBACK });
      expect(out.ok).toBe(true);
      expect(out.item !== undefined).toBe(found);
      expect(s.getById).toHaveBeenCalledWith(caseId);
      expect(s.getByNaturalKey).not.toHaveBeenCalled();
    }
  );

  it('through the real module: an empty caseId beside a resolvable natural key runs zero SQL', async () => {
    const f = fixture((q) => (isNaturalKeyLookup(q) ? [naturalKeyRow] : []));
    const out = await f.mcp('get_judicial_case', { caseId: '', ...FALLBACK });
    expect(out).toMatchObject({ ok: false, errorType: 'InvalidInput', errorCode: INVALID });
    expect(f.executed).toEqual([]);
    const control = fixture((q) => (isNaturalKeyLookup(q) ? [naturalKeyRow] : []));
    const ok2 = await control.mcp('get_judicial_case', { caseId: null, ...FALLBACK });
    expect(ok2).toMatchObject({ ok: true, item: { case: { caseId: '9' } } });
    expect(control.executed.filter(isNaturalKeyLookup)).toHaveLength(1);
  });
});

describe('r1 GraphQL judicialCase — an unsupported caseId literal is INVALID_INPUT, never absent', () => {
  const detail = (caseIdArg: string) =>
    `{ judicialCase(${caseIdArg}institutionCode: "${COURT}", caseNumber: "N/1") { case { caseId } } }`;

  it.each(['true', '1.5', '1.0', '{}', '[]', 'SECRET_ENUM'])(
    'caseId: %s beside a resolvable natural key fails at validation with zero SQL',
    async (lit) => {
      const f = fixture((q) => (isNaturalKeyLookup(q) ? [naturalKeyRow] : []));
      const res = await f.run(detail(`caseId: ${lit}, `));
      expect(res).toEqual({
        data: null,
        errors: [{ message: 'BigInt literal must be a string or an integer', code: INVALID }],
      });
      expect(f.executed).toEqual([]);
    }
  );

  it('an unsupported variable default is INVALID_INPUT too', async () => {
    const f = fixture((q) => (isNaturalKeyLookup(q) ? [naturalKeyRow] : []));
    const res = await f.run(
      `query ($id: BigInt = false) { judicialCase(caseId: $id, institutionCode: "${COURT}", caseNumber: "N/1") { case { caseId } } }`
    );
    expect(res.errors?.map((e) => e.code)).toEqual([INVALID]);
    expect(f.executed).toEqual([]);
  });

  it.each([
    ['caseId: null', 'caseId: null, '],
    ['an omitted caseId', ''],
  ])('%s keeps the natural-key fallback', async (_l, arg) => {
    const f = fixture((q) => (isNaturalKeyLookup(q) ? [naturalKeyRow] : []));
    const res = await f.run(detail(arg));
    expect(res).toEqual({ data: { judicialCase: { case: { caseId: '9' } } }, errors: undefined });
    expect(f.executed.filter(isNaturalKeyLookup)).toHaveLength(1);
    expect(f.executed.filter(isIdLookup)).toHaveLength(0);
  });

  it.each([
    ['a STRING literal', 'caseId: "009", ', '009'],
    ['an INT literal', 'caseId: 9, ', '9'],
    ['an INT literal above 2^53', 'caseId: 9007199254740993, ', '9007199254740993'],
  ])('%s is looked up by id with its exact text', async (_l, arg, param) => {
    const f = fixture();
    const res = await f.run(detail(arg));
    expect(res.errors).toBeUndefined();
    expect(f.executed.filter(isIdLookup).map((q) => q.parameters)).toEqual([[param]]);
    expect(f.executed.filter(isNaturalKeyLookup)).toHaveLength(0);
  });
});

describe('r1 modified Date literal — malformed is INVALID_INPUT, never an absent bound', () => {
  const listWith = (modified: string) =>
    `{ judicialCases(filter: { institutionCode: { in: ["${COURT}"] }, modified: ${modified} }, first: 2) { edges { node { caseId } } } }`;
  const caseloadWith = (modified: string) =>
    `{ judicialCaseload(groupBy: court, filter: { institutionCode: { in: ["${COURT}"] }, modified: ${modified} }) { denominator } }`;

  it.each([
    '{ gte: true }',
    '{ gte: 1.5 }',
    '{ lte: {} }',
    '{ gte: [] }',
    '{ between: { from: 20240101.0 } }',
    '{ between: { to: false } }',
    '{ gte: SECRET_ENUM }',
  ])(
    'modified: %s beside a real court bound fails at validation (list and aggregate), zero SQL',
    async (m) => {
      for (const source of [listWith(m), caseloadWith(m)]) {
        const f = fixture();
        const res = await f.run(source);
        expect(res).toEqual({
          data: null,
          errors: [{ message: 'Date literal must be a string or an integer', code: INVALID }],
        });
        expect(f.executed).toEqual([]);
      }
    }
  );

  it('valid string, explicit null and omission keep their normalized-filter meaning', async () => {
    const withDate = fixture();
    await withDate.run(listWith('{ gte: "2024-01-01" }'));
    expect(listQuery(withDate.executed).parameters).toEqual([COURT, '2024-01-01', 3]);
    const nulls = fixture();
    await nulls.run(listWith('{ gte: null, between: { from: null } }'));
    const omitted = fixture();
    await omitted.run(
      `{ judicialCases(filter: { institutionCode: { in: ["${COURT}"] } }, first: 2) { edges { node { caseId } } } }`
    );
    expect(listQuery(nulls.executed)).toEqual(listQuery(omitted.executed));
  });
});
