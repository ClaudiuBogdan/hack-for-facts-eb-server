/**
 * Judicial A1 — exact citations, repo-owned cursors and truthful temporal text,
 * through the REAL module (SDL + resolvers + usecases + repos + MCP tools) with
 * the REAL kernel scalar resolvers, over an in-memory scripted Kysely driver. No
 * database, no env file, no fixture written anywhere.
 *
 * The scripted rows carry the repos' real SELECT aliases. What PostgreSQL
 * decides (ordering, exact keys, display rendering) is proven on actual DDL by
 * tests/integration/judicial/judicial-a1.pg.test.ts; this file pins the payload
 * shapes, the cursor plumbing, typed rejection BEFORE any SQL, and legacy-token
 * compatibility.
 *
 * Only symbols that predate A1 are imported, so the file also runs against the
 * original code, where it fails on the missing citation fields, the rebuilt
 * citation token, display-derived cursors, the reverse-list endCursor, and the
 * JS Date conversion of exceptional timestamps.
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

import { makeJudicialModule } from '@/modules/judicial/index.js';
import { judicialCasesSpec } from '@/modules/judicial/shell/filters/judicial.spec.js';
import {
  buildNextCursor,
  createContributorRegistry,
  decodeCursor,
  fhashFor,
  kernelToolInputSchema,
  type KernelMcpTool,
  type ProdDatabase,
} from '@/modules/shared/index.js';
import { scalarResolvers, scalarTypeDefs } from '@/modules/shared/shell/graphql/scalars.js';

const COURT = 'TEST_A1_COURT';
const FILTER = { institutionCode: { in: [COURT] } };
const BASE_FHASH = fhashFor(judicialCasesSpec, FILTER);
/** The A1 case-cursor identity, written out independently of the repo. */
const V2_FHASH = `judicial_cases:cursor-v2:${BASE_FHASH}`;
const CITING_FHASH = 'judicial_cases_citing:42';

/** Kernel types the judicial slice references, with the REAL scalar resolvers. */
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
  /** Parse MCP args through the tool's REAL input schema, then run its handler. */
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const t = tool(name);
    const parsed = kernelToolInputSchema(t).safeParse(args);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('mcp input rejected');
    return t.handler(parsed.data);
  };
  return { run, mcp, executed, repos: module.repos };
};

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/** A raw envelope string → token (lets a test plant non-string JSON keys verbatim). */
const rawToken = (envelopeJson: string): string => b64(envelopeJson);

const caseToken = (
  keys: readonly unknown[],
  over: { sort?: string; dir?: string; fhash?: string; v?: number } = {}
): string =>
  b64(
    JSON.stringify({
      v: over.v ?? 1,
      sort: over.sort ?? 'modifiedAt',
      dir: over.dir ?? 'desc',
      keys,
      fhash: over.fhash ?? V2_FHASH,
    })
  );

const deepKeys = (value: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) {
    for (const v of value) deepKeys(v, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      deepKeys(v, out);
    }
  }
  return out;
};

// ── scripted rows (the repos' real aliases) ────────────────────────────────────

const caseRow = (id: string, over: Record<string, unknown> = {}) => ({
  case_id: id,
  source_slug: 'portal_just',
  institution_code: COURT,
  case_number: `${id}/3/2026`,
  case_number_old: null,
  department: null,
  category: null,
  category_name: null,
  stage: null,
  stage_name: null,
  object: null,
  source_opened_at: '2024-03-10',
  latest_source_modified_at: '2026-05-04T13:15:00.123Z',
  ...over,
});

const REF_ROWS = [
  {
    case_legal_reference_id: '701',
    case_id: '2001',
    citation: 'legea nr. 31/1990',
    source_field: 'solution',
    hearing_index: 0,
    act_type: 'lege',
    act_number: '31',
    act_year: 1990,
    issuer_slug: null,
    article_fragment: null,
    target_act_id: '42',
    resolution_status: 'unique',
    confidence_score: '0.950',
  },
  {
    case_legal_reference_id: '705',
    case_id: '2001',
    citation: 'art.336 ncp',
    source_field: 'object',
    hearing_index: null,
    act_type: null,
    act_number: null,
    act_year: null,
    issuer_slug: null,
    article_fragment: 'art. 336',
    target_act_id: null,
    resolution_status: 'unresolved',
    confidence_score: null,
  },
  {
    case_legal_reference_id: '706',
    case_id: '2001',
    citation: 'legea nr. 31/1990',
    source_field: 'solution',
    hearing_index: 1,
    act_type: 'lege',
    act_number: '31',
    act_year: 1990,
    issuer_slug: null,
    article_fragment: null,
    target_act_id: null,
    resolution_status: 'ambiguous',
    confidence_score: '0.500',
  },
];

