/**
 * Judicial A2 — truthful metadata through the REAL module (SDL + resolvers +
 * usecases + repos + MCP tools) with the REAL kernel scalar resolvers, over an
 * in-memory scripted Kysely driver. No database, no env file.
 *
 * Pins: the county abbreviation output and filter (with the deprecated,
 * misnamed `countySirutaCode` / `countySiruta` aliases carrying the same
 * values), the per-source `sourceOpenedAtBasis`, and the SOURCE-SCOPED as-of
 * (the case's own `source_slug` reaches SQL as a parameter; the scripted
 * maximum differs per source, so a global maximum cannot pass). What
 * PostgreSQL decides (the per-source MAX over actual rows) is proven on actual
 * DDL by tests/integration/judicial/judicial-a2.pg.test.ts.
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
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { makeJudicialModule } from '@/modules/judicial/index.js';
import {
  createContributorRegistry,
  kernelToolInputSchema,
  type KernelMcpTool,
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

const fixture = (respond: Respond = () => []) => {
  const executed: Executed[] = [];
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
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
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
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const t = tool(name);
    const parsed = kernelToolInputSchema(t).safeParse(args);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('mcp input rejected');
    return t.handler(parsed.data);
  };
  return { run, mcp, tool, executed };
};

// ── scripted rows (the repos' real aliases) ────────────────────────────────────

const courtRow = (code: string, county: string | null, ordinal: number) => ({
  institution_code: code,
  ordinal,
  court_level: 'tribunal',
  specialization: null,
  locality: 'A2',
  county_code: county,
  parent_institution_code: null,
  mapping_confidence: 'high',
});

const COURT_ROWS = [
  courtRow('TEST_A2_B', 'B', 1),
  courtRow('TEST_A2_TM', 'TM', 2),
  courtRow('TEST_A2_NONE', null, 3),
];

const isCourtList = (q: Executed) =>
  q.sql.includes('"justice"."courts" as "co"') && q.sql.includes('order by "co"."ordinal"');

/** One case per source; the maxima differ per source, so a global MAX cannot pass. */
const CASES: Readonly<Record<string, { slug: string; opened: string | null }>> = {
  '3001': { slug: 'portal_just', opened: '2025-02-03' },
  '3002': { slug: 'iccj', opened: null },
  '3003': { slug: 'ecris_test', opened: '2024-01-01' },
};
const MAX_BY_SOURCE: Readonly<Record<string, string | null>> = {
  portal_just: '2026-05-04T13:15:00.123Z',
  iccj: null,
  ecris_test: '2027-01-01T00:00:00.000Z',
};

const caseRow = (id: string) => {
  const c = CASES[id];
  if (c === undefined) throw new Error(`case ${id}`);
  return {
    case_id: id,
    source_slug: c.slug,
    institution_code: 'TEST_A2_B',
    case_number: `${id}/1/2025`,
    case_number_old: null,
    department: null,
    category: null,
    category_name: null,
    stage: null,
    stage_name: null,
    object: null,
    source_opened_at: c.opened,
    latest_source_modified_at: MAX_BY_SOURCE[c.slug] ?? null,
  };
};

const isCaseById = (q: Executed) => q.sql.includes('where c.case_id = $1::bigint limit 1');
const isAsOf = (q: Executed) => q.sql.includes('max(c.latest_source_modified_at)');

/** Case by id from the parameter; as-of answered ONLY for a named source parameter. */
const detailWorld: Respond = (q) => {
  if (isCaseById(q)) {
    const id = String(q.parameters[0]);
    return CASES[id] === undefined ? [] : [caseRow(id)];
  }
  if (isAsOf(q)) {
    const slug = q.parameters[0];
    if (typeof slug !== 'string' || !(slug in MAX_BY_SOURCE)) {
      // A global (unparameterized) maximum: the max over every source.
      return [{ as_of: '2027-01-01T00:00:00.000Z' }];
    }
    return [{ as_of: MAX_BY_SOURCE[slug] ?? null }];
  }
  return [];
};

// ── 1. county abbreviation output + filter, deprecated misnamed aliases ───────

