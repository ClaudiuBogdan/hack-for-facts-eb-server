/**
 * Judicial — the court-level taxonomy contract, exercised through the REAL module
 * (typedefs + resolvers + usecases + repos + MCP tools) over an in-memory scripted
 * Kysely driver. No live database, no env file, no fixture written anywhere.
 *
 * Regression: dev `judicialCourts { courtLevel }` returned `data: null` with an
 * error at `judicialCourts/0/courtLevel`. The serving DB's ordinal-0 ICCJ row
 * carries `court_level = 'inalta_curte'`, a level the server did not know.
 *
 * Every expectation is pinned to the DB contract below — copied from the
 * scrapper migrations, not from the server — so any surface that drifts from the
 * database fails here.
 */

import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql, Kind, parse } from 'graphql';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { JUDICIAL_COURT_LEVELS, makeJudicialModule } from '@/modules/judicial/index.js';
import { judicialTypeDefs } from '@/modules/judicial/shell/graphql/typedefs.js';
import {
  createContributorRegistry,
  kernelToolInputSchema,
  type KernelMcpTool,
  type ProdDatabase,
} from '@/modules/shared/index.js';

/**
 * `justice.courts.courts_level_check` as the scrapper prod migrations define it:
 * 20260614T120000__justice_domain (five levels) + 20260629T131000__justice_iccj_court
 * (adds `inalta_curte`).
 */
const DB_COURT_LEVELS = [
  'judecatorie',
  'tribunal',
  'tribunal_militar',
  'curte_de_apel',
  'curte_militara_apel',
  'inalta_curte',
] as const;

/** The ICCJ row exactly as 20260629T131000__justice_iccj_court inserts it. */
const ICCJ_ROW = {
  institution_code: 'InaltaCurtedeCasatiesiJustitie',
  ordinal: 0,
  court_level: 'inalta_curte',
  specialization: null,
  locality: 'BUCURESTI',
  county_code: null,
  parent_institution_code: null,
  mapping_confidence: 'high',
};
const TRIBUNAL_ROW = {
  institution_code: 'TEST_JUD_TRIB',
  ordinal: 1,
  court_level: 'tribunal',
  specialization: null,
  locality: 'Test City',
  county_code: 'B',
  parent_institution_code: null,
  mapping_confidence: 'high',
};
const CUI = '12345678';

/** Kernel types the judicial slice references; `LegalAct` is owned by the legal module. */
const STUB_TYPEDEFS =
  'scalar BigInt\nscalar Date\nscalar DateTime\nscalar JSON\n' +
  'type PageInfo { hasNextPage: Boolean! endCursor: String }\n' +
  'type LegalAct { actId: BigInt }\n' +
  'type Query { ping: String }\n';

interface Executed {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const fixture = (respond: (query: Executed) => unknown[] = () => []) => {
  const executed: Executed[] = [];
  class ScriptedDriver extends DummyDriver {
    override acquireConnection() {
      return Promise.resolve({
        executeQuery: (query: CompiledQuery) => {
          const q = { sql: query.sql, parameters: query.parameters };
          executed.push(q);
          return Promise.resolve({ rows: respond(q) as never[] });
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
    typeDefs: STUB_TYPEDEFS + module.graphqlSlice.typeDefs,
    // Same cast as build-redesign-app: module resolver maps are untyped records.
    resolvers: module.graphqlResolvers as unknown as Record<string, never>,
  });
  const run = async (source: string, variableValues?: Record<string, unknown>) => {
    const result = await graphql({
      schema,
      source,
      ...(variableValues !== undefined && { variableValues }),
    });
    return {
      data: result.data ?? null,
      errors: result.errors?.map((e) => ({ message: e.message, path: e.path })),
    };
  };
  const tool = (name: string): KernelMcpTool => {
    const found = module.mcpTools.find((t) => t.name === name);
    if (found === undefined) throw new Error(`tool ${name} missing`);
    return found;
  };
  return { run, tool, executed };
};

const courtsOnly =
  (rows: readonly unknown[]) =>
  (q: Executed): unknown[] =>
    q.sql.includes('"justice"."courts"') ? [...rows] : [];

describe('court-level taxonomy — pinned to the DB CHECK', () => {
  it('the server taxonomy is the DB CHECK: existing five first, inalta_curte appended', () => {
    expect([...JUDICIAL_COURT_LEVELS]).toEqual([...DB_COURT_LEVELS]);
  });

  it('the GraphQL JudicialCourtLevel enum declares exactly the DB CHECK values', () => {
    const enumDef = parse(judicialTypeDefs).definitions.find(
      (d) => d.kind === Kind.ENUM_TYPE_DEFINITION && d.name.value === 'JudicialCourtLevel'
    );
    const values =
      enumDef?.kind === Kind.ENUM_TYPE_DEFINITION
        ? (enumDef.values ?? []).map((v) => v.name.value)
        : [];
    expect(values).toEqual([...DB_COURT_LEVELS]);
  });
});

describe('judicialCourts — the ordinal-0 ICCJ row (dev data:null regression)', () => {
  it('serializes the whole catalogue with ICCJ as row 0 instead of nulling data', async () => {
    const f = fixture(courtsOnly([ICCJ_ROW, TRIBUNAL_ROW]));
    const res = await f.run('{ judicialCourts { institutionCode ordinal courtLevel } }');
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      judicialCourts: [
        {
          institutionCode: 'InaltaCurtedeCasatiesiJustitie',
          ordinal: 0,
          courtLevel: 'inalta_curte',
        },
        { institutionCode: 'TEST_JUD_TRIB', ordinal: 1, courtLevel: 'tribunal' },
      ],
    });
  });

  it('serializes every DB-admitted level', async () => {
    const rows = DB_COURT_LEVELS.map((level, i) => ({
      ...TRIBUNAL_ROW,
      institution_code: `TEST_JUD_${String(i)}`,
      ordinal: i,
      court_level: level,
    }));
    const f = fixture(courtsOnly(rows));
    const res = await f.run('{ judicialCourts { courtLevel } }');
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      judicialCourts: DB_COURT_LEVELS.map((courtLevel) => ({ courtLevel })),
    });
  });