/** The domain view each REF_ROW must map to — field for field, nothing derived. */
const EXPECTED_REFS = REF_ROWS.map((r) => ({
  caseLegalReferenceId: r.case_legal_reference_id,
  caseId: r.case_id,
  sourceField: r.source_field,
  hearingIndex: r.hearing_index,
  actType: r.act_type,
  actNumber: r.act_number,
  actYear: r.act_year,
  issuerSlug: r.issuer_slug,
  articleFragment: r.article_fragment,
  targetActId: r.target_act_id,
  resolutionStatus: r.resolution_status,
  confidenceScore: r.confidence_score,
  citation: r.citation,
}));

const ORDINARY_HEARING_ROWS = [
  {
    case_id: '2001',
    hearing_index: 0,
    hearing_at: '2026-05-04T13:15:00.123Z',
    panel: 'C1',
    pronouncement_date: '2026-05-04',
    document_number: 'D0',
    document_date: '2026-05-05',
  },
];
const ORDINARY_APPEAL_ROWS = [
  { case_id: '2001', appeal_index: 0, appeal_declared_at: '2026-06-01', appeal_type: 'apel' },
];

/** Exceptional children, as SQL renders them (pass-through is what is tested). */
const EXCEPTIONAL_HEARING_ROWS = [
  {
    case_id: '2001',
    hearing_index: 0,
    hearing_at: '2026-05-04T13:15:00.123Z',
    panel: 'C1',
    pronouncement_date: '2026-05-04',
    document_number: 'D0',
    document_date: '5874897-12-31 AD',
  },
  {
    case_id: '2001',
    hearing_index: 1,
    hearing_at: 'infinity',
    panel: 'C2',
    pronouncement_date: '0001-12-31 BC',
    document_number: 'D1',
    document_date: null,
  },
];
const EXCEPTIONAL_APPEAL_ROWS = [
  { case_id: '2001', appeal_index: 0, appeal_declared_at: '-infinity', appeal_type: 'apel' },
];

// Matchers valid on the original and the repaired SQL alike.
const isCaseById = (q: Executed) => q.sql.includes('where c.case_id = $1::bigint limit 1');
const isAsOf = (q: Executed) => q.sql.includes('max(c.latest_source_modified_at)');
const isRefList = (q: Executed) => q.sql.includes('where lr.case_id =');
const isCitingList = (q: Executed) => q.sql.includes('where lr.target_act_id =');
const isCaseList = (q: Executed) =>
  q.sql.includes('from justice.cases c') && q.sql.includes('nulls last');

interface World {
  readonly asOf?: string | null;
  readonly caseOver?: Record<string, unknown>;
  readonly hearings?: readonly unknown[];
  readonly appeals?: readonly unknown[];
}

const detailWorld =
  (world: World = {}): Respond =>
  (q) => {
    if (isCaseById(q)) return [caseRow('2001', world.caseOver)];
    if (isAsOf(q)) return [{ as_of: world.asOf ?? '2026-05-04T13:15:00.123Z' }];
    if (q.sql.includes('from justice.case_hearings h')) {
      return world.hearings ?? ORDINARY_HEARING_ROWS;
    }
    if (q.sql.includes('from justice.case_appeals a')) return world.appeals ?? ORDINARY_APPEAL_ROWS;
    if (isRefList(q)) return REF_ROWS;
    return [];
  };

// ── 1. citation fidelity ──────────────────────────────────────────────────────