describe('A2 county codes — the stored abbreviation, honestly named', () => {
  it('countyCode and the deprecated countySirutaCode both carry the stored abbreviation (or null)', async () => {
    const f = fixture((q) => (isCourtList(q) ? COURT_ROWS : []));
    const res = await f.run('{ judicialCourts { institutionCode countyCode countySirutaCode } }');
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      judicialCourts: [
        { institutionCode: 'TEST_A2_B', countyCode: 'B', countySirutaCode: 'B' },
        { institutionCode: 'TEST_A2_TM', countyCode: 'TM', countySirutaCode: 'TM' },
        { institutionCode: 'TEST_A2_NONE', countyCode: null, countySirutaCode: null },
      ],
    });
  });

  it('a selection of only the legacy field is unchanged', async () => {
    const f = fixture((q) => (isCourtList(q) ? COURT_ROWS : []));
    const res = await f.run('{ judicialCourts { institutionCode countySirutaCode } }');
    expect(res.data).toEqual({
      judicialCourts: [
        { institutionCode: 'TEST_A2_B', countySirutaCode: 'B' },
        { institutionCode: 'TEST_A2_TM', countySirutaCode: 'TM' },
        { institutionCode: 'TEST_A2_NONE', countySirutaCode: null },
      ],
    });
  });

  it('the SDL marks countySirutaCode deprecated (misnamed, not SIRUTA) and countyCode not', async () => {
    const f = fixture();
    const res = await f.run(`{
      __type(name: "JudicialCourt") {
        fields(includeDeprecated: true) { name isDeprecated deprecationReason description }
      }
    }`);
    const fields = (
      res.data?.['__type'] as {
        fields: {
          name: string;
          isDeprecated: boolean;
          deprecationReason: string | null;
          description: string | null;
        }[];
      }
    ).fields;
    const byName = new Map(fields.map((x) => [x.name, x]));
    expect(byName.get('countySirutaCode')).toMatchObject({ isDeprecated: true });
    expect(byName.get('countySirutaCode')?.deprecationReason).toMatch(
      /county abbreviation.*not a SIRUTA code.*Use countyCode/u
    );
    expect(byName.get('countyCode')).toMatchObject({
      isDeprecated: false,
      deprecationReason: null,
    });
    expect(byName.get('countyCode')?.description).toMatch(/not a SIRUTA code/u);
  });

  it('the countySiruta filter input is described as the misnamed abbreviation alias', async () => {
    const f = fixture();
    const res = await f.run(`{
      alias: __type(name: "JudicialCourtsCountySirutaFilter") { description }
      code: __type(name: "JudicialCourtsCountyCodeFilter") { description inputFields { name } }
    }`);
    const data = res.data as {
      alias: { description: string };
      code: { description: string; inputFields: { name: string }[] };
    };
    expect(data.alias.description).toMatch(/DEPRECATED misnamed alias of countyCode/u);
    expect(data.alias.description).toMatch(/NOT a SIRUTA code/u);
    expect(data.code.description).toMatch(/county abbreviation/iu);
    expect(data.code.inputFields).toEqual([{ name: 'in' }]);
  });

  it.each([
    ['countyCode', { countyCode: { in: ['B'] } }, ['B']],
    ['the countySiruta alias', { countySiruta: { in: ['B'] } }, ['B']],
  ] as const)(
    '%s filters the county_code column with the given values',
    async (_l, filter, params) => {
      const f = fixture((q) => (isCourtList(q) ? [] : []));
      const res = await f.run(
        'query ($filter: JudicialCourtsFilter) { judicialCourts(filter: $filter) { institutionCode } }',
        { filter }
      );
      expect(res.errors).toBeUndefined();
      const list = f.executed.find(isCourtList);
      expect(list?.sql).toContain('where "co"."county_code" in ($1) order by');
      expect(list?.parameters).toEqual(params);
    }
  );

  it('both aliases supplied apply BOTH predicates (AND); a contradiction is not resolved by either', async () => {
    const f = fixture((q) => (isCourtList(q) ? [] : []));
    const res = await f.run(
      'query ($filter: JudicialCourtsFilter) { judicialCourts(filter: $filter) { institutionCode } }',
      { filter: { countyCode: { in: ['B'] }, countySiruta: { in: ['TM'] } } }
    );
    expect(res.errors).toBeUndefined();
    const list = f.executed.find(isCourtList);
    expect(list?.sql).toContain(
      'where "co"."county_code" in ($1) and "co"."county_code" in ($2) order by'
    );
    expect(list?.parameters).toEqual(['B', 'TM']);
  });
});