  it('serves the single ICCJ court lookup', async () => {
    const f = fixture((q) =>
      q.sql.includes('"parent_institution_code" =') ? [] : courtsOnly([ICCJ_ROW])(q)
    );
    const res = await f.run(
      '{ judicialCourt(institutionCode: "InaltaCurtedeCasatiesiJustitie") { institutionCode courtLevel children { institutionCode } } }'
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      judicialCourt: {
        institutionCode: 'InaltaCurtedeCasatiesiJustitie',
        courtLevel: 'inalta_curte',
        children: [],
      },
    });
  });
});

describe('court filters', () => {
  it('judicialCourts level filter admits inalta_curte and binds it as a SQL parameter', async () => {
    const f = fixture(courtsOnly([ICCJ_ROW]));
    const res = await f.run(
      '{ judicialCourts(filter: { level: { in: ["inalta_curte"] } }) { institutionCode courtLevel } }'
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      judicialCourts: [
        { institutionCode: 'InaltaCurtedeCasatiesiJustitie', courtLevel: 'inalta_curte' },
      ],
    });
    expect(f.executed).toHaveLength(1);
    expect(f.executed[0]?.sql).toContain('court_level');
    expect(f.executed[0]?.parameters).toEqual(['inalta_curte']);
  });

  it('judicialCourts level filter admits every DB level', async () => {
    const f = fixture();
    const res = await f.run(
      'query ($levels: [String!]) { judicialCourts(filter: { level: { in: $levels } }) { institutionCode } }',
      { levels: [...DB_COURT_LEVELS] }
    );
    expect(res.errors).toBeUndefined();
    expect(f.executed[0]?.parameters).toEqual([...DB_COURT_LEVELS]);
  });

  it('still rejects an unknown level before any SQL (guard: passes before and after)', async () => {
    const f = fixture();
    const res = await f.run(
      '{ judicialCourts(filter: { level: { in: ["iccj"] } }) { institutionCode } }'
    );
    expect(res.errors?.[0]?.message).toContain('level must be one of');
    expect(f.executed).toHaveLength(0);
  });

  it('case list courtLevel already binds inalta_curte (characterization: passes before and after)', async () => {
    // `courtLevel` is a VIRTUAL field compiled by the cases repo, which never
    // checked enum values — so this worked before the repair. Validating unknown
    // values there is a separate, deliberately excluded change.
    const f = fixture();
    const res = await f.run(
      '{ judicialCases(filter: { courtLevel: { in: ["inalta_curte"] } }, first: 2) { edges { node { caseId } } pageInfo { hasNextPage } } }'
    );
    expect(res.errors).toBeUndefined();
    expect(f.executed[0]?.sql).toContain('court_level in');
    expect(f.executed[0]?.parameters).toContain('inalta_curte');
  });
});