describe('A1 citation fidelity — the exact stored token, source field and anchor', () => {
  it('GraphQL case detail returns every reference field exactly as stored (no rebuilt token)', async () => {
    const f = fixture(detailWorld());
    const res = await f.run(`{
      judicialCase(caseId: "2001") {
        legalReferences {
          caseLegalReferenceId caseId sourceField hearingIndex actType actNumber actYear
          issuerSlug articleFragment targetActId resolutionStatus confidenceScore citation
        }
      }
    }`);
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ judicialCase: { legalReferences: EXPECTED_REFS } });
    // The served projection reads the stored token and keeps the S2 exclusion.
    const refQuery = f.executed.find(isRefList);
    expect(refQuery?.sql).toContain('lr.raw_text as citation');
    expect(refQuery?.parameters).toContain('solution_summary');
  });

  it('MCP get_judicial_case and get_case_legal_references carry the same citations and count citations', async () => {
    const f = fixture(detailWorld());
    const detail = await f.mcp('get_judicial_case', { caseId: '2001' });
    expect(detail.ok).toBe(true);
    const item = detail.item as { legalReferences: unknown };
    expect(item.legalReferences).toEqual(EXPECTED_REFS);

    const refs = await f.mcp('get_case_legal_references', { caseId: '2001' });
    expect(refs.ok).toBe(true);
    expect(refs.items).toEqual(EXPECTED_REFS);
    expect(refs.summary).toBe('Case 2001 has 3 legal citation(s) (1 uniquely resolved).');
    for (const payload of [detail, refs]) {
      const keys = deepKeys(payload);
      for (const leaked of ['cursor', 'node', 'sort_key', 'edges']) {
        expect(keys.has(leaked), `${leaked} leaked into an MCP payload`).toBe(false);
      }
    }
  });
});

// ── 2. truthful temporal text (no JS Date conversion) ─────────────────────────

describe('A1 temporal display — SQL text passes through repos, usecase, scalars and MCP', () => {
  const exceptional: World = {
    asOf: 'infinity',
    caseOver: {
      source_opened_at: '0001-12-31 BC',
      latest_source_modified_at: '10000-01-01T00:00:00.000000+00 AD',
    },
    hearings: EXCEPTIONAL_HEARING_ROWS,
    appeals: EXCEPTIONAL_APPEAL_ROWS,
  };

  it('case detail with exceptional case, child and asOf values serializes them verbatim', async () => {
    const f = fixture(detailWorld(exceptional));
    const res = await f.run(`{
      judicialCase(caseId: "2001") {
        case { caseId sourceOpenedAt latestSourceModifiedAt }
        hearings { hearingIndex hearingAt pronouncementDate documentDate }
        appeals { appealIndex appealDeclaredAt }
        asOf { asOf estimated }
      }
    }`);
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      judicialCase: {
        case: {
          caseId: '2001',
          sourceOpenedAt: '0001-12-31 BC',
          latestSourceModifiedAt: '10000-01-01T00:00:00.000000+00 AD',
        },
        hearings: [
          {
            hearingIndex: 0,
            hearingAt: '2026-05-04T13:15:00.123Z',
            pronouncementDate: '2026-05-04',
            documentDate: '5874897-12-31 AD',
          },
          {
            hearingIndex: 1,
            hearingAt: 'infinity',
            pronouncementDate: '0001-12-31 BC',
            documentDate: null,
          },
        ],
        appeals: [{ appealIndex: 0, appealDeclaredAt: '-infinity' }],
        asOf: { asOf: 'infinity', estimated: true },
      },
    });
  });

  it('a case-ID-only detail query still loads every child eagerly without error', async () => {
    const f = fixture(detailWorld(exceptional));
    const res = await f.run('{ judicialCase(caseId: "2001") { case { caseId } } }');
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ judicialCase: { case: { caseId: '2001' } } });
    expect(f.executed.some((q) => q.sql.includes('from justice.case_hearings h'))).toBe(true);
  });

  it('MCP get_judicial_case returns the same verbatim exceptional values', async () => {
    const f = fixture(detailWorld(exceptional));
    const out = await f.mcp('get_judicial_case', { caseId: '2001' });
    expect(out.ok).toBe(true);
    expect(out.item).toMatchObject({
      case: {
        sourceOpenedAt: '0001-12-31 BC',
        sourceOpenedAtBasis: 'portal_header_data',
        latestSourceModifiedAt: '10000-01-01T00:00:00.000000+00 AD',
      },
      hearings: [
        { hearingAt: '2026-05-04T13:15:00.123Z', documentDate: '5874897-12-31 AD' },
        { hearingAt: 'infinity', pronouncementDate: '0001-12-31 BC' },
      ],
      appeals: [{ appealDeclaredAt: '-infinity' }],
      // A2: the additive source-scoped metadata (this case's source is portal_just).
      asOf: {
        asOf: 'infinity',
        estimated: true,
        sourceSlug: 'portal_just',
        basis: 'max_stored_source_modified_at',
        captureFreshnessAt: null,
        loadFreshnessAt: null,
      },
    });
  });
});