// ── 2. per-source date basis + source-scoped as-of ────────────────────────────

const DETAIL = `query ($id: BigInt) {
  judicialCase(caseId: $id) {
    case { caseId sourceSlug sourceOpenedAt sourceOpenedAtBasis }
    asOf { asOf estimated sourceSlug basis captureFreshnessAt loadFreshnessAt }
  }
}`;

const asOfFor = (slug: string) => ({
  asOf: MAX_BY_SOURCE[slug] ?? null,
  estimated: true,
  sourceSlug: slug,
  basis: 'max_stored_source_modified_at',
  captureFreshnessAt: null,
  loadFreshnessAt: null,
});

describe('A2 case metadata — date basis by actual source_slug; as-of of the case source only', () => {
  it.each([
    ['3001', 'portal_just', '2025-02-03', 'portal_header_data'],
    ['3002', 'iccj', null, 'iccj_archive_case_date'],
    ['3003', 'ecris_test', '2024-01-01', 'unknown'],
  ] as const)(
    'case %s (%s): GraphQL detail carries its basis and its own source maximum',
    async (id, slug, opened, basis) => {
      const f = fixture(detailWorld);
      const res = await f.run(DETAIL, { id });
      expect(res.errors).toBeUndefined();
      expect(res.data).toEqual({
        judicialCase: {
          case: {
            caseId: id,
            sourceSlug: slug,
            sourceOpenedAt: opened,
            sourceOpenedAtBasis: basis,
          },
          asOf: asOfFor(slug),
        },
      });
      // Exactly one as-of read, parameterized with THIS case's source.
      const asOfReads = f.executed.filter(isAsOf);
      expect(asOfReads).toHaveLength(1);
      expect(asOfReads[0]?.sql).toContain('where c.source_slug = $1');
      expect(asOfReads[0]?.parameters).toEqual([slug]);
    }
  );

  it('MCP get_judicial_case passes the same typed composite (case basis + scoped as-of)', async () => {
    const f = fixture(detailWorld);
    for (const [id, slug, basis] of [
      ['3001', 'portal_just', 'portal_header_data'],
      ['3002', 'iccj', 'iccj_archive_case_date'],
      ['3003', 'ecris_test', 'unknown'],
    ] as const) {
      const out = await f.mcp('get_judicial_case', { caseId: id });
      expect(out.ok).toBe(true);
      const item = out.item as { case: { sourceOpenedAtBasis: string }; asOf: unknown };
      expect(item.case.sourceOpenedAtBasis).toBe(basis);
      expect(item.asOf).toEqual(asOfFor(slug));
    }
  });

  it('a selection of only the old as-of fields is unchanged in shape', async () => {
    const f = fixture(detailWorld);
    const res = await f.run(
      'query ($id: BigInt) { judicialCase(caseId: $id) { case { caseId sourceOpenedAt } asOf { asOf estimated } } }',
      { id: '3001' }
    );
    expect(res.data).toEqual({
      judicialCase: {
        case: { caseId: '3001', sourceOpenedAt: '2025-02-03' },
        asOf: { asOf: '2026-05-04T13:15:00.123Z', estimated: true },
      },
    });
  });

  it('the basis and as-of-basis enums carry exactly the declared values', async () => {
    const f = fixture();
    const res = await f.run(`{
      basis: __type(name: "JudicialSourceOpenedAtBasis") { enumValues { name } }
      asOfBasis: __type(name: "JudicialAsOfBasis") { enumValues { name } }
    }`);
    expect(res.data).toEqual({
      basis: {
        enumValues: [
          { name: 'portal_header_data' },
          { name: 'iccj_archive_case_date' },
          { name: 'unknown' },
        ],
      },
      asOfBasis: { enumValues: [{ name: 'max_stored_source_modified_at' }] },
    });
  });
});