describe('company litigation — typed JudicialCourtLevel input and output', () => {
  it('accepts every DB level as an argument and binds them', async () => {
    const f = fixture();
    const res = await f.run(
      `query ($levels: [JudicialCourtLevel!]) {
        judicialCompanyLitigation(cui: "${CUI}", courtLevel: $levels) { caseCount }
        judicialCompanyLitigationCases(cui: "${CUI}", courtLevel: $levels) { edges { node { caseId } } }
      }`,
      { levels: [...DB_COURT_LEVELS] }
    );
    expect(res.errors).toBeUndefined();
    expect(f.executed).toHaveLength(2);
    for (const q of f.executed) {
      expect(q.parameters).toEqual(expect.arrayContaining([...DB_COURT_LEVELS]));
    }
  });

  it('serializes an inalta_curte court-level count instead of nulling the summary', async () => {
    const f = fixture((q) =>
      q.sql.includes('party_company_candidates')
        ? [{ court_level: 'inalta_curte', year: 2024, cnt: '1', name_key_id: null }]
        : []
    );
    const res = await f.run(
      `{ judicialCompanyLitigation(cui: "${CUI}") { caseCount courtLevels { courtLevel count } } }`
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      judicialCompanyLitigation: {
        caseCount: 1,
        courtLevels: [{ courtLevel: 'inalta_curte', count: 1 }],
      },
    });
  });

  it('rejects an unknown level argument before any SQL (guard: passes before and after)', async () => {
    const f = fixture();
    const res = await f.run(
      `query ($levels: [JudicialCourtLevel!]) { judicialCompanyLitigation(cui: "${CUI}", courtLevel: $levels) { caseCount } }`,
      { levels: ['iccj'] }
    );
    expect(res.errors).toHaveLength(1);
    expect(f.executed).toHaveLength(0);
  });
});

describe('MCP inputs — the kernel input schema z.object(tool.inputShape)', () => {
  it('get_court_caseload accepts every DB level and binds them into the bounded aggregate', async () => {
    const f = fixture((q) =>
      q.sql.includes(' as named')
        ? [{ total: '2', named: '2' }]
        : [{ key: 'inalta_curte', label: null, cnt: '2' }]
    );
    const t = f.tool('get_court_caseload');
    const parsed = kernelToolInputSchema(t).safeParse({
      groupBy: 'courtLevel',
      courtLevel: [...DB_COURT_LEVELS],
    });
    expect(parsed.error?.issues ?? []).toEqual([]);
    if (!parsed.success) return;
    const out = await t.handler(parsed.data);
    expect(out).toMatchObject({ ok: true, items: [{ key: 'inalta_curte', caseCount: 2 }] });
    expect(f.executed).toHaveLength(2);
    for (const q of f.executed) {
      expect(q.parameters).toEqual(expect.arrayContaining([...DB_COURT_LEVELS]));
    }
  });

  it('get_company_litigation accepts every DB level and binds them', async () => {
    const f = fixture();
    const t = f.tool('get_company_litigation');
    const parsed = kernelToolInputSchema(t).safeParse({
      cui: CUI,
      courtLevel: [...DB_COURT_LEVELS],
    });
    expect(parsed.error?.issues ?? []).toEqual([]);
    if (!parsed.success) return;
    const out = await t.handler(parsed.data);
    expect(out).toMatchObject({ ok: true });
    expect(f.executed[0]?.parameters).toEqual(expect.arrayContaining([...DB_COURT_LEVELS]));
  });

  it('both inputs still reject an unknown level (guard: passes before and after)', () => {
    const f = fixture();
    const caseload = kernelToolInputSchema(f.tool('get_court_caseload')).safeParse({
      groupBy: 'courtLevel',
      courtLevel: ['iccj'],
    });
    const litigation = kernelToolInputSchema(f.tool('get_company_litigation')).safeParse({
      cui: CUI,
      courtLevel: ['iccj'],
    });
    expect(caseload.success).toBe(false);
    expect(litigation.success).toBe(false);
  });
});

describe('discovery — the courtLevel dimension', () => {
  it('GraphQL judicialResolve lists every DB level for an empty query', async () => {
    const f = fixture();
    const res = await f.run('{ judicialResolve(dim: "courtLevel", q: "") { value } }');
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      judicialResolve: DB_COURT_LEVELS.map((value) => ({ value })),
    });
    expect(f.executed).toHaveLength(0);
  });

  it('a partial label resolves to inalta_curte', async () => {
    const f = fixture();
    const res = await f.run(
      '{ judicialResolve(dim: "courtLevel", q: "inalta") { kind value label } }'
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      judicialResolve: [{ kind: 'courtLevel', value: 'inalta_curte', label: 'inalta_curte' }],
    });
  });

  it('MCP resolve_judicial_filters returns every DB level', async () => {
    const f = fixture();
    const out = await f.tool('resolve_judicial_filters').handler({ dim: 'courtLevel', q: '' });
    expect(out).toMatchObject({
      ok: true,
      items: DB_COURT_LEVELS.map((value) => ({ kind: 'courtLevel', value })),
    });
  });
});