// ── 3. case-list cursors: repo-built, exact, passed through ────────────────────

const LIST_QUERY = `query ($filter: JudicialCasesFilter, $first: Int, $after: String, $sort: JudicialCaseSort, $dir: JudicialSortDir) {
  judicialCases(filter: $filter, first: $first, after: $after, sort: $sort, dir: $dir) {
    edges { cursor node { caseId latestSourceModifiedAt } }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface Conn {
  edges: { cursor: string; node: { caseId: string } }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const listRows = [
  caseRow('9', { sort_key: '2026-05-04T13:15:00.123456+00 AD' }),
  caseRow('9007199254740993', { sort_key: '2026-05-04T13:15:00.123456+00 AD' }),
  caseRow('100', { sort_key: null, latest_source_modified_at: null }),
];

describe('A1 case-list cursors — every edge cursor is the row exact tuple', () => {
  it('a nonfinal page: each edge decodes to [exact key, id]; next/endCursor = the last edge', async () => {
    const f = fixture((q) => (isCaseList(q) ? listRows : []));
    const res = await f.run(LIST_QUERY, { filter: FILTER, first: 2 });
    expect(res.errors).toBeUndefined();
    const conn = res.data?.['judicialCases'] as Conn;
    expect(conn.edges.map((e) => e.node.caseId)).toEqual(['9', '9007199254740993']);
    const expected = { sort: 'modifiedAt', dir: 'desc', fhash: V2_FHASH } as const;
    expect(conn.edges.map((e) => decodeCursor(e.cursor, expected)._unsafeUnwrap().keys)).toEqual([
      ['2026-05-04T13:15:00.123456+00 AD', '9'],
      ['2026-05-04T13:15:00.123456+00 AD', '9007199254740993'],
    ]);
    expect(conn.pageInfo).toEqual({ hasNextPage: true, endCursor: conn.edges[1]?.cursor });
  });

  it('a final nonempty page keeps endCursor on its last edge; a null sort value keys as the empty sentinel', async () => {
    const f = fixture((q) => (isCaseList(q) ? listRows : []));
    const res = await f.run(LIST_QUERY, { filter: FILTER, first: 3 });
    const conn = res.data?.['judicialCases'] as Conn;
    expect(conn.pageInfo).toEqual({ hasNextPage: false, endCursor: conn.edges[2]?.cursor });
    const last = decodeCursor(conn.edges[2]?.cursor ?? '', {
      sort: 'modifiedAt',
      dir: 'desc',
      fhash: V2_FHASH,
    })._unsafeUnwrap();
    expect(last.keys).toEqual(['', '100']);
  });

  it('an empty page has a null endCursor', async () => {
    const f = fixture(() => []);
    const res = await f.run(LIST_QUERY, { filter: FILTER, first: 2 });
    expect(res.data?.['judicialCases']).toEqual({
      edges: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
  });

  it('following an edge sends its exact key and id to SQL; the node carries no cursor metadata', async () => {
    const f = fixture((q) => (isCaseList(q) ? listRows : []));
    const first = await f.run(LIST_QUERY, { filter: FILTER, first: 2 });
    const cursor = (first.data?.['judicialCases'] as Conn).edges[1]?.cursor;
    await f.run(LIST_QUERY, { filter: FILTER, first: 2, after: cursor });
    const follow = f.executed[f.executed.length - 1];
    expect(follow?.parameters).toContain('2026-05-04T13:15:00.123456+00 AD');
    expect(follow?.parameters).toContain('9007199254740993');

    const page = (
      await f.repos.cases.listCursor({
        filter: FILTER,
        sort: 'modifiedAt',
        dir: 'desc',
        page: { first: 2 },
      })
    )._unsafeUnwrap();
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual(['cursor', 'node']);
    expect(Object.keys(page.items[0]?.node ?? {}).sort()).toEqual(
      Object.keys({
        caseId: 0,
        sourceSlug: 0,
        institutionCode: 0,
        caseNumber: 0,
        caseNumberOld: 0,
        department: 0,
        category: 0,
        categoryName: 0,
        stage: 0,
        stageName: 0,
        object: 0,
        sourceOpenedAt: 0,
        // A2: the additive date basis (a domain field, not cursor metadata).
        sourceOpenedAtBasis: 0,
        latestSourceModifiedAt: 0,
      }).sort()
    );
    expect(page.next).toBe(page.items[1]?.cursor);
  });
});

// ── 4. typed rejection before ANY SQL ─────────────────────────────────────────

const OK_TS = '2026-05-04T13:15:00.123456+00 AD';

/**
 * Optional request overrides. Only a LEGACY token is requested with its own sort,
 * so it is rejected by the cursor-v2 identity (the original code accepts it), not
 * by an unrelated sort mismatch; the deliberate wrong-sort entry keeps the default.
 */
interface ListRequest {
  readonly sort?: 'openedAt' | 'modifiedAt';
}

const REJECTED_CASE_CURSORS: readonly (readonly [string, string, ListRequest?])[] = [
  ['not base64url', 'not a cursor!'],
  ['not JSON', b64('not json')],
  ['a JSON array', b64('[1,2]')],
  ['no keys', b64(JSON.stringify({ v: 1, sort: 'modifiedAt', dir: 'desc', fhash: V2_FHASH }))],
  ['zero keys', caseToken([])],
  ['one key', caseToken([OK_TS])],
  ['three keys', caseToken([OK_TS, '9', '9'])],
  [
    'a numeric id above 2^53 (would round)',
    rawToken(
      `{"v":1,"sort":"modifiedAt","dir":"desc","keys":["${OK_TS}",9007199254740993],"fhash":"${V2_FHASH}"}`
    ),
  ],
  ['a numeric small id', caseToken([OK_TS, 9])],
  ['a null id', caseToken([OK_TS, null])],
  ['an object key', caseToken([{ t: OK_TS }, '9'])],
  ['an array key', caseToken([[OK_TS], '9'])],
  ['a boolean key', caseToken([true, '9'])],
  ['a numeric timestamp key', caseToken([1_746_364_500_123, '9'])],
  ['id -0', caseToken([OK_TS, '-0'])],
  ['id with a leading zero', caseToken([OK_TS, '007'])],
  ['id above the bigint range', caseToken([OK_TS, '9223372036854775808'])],
  ['id below the bigint range', caseToken([OK_TS, '-9223372036854775809'])],
  ['id in exponent form', caseToken([OK_TS, '1e3'])],
  ['id with whitespace', caseToken([OK_TS, ' 1'])],
  ['an empty id', caseToken([OK_TS, ''])],
  ['year zero', caseToken(['0000-01-01T00:00:00.000000+00 AD', '9'])],
  ['Feb 29 of a common year', caseToken(['2023-02-29T00:00:00.000000+00 AD', '9'])],
  ['Feb 29 of AD 1', caseToken(['0001-02-29T00:00:00.000000+00 AD', '9'])],
  ['Feb 29 of 101 BC (astronomical -100)', caseToken(['0101-02-29T00:00:00.000000+00 BC', '9'])],
  ['Feb 29 of 1900', caseToken(['1900-02-29T00:00:00.000000+00 AD', '9'])],
  ['April 31', caseToken(['2024-04-31T00:00:00.000000+00 AD', '9'])],
  ['month 13', caseToken(['2024-13-01T00:00:00.000000+00 AD', '9'])],
  ['month 0', caseToken(['2024-00-10T00:00:00.000000+00 AD', '9'])],
  ['day 0', caseToken(['2024-01-00T00:00:00.000000+00 AD', '9'])],
  ['hour 24', caseToken(['2024-01-01T24:00:00.000000+00 AD', '9'])],
  ['minute 60', caseToken(['2024-01-01T23:60:00.000000+00 AD', '9'])],
  ['second 60', caseToken(['2024-01-01T23:59:60.000000+00 AD', '9'])],
  ['five fractional digits', caseToken(['2024-01-01T00:00:00.12345+00 AD', '9'])],
  ['seven fractional digits', caseToken(['2024-01-01T00:00:00.1234567+00 AD', '9'])],
  ['a non-UTC offset', caseToken(['2024-01-01T00:00:00.000000+01 AD', '9'])],
  ['a -00 offset', caseToken(['2024-01-01T00:00:00.000000-00 AD', '9'])],
  ['a Z suffix', caseToken(['2024-01-01T00:00:00.000000Z', '9'])],
  ['no era', caseToken(['2024-01-01T00:00:00.000000+00', '9'])],
  ['a lowercase era', caseToken(['2024-01-01T00:00:00.000000+00 ad', '9'])],
  ['a CE era', caseToken(['2024-01-01T00:00:00.000000+00 CE', '9'])],
  ['a space instead of T', caseToken(['2026-05-04 13:15:00.123456+00 AD', '9'])],
  ['one microsecond below the minimum', caseToken(['4714-11-23T23:59:59.999999+00 BC', '9'])],
  ['a BC year past the minimum', caseToken(['4715-01-01T00:00:00.000000+00 BC', '9'])],
  ['past the maximum', caseToken(['294277-01-01T00:00:00.000000+00 AD', '9'])],
  ['an expanded year with a leading zero', caseToken(['010000-01-01T00:00:00.000000+00 AD', '9'])],
  ['a capitalised Infinity', caseToken(['Infinity', '9'])],
  ['epoch', caseToken(['epoch', '9'])],
  ['now', caseToken(['now', '9'])],
  ['a legacy millisecond key under the v2 identity', caseToken(['2026-05-04T13:15:00.123Z', '9'])],
  ['a legacy date key under the v2 identity', caseToken(['2026-05-04', '9'])],
  [
    'a legacy modifiedAt token (original identity)',
    buildNextCursor({
      sort: 'modifiedAt',
      dir: 'desc',
      fhash: BASE_FHASH,
      lastKeys: ['2026-05-04T13:15:00.123Z', '9'],
    }),
  ],
  [
    'a legacy openedAt token (original identity)',
    buildNextCursor({
      sort: 'openedAt',
      dir: 'desc',
      fhash: BASE_FHASH,
      lastKeys: ['2024-03-10', '9'],
    }),
    { sort: 'openedAt' },
  ],
  ['a different filter', caseToken([OK_TS, '9'], { fhash: 'judicial_cases:cursor-v2:x' })],
  ['a different sort', caseToken([OK_TS, '9'], { sort: 'openedAt' })],
  ['a different direction', caseToken([OK_TS, '9'], { dir: 'asc' })],
  ['another envelope version', caseToken([OK_TS, '9'], { v: 2 })],
];

describe('A1 case cursors — malformed, non-canonical and legacy tokens reject with zero DB calls', () => {
  it.each(REJECTED_CASE_CURSORS.map(([label, after, request]) => ({ label, after, request })))(
    '$label',
    async ({ after, request }) => {
      const f = fixture(() => {
        throw new Error('no SQL may run for a rejected cursor');
      });
      const res = await f.run(LIST_QUERY, { filter: FILTER, first: 2, after, ...request });
      expect(res.data).toBeNull();
      expect(res.errors?.[0]?.code).toBe('INVALID_INPUT');
      expect(res.errors?.[0]?.message).toMatch(/restart pagination/u);
      expect(f.executed).toEqual([]);
    }
  );

  it.each([
    ['the timestamp minimum', '4714-11-24T00:00:00.000000+00 BC', '9'],
    ['the timestamp maximum', '294276-12-31T23:59:59.999999+00 AD', '9'],
    ['Feb 29 of 1 BC (astronomical 0)', '0001-02-29T00:00:00.000000+00 BC', '9'],
    ['Feb 29 of 5 BC', '0005-02-29T00:00:00.000000+00 BC', '9'],
    ['Feb 29 of 401 BC (astronomical -400)', '0401-02-29T00:00:00.000000+00 BC', '9'],
    ['Feb 29 of 2000', '2000-02-29T00:00:00.000000+00 AD', '9'],
    ['an expanded year', '10000-01-01T00:00:00.000000+00 AD', '9'],
    ['infinity', 'infinity', '9'],
    ['-infinity', '-infinity', '9'],
    ['the NULL sentinel', '', '9'],
    ['the bigint minimum', OK_TS, '-9223372036854775808'],
    ['the bigint maximum', OK_TS, '9223372036854775807'],
    ['id 0', OK_TS, '0'],
  ])('accepts %s and reaches SQL with the exact values', async (_label, key, id) => {
    const f = fixture(() => []);
    const res = await f.run(LIST_QUERY, { filter: FILTER, first: 2, after: caseToken([key, id]) });
    expect(res.errors).toBeUndefined();
    expect(f.executed).toHaveLength(1);
    expect(f.executed[0]?.parameters).toContain(id);
    if (key !== '') expect(f.executed[0]?.parameters).toContain(key);
  });
});

// ── 5. reverse citations: reference-row grain, per-reference cursors ──────────

const CITING_QUERY = `query ($first: Int, $after: String) {
  judicialCasesCitingAct(targetActId: "42", first: $first, after: $after) {
    edges { cursor node { caseId } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const citingRow = (refId: string, caseId: string) => ({
  ref_id: refId,
  case_id: caseId,
  institution_code: COURT,
  case_number: `${caseId}/3/2026`,
  act_type: 'lege',
  act_number: '31',
  act_year: 1990,
});

describe('A1 reverse citations — one edge (and cursor) per reference row', () => {
  const citing: Respond = (q) => {
    if (!isCitingList(q)) return [];
    const after = q.parameters.find(
      (p): p is string => typeof p === 'string' && /^[0-9]+$/u.test(p) && p !== '42'
    );
    const rows = [citingRow('702', '2002'), citingRow('701', '2001'), citingRow('700', '2001')];
    return after === undefined ? rows : rows.filter((r) => BigInt(r.ref_id) < BigInt(after));
  };

  it('repeated cases keep distinct reference cursors; the final page keeps endCursor', async () => {
    const f = fixture(citing);
    const page1 = (await f.run(CITING_QUERY, { first: 2 })).data?.[
      'judicialCasesCitingAct'
    ] as Conn;
    expect(page1.edges.map((e) => e.node.caseId)).toEqual(['2002', '2001']);
    const expected = { sort: 'refId', dir: 'desc', fhash: CITING_FHASH } as const;
    expect(page1.edges.map((e) => decodeCursor(e.cursor, expected)._unsafeUnwrap().keys)).toEqual([
      ['702'],
      ['701'],
    ]);
    expect(page1.pageInfo).toEqual({ hasNextPage: true, endCursor: page1.edges[1]?.cursor });

    const page2 = (await f.run(CITING_QUERY, { first: 2, after: page1.pageInfo.endCursor })).data?.[
      'judicialCasesCitingAct'
    ] as Conn;
    expect(page2.edges.map((e) => e.node.caseId)).toEqual(['2001']);
    expect(decodeCursor(page2.edges[0]?.cursor ?? '', expected)._unsafeUnwrap().keys).toEqual([
      '700',
    ]);
    expect(page2.pageInfo).toEqual({ hasNextPage: false, endCursor: page2.edges[0]?.cursor });
  });

  it('a legacy valid end cursor (reference id) is still accepted', async () => {
    const f = fixture(citing);
    const legacyEnd = buildNextCursor({
      sort: 'refId',
      dir: 'desc',
      fhash: CITING_FHASH,
      lastKeys: ['701'],
    });
    const res = await f.run(CITING_QUERY, { first: 2, after: legacyEnd });
    expect(res.errors).toBeUndefined();
    expect(f.executed[0]?.parameters).toContain('701');
    expect((res.data?.['judicialCasesCitingAct'] as Conn).edges.map((e) => e.node.caseId)).toEqual([
      '2001',
    ]);
  });

  it.each([
    [
      'a legacy per-edge caseId cursor',
      buildNextCursor({ sort: 'caseId', dir: 'desc', fhash: CITING_FHASH, lastKeys: ['2001'] }),
    ],
    [
      'another target',
      buildNextCursor({
        sort: 'refId',
        dir: 'desc',
        fhash: 'judicial_cases_citing:43',
        lastKeys: ['701'],
      }),
    ],
    [
      'two keys',
      buildNextCursor({ sort: 'refId', dir: 'desc', fhash: CITING_FHASH, lastKeys: ['701', '1'] }),
    ],
    [
      'a numeric key',
      rawToken(`{"v":1,"sort":"refId","dir":"desc","keys":[701],"fhash":"${CITING_FHASH}"}`),
    ],
    [
      'id -0',
      buildNextCursor({ sort: 'refId', dir: 'desc', fhash: CITING_FHASH, lastKeys: ['-0'] }),
    ],
    [
      'id above the bigint range',
      buildNextCursor({
        sort: 'refId',
        dir: 'desc',
        fhash: CITING_FHASH,
        lastKeys: ['9223372036854775808'],
      }),
    ],
  ])('rejects %s with zero DB calls', async (_label, after) => {
    const f = fixture(() => {
      throw new Error('no SQL may run for a rejected cursor');
    });
    const res = await f.run(CITING_QUERY, { first: 2, after });
    expect(res.errors?.[0]?.code).toBe('INVALID_INPUT');
    expect(res.errors?.[0]?.message).toMatch(/restart pagination/u);
    expect(f.executed).toEqual([]);
  });
});