// ── 3. truthful descriptions (no universal filing/freshness claims) ──────────

describe('A2 descriptions — source clocks, scoped as-of, stored legal-ref fields', () => {
  const describeType = async (name: string) => {
    const f = fixture();
    const res = await f.run(
      `query ($name: String!) { __type(name: $name) { description fields { name description } } }`,
      { name }
    );
    return res.data?.['__type'] as {
      description: string | null;
      fields: { name: string; description: string | null }[];
    };
  };

  it('legal references: identity and resolution fields are returned as stored, including nulls', async () => {
    const t = await describeType('JudicialLegalRef');
    expect(t.description).toContain(
      'identity and resolution fields are returned as stored, including nulls'
    );
    expect(t.description).not.toMatch(/null when unresolved/u);
    const f = fixture();
    const description = f.tool('get_case_legal_references').description;
    expect(description).toContain(
      'identity and resolution fields are returned as stored, including nulls'
    );
    expect(description).not.toMatch(/null act fields when unresolved/u);
  });

  it('as-of is described as a source-scoped stored maximum, not freshness', async () => {
    const t = await describeType('JudicialAsOf');
    expect(t.description).toMatch(/not dataset freshness/u);
    const asOf = t.fields.find((x) => x.name === 'asOf')?.description ?? '';
    expect(asOf).toMatch(/sourceSlug only/u);
    expect(asOf).toMatch(/null when that source stores no modification time/u);
    for (const field of ['captureFreshnessAt', 'loadFreshnessAt']) {
      expect(t.fields.find((x) => x.name === field)?.description).toBe(
        'Not established: always null.'
      );
    }
  });

  it('case and case-link dates and year filters name the source-dependent clock', async () => {
    const c = await describeType('JudicialCase');
    const caseDate = c.fields.find((x) => x.name === 'sourceOpenedAt')?.description ?? '';
    expect(caseDate).toMatch(
      /^Source-dependent case date .* not a verified filing, registration or first-ever date/u
    );
    const link = await describeType('JudicialCaseLink');
    const linkDate = link.fields.find((x) => x.name === 'sourceOpenedAt')?.description ?? '';
    expect(linkDate).toMatch(/not a universal opening or filing date/u);
    const year = await describeType('JudicialCasesYearFilter');
    expect(year.description).toMatch(
      /Session calendar year of sourceOpenedAt, a SOURCE-DEPENDENT date/u
    );
    const f = fixture();
    expect(f.tool('get_court_caseload').description).toMatch(
      /session calendar year of the source-dependent sourceOpenedAt/u
    );
    // The REGISTERED MCP input description (zod 4 keeps `.describe()` text in its registry).
    const yearFromShape = f.tool('get_court_caseload').inputShape['yearFrom'];
    expect(yearFromShape).toBeDefined();
    const yearFrom =
      yearFromShape === undefined ? '' : (z.globalRegistry.get(yearFromShape)?.description ?? '');
    expect(yearFrom).toMatch(
      /^Lower bound on the session calendar year of the source-dependent sourceOpenedAt/u
    );
    // Every ICCJ mention names the stored archive field, never the old
    // earliest-captured-session claim.
    for (const text of [caseDate, linkDate, year.description ?? '', yearFrom]) {
      expect(text).toContain('the ICCJ archive case-date field');
      expect(text).not.toContain('iccj_earliest_captured_session');
      expect(text).not.toMatch(/earliest captured/u);
    }
  });

  it('the basis enum names the ICCJ case_date_text field and leaves its event and order unqualified', async () => {
    const t = await describeType('JudicialSourceOpenedAtBasis');
    expect(t.description).toContain(
      'iccj_archive_case_date (the stored date projected from the ICCJ archive case_date_text field; its exact event meaning and chronological selection are not established - it does not establish the earliest session, first appearance, filing/registration or capture freshness)'
    );
    expect(t.description).toContain('portal_header_data (the Portal Just case header data field)');
    expect(t.description).not.toContain('iccj_earliest_captured_session');
    expect(t.description).not.toMatch(/earliest captured/u);
  });
});
