/**
 * API-04 — stored decisions + the complete judicial read matrix (unit level,
 * scripted driver; the native-DDL proof is judicial-api04.pg.test.ts).
 *
 * Every expectation is a literal written here (names, SQL fragments, IDs,
 * values), never derived from the production constants or transforms. A
 * scripted Kysely driver records every statement so "rejected before SQL"
 * claims are observed, not assumed.
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

import {
  JUDICIAL_RESOLVE_DIMS,
  isJudicialDecisionYearOperand,
  isJudicialSignedId,
  makeJudicialModule,
} from '@/modules/judicial/index.js';
import {
  DECISION_FLAT_RULES,
  DECISION_LINK_FLAT_RULES,
  flatToFilter,
} from '@/modules/judicial/shell/filters/transport-input.js';
import { makeJudicialCaseRepo } from '@/modules/judicial/shell/repo/cases-repo.js';
import {
  decisionCursorFhash,
  decisionLinkCursorFhash,
  makeJudicialDecisionRepo,
} from '@/modules/judicial/shell/repo/decisions-repo.js';
import {
  buildNextCursor,
  createContributorRegistry,
  encodeCursor,
  kernelToolInputSchema,
  type FilterInput,
  type ProdDatabase,
} from '@/modules/shared/index.js';
import { scalarResolvers, scalarTypeDefs } from '@/modules/shared/shell/graphql/scalars.js';

import type { JudicialDecisionRepo } from '@/modules/judicial/core/ports.js';

interface Executed {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

type Respond = (q: Executed) => readonly unknown[];

const scriptedDb = (respond: Respond = () => []) => {
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
  return { db, executed };
};

const GLUE_TYPEDEFS =
  `${scalarTypeDefs}\n` +
  'type PageInfo { hasNextPage: Boolean! endCursor: String }\n' +
  'type LegalAct { actId: BigInt }\n' +
  'type Query { ping: String }\n';

const fixture = (respond: Respond = () => []) => {
  const { db, executed } = scriptedDb(respond);
  const module = makeJudicialModule({
    db,
    registry: createContributorRegistry(),
    legalActLoader: () => undefined,
  });
  const schema = makeExecutableSchema({
    typeDefs: GLUE_TYPEDEFS + module.graphqlSlice.typeDefs,
    resolvers: { ...scalarResolvers, ...(module.graphqlResolvers as Record<string, never>) },
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
  const tool = (name: string) => {
    const found = module.mcpTools.find((t) => t.name === name);
    if (found === undefined) throw new Error(`tool ${name} missing`);
    return found;
  };
  return { module, run, tool, executed };
};

const decisionsRepo = (respond: Respond = () => []) => {
  const { db, executed } = scriptedDb(respond);
  return { repo: makeJudicialDecisionRepo(db), executed };
};

/** A stored decision row as the driver would return it (all text IDs). */
const decisionRow = (id: string, extra: Record<string, unknown> = {}) => ({
  decision_id: id,
  issuing_body: 'ccr',
  source_system: 'ccr_decision',
  source_ref: `decision:2020:${id}`,
  decision_no: null,
  decision_year: null,
  decision_date: null,
  decision_kind: null,
  outcome_normalized: null,
  ecli: null,
  application_no: null,
  attrs: {},
  privacy_class: 'public',
  source_url: 'https://example.invalid/d',
  source_object_key: null,
  created_at: '2026-01-02T03:04:05.123456+00 AD',
  updated_at: '2026-01-02T03:04:05.123456+00 AD',
  ...extra,
});

const isDecisionList = (q: Executed) =>
  q.sql.includes('from justice.decisions d') && q.sql.includes('order by d.decision_id desc');

// ── 1. the complete surface inventory (literal) ───────────────────────────────

describe('API-04 surface inventory — 17 judicial GraphQL roots, 17 MCP tools', () => {
  it('declares exactly the 17 reviewed judicial Query roots', async () => {
    const f = fixture();
    const res = await f.run('{ __type(name: "Query") { fields { name } } }');
    const roots = (res.data?.['__type'] as { fields: { name: string }[] }).fields
      .map((x) => x.name)
      .filter((name) => name !== 'ping')
      .sort();
    expect(roots).toEqual(
      [
        'judicialCourts',
        'judicialCourt',
        'judicialCase',
        'judicialCases',
        'judicialCaseload',
        'judicialCompanyLitigation',
        'judicialCompanyLitigationCases',
        'judicialCasesCitingAct',
        'judicialResolve',
        'judicialCaseLegalReferences',
        'judicialCaseLineage',
        'judicialIssuingBodies',
        'judicialDecision',
        'judicialDecisionBySource',
        'judicialDecisions',
        'judicialDecisionSubjectLinks',
        'judicialDecisionResolve',
      ].sort()
    );
  });

  it('registers exactly the 17 reviewed MCP tools; every new one is strict', () => {
    const f = fixture();
    const names = f.module.mcpTools.map((t) => t.name);
    expect(names).toEqual([
      'resolve_judicial_filters',
      'get_judicial_case',
      'get_court_caseload',
      'get_company_litigation',
      'get_case_legal_references',
      'list_judicial_courts',
      'get_judicial_court',
      'list_judicial_cases',
      'get_case_lineage',
      'list_company_litigation_cases',
      'list_cases_citing_act',
      'list_judicial_issuing_bodies',
      'list_judicial_decisions',
      'get_judicial_decision',
      'get_judicial_decision_by_source',
      'list_judicial_decision_subject_links',
      'resolve_judicial_decision_filters',
    ]);
    const OLD = new Set(names.slice(0, 5));
    for (const t of f.module.mcpTools) {
      expect(t.strictInput === true, t.name).toBe(!OLD.has(t.name));
    }
  });

  it('keeps the case discovery dimensions exactly four', () => {
    expect([...JUDICIAL_RESOLVE_DIMS]).toEqual(['court', 'courtLevel', 'companyName', 'category']);
  });

  it('the stored enums carry exactly the DDL CHECK values; the new JSON slots are nullable', async () => {
    const f = fixture();
    const enumValues = async (name: string) =>
      (
        (await f.run(`{ __type(name: "${name}") { enumValues { name } } }`)).data?.['__type'] as {
          enumValues: { name: string }[];
        }
      ).enumValues.map((v) => v.name);
    expect(await enumValues('JudicialIssuingBodyKind')).toEqual([
      'court',
      'administrative_tribunal',
      'international_court',
    ]);
    expect(await enumValues('JudicialDecisionPrivacyClass')).toEqual(['public', 'restricted']);
    expect(await enumValues('JudicialDecisionSubjectKind')).toEqual([
      'company',
      'public_entity',
      'contract',
      'ecris_case',
      'notice',
    ]);
    expect(await enumValues('JudicialDecisionLinkValidationStatus')).toEqual([
      'candidate',
      'needs_review',
      'accepted',
      'rejected',
    ]);
    const fieldType = async (type: string, field: string) => {
      const res = await f.run(
        `{ __type(name: "${type}") { fields { name type { kind name ofType { name } } } } }`
      );
      return (
        res.data?.['__type'] as {
          fields: { name: string; type: { kind: string; name: string | null } }[];
        }
      ).fields.find((x) => x.name === field)?.type;
    };
    expect(await fieldType('JudicialDecision', 'attrs')).toMatchObject({
      kind: 'SCALAR',
      name: 'JSON',
    });
    expect(await fieldType('JudicialDecisionSubjectLink', 'evidence')).toMatchObject({
      kind: 'SCALAR',
      name: 'JSON',
    });
    // Correction 1: the lineage target is nullable (BigInt, not BigInt!).
    expect(await fieldType('JudicialLineageEdge', 'toCaseId')).toMatchObject({
      kind: 'SCALAR',
      name: 'BigInt',
    });
  });
});

// ── 2. the native-value predicates ────────────────────────────────────────────

describe('API-04 native predicates', () => {
  it.each([
    ['0', true],
    ['-1', true],
    ['9223372036854775807', true],
    ['-9223372036854775808', true],
    ['9007199254740993', true],
    ['-0', false],
    ['01', false],
    ['+1', false],
    [' 1', false],
    ['1 ', false],
    ['1.0', false],
    ['', false],
    ['9223372036854775808', false],
    ['-9223372036854775809', false],
    ['99999999999999999999', false],
    [1, false],
    [null, false],
  ] as const)('isJudicialSignedId(%j) is %s', (value, expected) => {
    expect(isJudicialSignedId(value)).toBe(expected);
  });

  it.each([
    [0, true],
    [-32768, true],
    [32767, true],
    [40000, true],
    [-2147483648, true],
    [2147483647, true],
    [2147483648, false],
    [-2147483649, false],
    [1.5, false],
    ['2020', false],
    [Number.NaN, false],
    [null, false],
  ] as const)('isJudicialDecisionYearOperand(%j) is %s', (value, expected) => {
    expect(isJudicialDecisionYearOperand(value)).toBe(expected);
  });
});

// ── 3. the decision list: bound, page, year, cursor ────────────────────────────

describe('decisions repo — list bound, ORIGINAL page, native year and strict cursor', () => {
  const PAGE = { first: 20 };

  it.each<[string, unknown]>([
    ['no filter', {}],
    ['only a year', { decisionYear: { eq: 0 } }],
    ['only presence', { decisionDate: { isNull: true } }],
    ['only a privacy class', { privacyClass: { eq: 'public' } }],
    ['a null bound', { sourceSystem: { eq: null } }],
  ])('refuses %s before any SQL', async (_label, filter) => {
    const { repo, executed } = decisionsRepo();
    const res = await repo.list({ filter: filter as FilterInput, page: PAGE });
    expect(res.isErr() && res.error).toEqual({
      type: 'InvalidInput',
      message: 'judicial decision list requires sourceSystem.eq or issuingBody.eq',
      field: 'filter',
    });
    expect(executed).toEqual([]);
  });

  it('an explicit EMPTY sourceSystem is an exact equality bound (never trimmed or dropped)', async () => {
    const { repo, executed } = decisionsRepo();
    const res = await repo.list({ filter: { sourceSystem: { eq: '' } }, page: PAGE });
    expect(res.isOk()).toBe(true);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.sql).toContain('"d"."source_system" = $1');
    expect(executed[0]?.parameters).toEqual(['', 21]);
  });

  it.each<[string, unknown]>([
    ['zero', 0],
    ['above fifty', 51],
    ['a fraction', 1.5],
    ['a numeric string', '20'],
    ['negative', -1],
  ])('rejects a %s first value (no clamp) before SQL', async (_label, first) => {
    const { repo, executed } = decisionsRepo();
    const res = await repo.list({
      filter: { issuingBody: { eq: 'ccr' } },
      page: { first: first as number },
    });
    expect(res.isErr() && res.error).toMatchObject({ type: 'InvalidInput', field: 'first' });
    expect(executed).toEqual([]);
  });

  it('compiles every year operator against the smallint with explicit integer operands', async () => {
    const { repo, executed } = decisionsRepo();
    await repo.list({
      filter: {
        issuingBody: { eq: 'ccr' },
        decisionYear: { gte: -40000, lte: 40000, between: { from: 0, to: 32767 } },
      },
      page: PAGE,
    });
    const q = executed[0];
    expect(q?.sql).toContain('d.decision_year >= $2::integer');
    expect(q?.sql).toContain('d.decision_year <= $3::integer');
    expect(q?.parameters).toEqual(['ccr', 0, 32767, 21]);
  });

  it('an out-of-smallint eq is an empty native interval bound as integer, never a smallint parameter', async () => {
    const { repo, executed } = decisionsRepo();
    await repo.list({
      filter: { sourceSystem: { eq: 'x' }, decisionYear: { eq: 40000 } },
      page: PAGE,
    });
    expect(executed[0]?.sql).toContain('d.decision_year >= $2::integer');
    expect(executed[0]?.sql).toContain('d.decision_year <= $3::integer');
    expect(executed[0]?.parameters).toEqual(['x', 40000, 40000, 21]);
  });

  it('a contradictory interval compiles to FALSE; isNull composes with the operators', async () => {
    const { repo, executed } = decisionsRepo();
    await repo.list({
      filter: { sourceSystem: { eq: 'x' }, decisionYear: { gte: 5, lte: 4 } },
      page: PAGE,
    });
    expect(executed[0]?.sql).toMatch(/where "d"\."source_system" = \$1 and false/u);
    await repo.list({
      filter: { sourceSystem: { eq: 'x' }, decisionYear: { isNull: true } },
      page: PAGE,
    });
    expect(executed[1]?.sql).toContain('(d.decision_year is null)');
  });

  it.each<[string, unknown]>([
    ['a string operand', { eq: '2020' }],
    ['a fraction', { eq: 2020.5 }],
    ['beyond 32 bits', { gte: 2147483648 }],
    ['a bad isNull', { isNull: 'true' }],
  ])('rejects decisionYear with %s before SQL', async (_label, decisionYear) => {
    const { repo, executed } = decisionsRepo();
    const res = await repo.list({
      filter: { sourceSystem: { eq: 'x' }, decisionYear } as FilterInput,
      page: PAGE,
    });
    expect(res.isErr() && res.error.type).toBe('InvalidInput');
    expect(executed).toEqual([]);
  });

  it('selects named stored columns only, IDs as text, native date/timestamp renderers', async () => {
    const { repo, executed } = decisionsRepo();
    await repo.list({ filter: { sourceSystem: { eq: 'x' } }, page: PAGE });
    const sqlText = executed[0]?.sql ?? '';
    expect(sqlText).not.toMatch(/select \*/u);
    expect(sqlText).toContain('d.decision_id::text as decision_id');
    expect(sqlText).toMatch(/extract\(year from d\.decision_date\)::integer/u);
    expect(sqlText).toContain("to_char(d.created_at at time zone 'UTC'");
    expect(sqlText).toContain('order by d.decision_id desc');
    expect(sqlText).toMatch(/limit \$\d+\s*$/u);
  });

  it('builds per-row cursors from the native id and accepts its own next cursor', async () => {
    const rows = [decisionRow('9223372036854775807'), decisionRow('9007199254740993')];
    const { repo, executed } = decisionsRepo((q) => (isDecisionList(q) ? rows : []));
    const page1 = await repo.list({ filter: { sourceSystem: { eq: 'x' } }, page: { first: 1 } });
    expect(page1.isOk()).toBe(true);
    const value = page1._unsafeUnwrap();
    expect(value.items.map((i) => i.node.decisionId)).toEqual(['9223372036854775807']);
    expect(value.next).toBe(value.items[0]?.cursor);
    await repo.list({
      filter: { sourceSystem: { eq: 'x' } },
      page: { first: 1, after: value.next ?? '' },
    });
    expect(executed[1]?.sql).toContain('d.decision_id < $2::bigint');
    expect(executed[1]?.parameters).toEqual(['x', '9223372036854775807', 2]);
  });

  it('a terminal nonempty page has no next but every item keeps its cursor', async () => {
    const { repo } = decisionsRepo((q) => (isDecisionList(q) ? [decisionRow('-5')] : []));
    const page = (
      await repo.list({ filter: { sourceSystem: { eq: 'x' } }, page: { first: 5 } })
    )._unsafeUnwrap();
    expect(page.next).toBeNull();
    expect(page.items[0]?.cursor).toEqual(expect.any(String));
    expect(page.items[0]?.node.decisionId).toBe('-5');
  });

  const FILTER = { sourceSystem: { eq: 'x' } };
  const goodHash = decisionCursorFhash(FILTER);
  const raw = (body: unknown) => Buffer.from(JSON.stringify(body)).toString('base64url');
  // A JSON number past 2^53 cannot be written as a JS literal; spell the text.
  const rawText = (text: string) => Buffer.from(text).toString('base64url');
  it.each<[string, string]>([
    [
      'a numeric key',
      rawText(
        `{"v":1,"sort":"decisionId","dir":"desc","keys":[9007199254740993],"fhash":${JSON.stringify(goodHash)}}`
      ),
    ],
    ['a null key', raw({ v: 1, sort: 'decisionId', dir: 'desc', keys: [null], fhash: goodHash })],
    ['an object key', raw({ v: 1, sort: 'decisionId', dir: 'desc', keys: [{}], fhash: goodHash })],
    ['two keys', raw({ v: 1, sort: 'decisionId', dir: 'desc', keys: ['1', '2'], fhash: goodHash })],
    [
      'a leading zero',
      encodeCursor({ v: 1, sort: 'decisionId', dir: 'desc', keys: ['01'], fhash: goodHash }),
    ],
    [
      'negative zero',
      encodeCursor({ v: 1, sort: 'decisionId', dir: 'desc', keys: ['-0'], fhash: goodHash }),
    ],
    [
      'an overflow',
      encodeCursor({
        v: 1,
        sort: 'decisionId',
        dir: 'desc',
        keys: ['9223372036854775808'],
        fhash: goodHash,
      }),
    ],
    [
      'the link collection',
      buildNextCursor({
        sort: 'linkId',
        dir: 'desc',
        fhash: decisionLinkCursorFhash({ decisionId: { eq: '1' } }),
        lastKeys: ['1'],
      }),
    ],
    [
      'a different filter',
      buildNextCursor({
        sort: 'decisionId',
        dir: 'desc',
        fhash: decisionCursorFhash({ sourceSystem: { eq: 'y' } }),
        lastKeys: ['1'],
      }),
    ],
    [
      'a case-list cursor',
      buildNextCursor({ sort: 'modifiedAt', dir: 'desc', fhash: goodHash, lastKeys: ['', '1'] }),
    ],
    ['garbage', 'not-a-cursor'],
  ])('rejects %s cursor before SQL', async (_label, after) => {
    const { repo, executed } = decisionsRepo();
    const res = await repo.list({ filter: FILTER, page: { first: 5, after } });
    expect(res.isErr() && res.error.type).toBe('InvalidInput');
    expect(executed).toEqual([]);
  });

  it('getById: a noncanonical id is InvalidInput before SQL; a valid id binds its exact text', async () => {
    const { repo, executed } = decisionsRepo();
    expect((await repo.getById('007'))._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(executed).toEqual([]);
    expect((await repo.getById('-9223372036854775808'))._unsafeUnwrap()).toBeNull();
    expect(executed[0]?.sql).toContain('where d.decision_id = $1::bigint');
    expect(executed[0]?.parameters).toEqual(['-9223372036854775808']);
  });

  it('getBySource binds BOTH exact text values (untrimmed)', async () => {
    const { repo, executed } = decisionsRepo();
    await repo.getBySource('  ccr_decision ', 'a/b:c?d#é');
    expect(executed[0]?.sql).toContain('where d.source_system = $1 and d.source_ref = $2');
    expect(executed[0]?.parameters).toEqual(['  ccr_decision ', 'a/b:c?d#é']);
  });

  // Direct-repo witnesses of the repo's own original-type check. The common
  // usecase validates first, so these do not show a public-API bypass.
  type UnknownBySource = (
    sourceSystem: unknown,
    sourceRef: unknown
  ) => ReturnType<JudicialDecisionRepo['getBySource']>;

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an array', ['ccr_decision']],
    ['an object', { eq: 'ccr_decision' }],
  ])('getBySource refuses %s in either position before SQL, without echo', async (_l, bad) => {
    const { repo, executed } = decisionsRepo();
    const call = repo.getBySource as UnknownBySource;
    expect((await call(bad, 'ref'))._unsafeUnwrapErr()).toEqual({
      type: 'InvalidInput',
      message: 'sourceSystem is required (exact text)',
      field: 'sourceSystem',
    });
    expect((await call('ccr_decision', bad))._unsafeUnwrapErr()).toEqual({
      type: 'InvalidInput',
      message: 'sourceRef is required (exact text)',
      field: 'sourceRef',
    });
    expect((await call(bad, bad))._unsafeUnwrapErr()).toMatchObject({ field: 'sourceSystem' });
    expect(executed).toEqual([]);
  });

  it.each<[string, string, string]>([
    ['empty strings', '', ''],
    ['whitespace', ' ', '\t \n'],
    ['Unicode', 'sursă', 'décision/é'],
    ['delimiters', 'a,b;c', 'x\'y"z%_\\'],
  ])('getBySource keeps %s as EXACT operands; an absent pair is null', async (_l, sys, ref) => {
    const { repo, executed } = decisionsRepo();
    expect((await repo.getBySource(sys, ref))._unsafeUnwrap()).toBeNull();
    expect(executed).toHaveLength(1);
    expect(executed[0]?.parameters).toEqual([sys, ref]);
  });

  it('getBySource maps a present pair', async () => {
    const { repo } = decisionsRepo(() => [decisionRow('5', { source_ref: '' })]);
    expect((await repo.getBySource('ccr_decision', ''))._unsafeUnwrap()).toMatchObject({
      decisionId: '5',
      sourceSystem: 'ccr_decision',
      sourceRef: '',
    });
  });

  it('serves stored JSON values unchanged (object/array/scalar/null; amount strings)', async () => {
    const rows = [
      decisionRow('4', { attrs: null }),
      decisionRow('3', { attrs: [1, 'x'] }),
      decisionRow('2', { attrs: 'scalar' }),
      decisionRow('1', { attrs: { total_amount_eur: '9007199254740993.0100', z: { n: 1 } } }),
    ];
    const { repo } = decisionsRepo((q) => (isDecisionList(q) ? rows : []));
    const page = (
      await repo.list({ filter: { sourceSystem: { eq: 'x' } }, page: { first: 10 } })
    )._unsafeUnwrap();
    expect(page.items.map((i) => i.node.attrs)).toEqual([
      null,
      [1, 'x'],
      'scalar',
      { total_amount_eur: '9007199254740993.0100', z: { n: 1 } },
    ]);
  });
});

// ── 4. decision links: exactly one anchor ──────────────────────────────────────

describe('decision links repo — exactly one anchor; link grain; strict identity', () => {
  const PAGE = { first: 20 };

  it.each<[string, unknown]>([
    ['no anchor', {}],
    ['a status alone', { validationStatus: { in: ['accepted'] } }],
    ['a half pair (kind)', { subjectKind: { eq: 'company' } }],
    ['a half pair (ref)', { subjectRef: { eq: '123' } }],
    [
      'both anchor families',
      { decisionId: { eq: '1' }, subjectKind: { eq: 'company' }, subjectRef: { eq: '1' } },
    ],
    ['the decision anchor with half a pair', { decisionId: { eq: '1' }, subjectRef: { eq: '1' } }],
  ])('refuses %s before SQL', async (_label, filter) => {
    const { repo, executed } = decisionsRepo();
    const res = await repo.listSubjectLinks({ filter: filter as FilterInput, page: PAGE });
    expect(res.isErr() && res.error).toEqual({
      type: 'InvalidInput',
      message:
        'decision subject links require exactly one anchor: decisionId.eq, or both subjectKind.eq and subjectRef.eq',
      field: 'filter',
    });
    expect(executed).toEqual([]);
  });

  it.each(['01', '-0', '9223372036854775808', 'abc'])(
    'refuses the noncanonical decision anchor %j before SQL',
    async (decisionId) => {
      const { repo, executed } = decisionsRepo();
      const res = await repo.listSubjectLinks({
        filter: { decisionId: { eq: decisionId } },
        page: PAGE,
      });
      expect(res.isErr() && res.error).toMatchObject({ type: 'InvalidInput', field: 'decisionId' });
      expect(executed).toEqual([]);
    }
  );

  it('rejects an unknown kind or status value before SQL', async () => {
    const { repo, executed } = decisionsRepo();
    const kind = await repo.listSubjectLinks({
      filter: { subjectKind: { eq: 'person' }, subjectRef: { eq: '1' } },
      page: PAGE,
    });
    expect(kind.isErr()).toBe(true);
    const status = await repo.listSubjectLinks({
      filter: { decisionId: { eq: '1' }, validationStatus: { in: ['published'] } },
      page: PAGE,
    });
    expect(status.isErr()).toBe(true);
    expect(executed).toEqual([]);
  });

  it('binds the decision anchor ::bigint and the exact subject pair as text', async () => {
    const { repo, executed } = decisionsRepo();
    await repo.listSubjectLinks({
      filter: { decisionId: { eq: '-7' }, validationStatus: { in: ['accepted', 'rejected'] } },
      page: PAGE,
    });
    expect(executed[0]?.sql).toContain('"l"."validation_status" in ($1, $2)');
    expect(executed[0]?.sql).toContain('l.decision_id = $3::bigint');
    expect(executed[0]?.parameters).toEqual(['accepted', 'rejected', '-7', 21]);
    await repo.listSubjectLinks({
      filter: { subjectKind: { eq: 'ecris_case' }, subjectRef: { eq: ' 0042 ' } },
      page: PAGE,
    });
    expect(executed[1]?.sql).toContain('"l"."subject_kind" = $1 and "l"."subject_ref" = $2');
    expect(executed[1]?.parameters).toEqual(['ecris_case', ' 0042 ', 21]);
    expect(executed[1]?.sql).toContain('order by l.link_id desc');
    expect(executed[1]?.sql).toContain('l.confidence_score::text as confidence_score');
  });

  it('hashes the structured anchor: colon-bearing refs cannot alias another anchor', () => {
    const a = decisionLinkCursorFhash({
      subjectKind: { eq: 'company' },
      subjectRef: { eq: 'a:b' },
    });
    const b = decisionLinkCursorFhash({ subjectKind: { eq: 'company' }, subjectRef: { eq: 'a' } });
    const c = decisionLinkCursorFhash({
      subjectKind: { eq: 'contract' },
      subjectRef: { eq: 'a:b' },
    });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a.startsWith('judicial_decision_subject_links:cursor-v1:')).toBe(true);
  });

  it('a cursor minted under another anchor is rejected before SQL', async () => {
    const after = buildNextCursor({
      sort: 'linkId',
      dir: 'desc',
      fhash: decisionLinkCursorFhash({ decisionId: { eq: '1' } }),
      lastKeys: ['5'],
    });
    const { repo, executed } = decisionsRepo();
    const res = await repo.listSubjectLinks({
      filter: { decisionId: { eq: '2' } },
      page: { first: 5, after },
    });
    expect(res.isErr() && res.error.type).toBe('InvalidInput');
    expect(executed).toEqual([]);
  });
});

// ── 5. discovery ───────────────────────────────────────────────────────────────

describe('decision discovery — original dim/q/limit; LIKE escaping', () => {
  it.each<[string, unknown, number]>([
    ['an unknown dim', 'court', 10],
    ['limit 0', 'issuingBody', 0],
    ['limit 51', 'issuingBody', 51],
  ])('GraphQL: rejects %s with INVALID_INPUT before SQL', async (_label, dim, limit) => {
    const f = fixture();
    const res = await f.run(
      'query ($dim: String!, $limit: Int) { judicialDecisionResolve(dim: $dim, q: "x", limit: $limit) { value } }',
      { dim, limit }
    );
    expect(res.errors?.[0]?.code).toBe('INVALID_INPUT');
    expect(f.executed).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a non-string q', { dim: 'issuingBody', q: 5, limit: 10 }],
    ['a fractional limit', { dim: 'issuingBody', q: 'x', limit: 1.5 }],
    ['a string limit', { dim: 'issuingBody', q: 'x', limit: '10' }],
    ['a missing dim', { q: 'x' }],
  ])(
    'direct MCP call: rejects %s before SQL (original values, no coercion)',
    async (_label, args) => {
      const f = fixture();
      const out = await f.tool('resolve_judicial_decision_filters').handler(args);
      expect(out).toMatchObject({
        ok: false,
        errorType: 'InvalidInput',
        errorCode: 'INVALID_INPUT',
      });
      expect(f.executed).toEqual([]);
    }
  );

  it('escapes LIKE metacharacters in the bound pattern and never echoes q', async () => {
    const f = fixture();
    const out = await f
      .tool('resolve_judicial_decision_filters')
      .handler({ dim: 'sourceSystem', q: 'a%b_c\\d', limit: null });
    expect(out).toMatchObject({ ok: true, query: { dim: 'sourceSystem' } });
    expect(JSON.stringify(out)).not.toContain('a%b_c');
    expect(f.executed[0]?.sql).toContain("d.source_system ilike $1 escape '\\'");
    expect(f.executed[0]?.parameters).toEqual(['%a\\%b\\_c\\\\d%', 10]);
  });

  it('serves the static subject kinds and status labels', async () => {
    const f = fixture();
    const res = await f.run(
      '{ judicialDecisionResolve(dim: "validationStatus", q: "") { value hint } }'
    );
    expect(res.data).toEqual({
      judicialDecisionResolve: [
        { value: 'candidate', hint: 'recorded status label (not a verification)' },
        { value: 'needs_review', hint: 'recorded status label (not a verification)' },
        { value: 'accepted', hint: 'recorded status label (not a verification)' },
        { value: 'rejected', hint: 'recorded status label (not a verification)' },
      ],
    });
    expect(f.executed).toEqual([]);
  });
});

// ── 6. correction 2: the ambiguous natural-key lookup ──────────────────────────

describe('cases repo — the two-field lookup refuses ambiguity (LIMIT 2)', () => {
  const caseRow = (id: string, slug: string) => ({
    case_id: id,
    source_slug: slug,
    institution_code: 'COURT',
    case_number: '1/2024',
    case_number_old: null,
    department: null,
    category: null,
    category_name: null,
    stage: null,
    stage_name: null,
    object: null,
    source_opened_at: null,
    latest_source_modified_at: null,
  });

  it('two rows are a fixed InvalidInput that echoes no input or row value', async () => {
    const { db, executed } = scriptedDb(() => [caseRow('1', 'a'), caseRow('2', 'b')]);
    const res = await makeJudicialCaseRepo(db).getByNaturalKey('COURT', '1/2024');
    expect(res._unsafeUnwrapErr()).toEqual({
      type: 'InvalidInput',
      message: 'case lookup is ambiguous; use caseId',
      field: 'caseNumber',
    });
    expect(executed[0]?.sql).toMatch(/limit 2\s*$/u);
    expect(executed[0]?.parameters).toEqual(['COURT', '1/2024']);
  });

  it('one row still maps; zero rows is still null', async () => {
    const one = scriptedDb(() => [caseRow('7', 'iccj')]);
    expect(
      (await makeJudicialCaseRepo(one.db).getByNaturalKey('C', 'N'))._unsafeUnwrap()
    ).toMatchObject({
      caseId: '7',
      sourceSlug: 'iccj',
      sourceOpenedAtBasis: 'iccj_archive_case_date',
    });
    const none = scriptedDb(() => []);
    expect(
      (await makeJudicialCaseRepo(none.db).getByNaturalKey('C', 'N'))._unsafeUnwrap()
    ).toBeNull();
  });
});

// ── 7. GraphQL: connections, nullable lineage target, JSON values ──────────────

describe('GraphQL adapters over the same usecases', () => {
  it('judicialDecisions: repo edges pass through; endCursor on a terminal page; first null = 20', async () => {
    const f = fixture((q) => (isDecisionList(q) ? [decisionRow('3'), decisionRow('2')] : []));
    const res = await f.run(
      '{ judicialDecisions(filter: { issuingBody: { eq: "ccr" } }, first: null) { edges { cursor node { decisionId attrs } } pageInfo { hasNextPage endCursor } totalCount } }'
    );
    const conn = res.data?.['judicialDecisions'] as {
      edges: { cursor: string; node: { decisionId: string } }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      totalCount: number | null;
    };
    expect(conn.edges.map((e) => e.node.decisionId)).toEqual(['3', '2']);
    expect(conn.pageInfo).toEqual({ hasNextPage: false, endCursor: conn.edges[1]?.cursor });
    expect(conn.totalCount).toBeNull();
    expect(f.executed[0]?.parameters.at(-1)).toBe(21);
  });

  it('judicialDecisions without a bound is INVALID_INPUT with no SQL', async () => {
    const f = fixture();
    const res = await f.run(
      '{ judicialDecisions(filter: { decisionYear: { eq: 0 } }) { edges { cursor } } }'
    );
    expect(res.errors?.[0]?.code).toBe('INVALID_INPUT');
    expect(f.executed).toEqual([]);
  });

  it('judicialCaseLineage + case detail: an unresolved (NULL) target is null, without bubbling', async () => {
    const lineage = [
      {
        lineage_candidate_id: '9',
        from_case_id: '100',
        to_case_id: null,
        lineage_type: 'appeal',
        method: 'm',
        confidence_score: null,
        validation_status: 'candidate',
      },
    ];
    const f = fixture((q) =>
      q.sql.includes('from justice.case_lineage_candidates lc') ? lineage : []
    );
    const res = await f.run(
      '{ judicialCaseLineage(caseId: "100") { lineageCandidateId toCaseId } }'
    );
    expect(res).toEqual({
      data: { judicialCaseLineage: [{ lineageCandidateId: '9', toCaseId: null }] },
      errors: undefined,
    });
    const bad = await f.run('{ judicialCaseLineage(caseId: "-1") { lineageCandidateId } }');
    expect(bad.errors?.[0]?.code).toBe('INVALID_INPUT');
  });
});

// ── 8. MCP + transport mapping ─────────────────────────────────────────────────

describe('MCP tools and the shared flat mapping', () => {
  it('new tools reject unknown keys at the SDK schema (strictInput)', () => {
    const f = fixture();
    const schema = kernelToolInputSchema(f.tool('list_judicial_decisions'));
    expect(schema.safeParse({ sourceSystem: 'x' }).success).toBe(true);
    expect(schema.safeParse({ sourceSystem: 'x', bogus: 1 }).success).toBe(false);
    expect(schema.safeParse({ sourceSystem: 'x', first: 51 }).success).toBe(false);
  });

  it('list tools return the exact repo cursor in meta.cursor.next', async () => {
    const rows = [decisionRow('5'), decisionRow('4'), decisionRow('3')];
    const f = fixture((q) => (isDecisionList(q) ? rows : []));
    const out = await f.tool('list_judicial_decisions').handler({ sourceSystem: 'x', first: 2 });
    expect(out).toMatchObject({ ok: true, kind: 'judicial_decisions' });
    const items = out.items as { decisionId: string }[];
    expect(items.map((i) => i.decisionId)).toEqual(['5', '4']);
    const next = (out.meta as { cursor: { next: string } }).cursor.next;
    const again = await f
      .tool('list_judicial_decisions')
      .handler({ sourceSystem: 'x', first: 2, after: next });
    expect(again.ok).toBe(true);
    expect(f.executed[1]?.parameters).toEqual(['x', '4', 3]);
  });

  it('get_judicial_decision: malformed id is a typed failure; a valid absent id is a no-match success', async () => {
    const f = fixture();
    expect(await f.tool('get_judicial_decision').handler({ decisionId: '1e3' })).toMatchObject({
      ok: false,
      errorType: 'InvalidInput',
      errorCode: 'INVALID_INPUT',
    });
    expect(await f.tool('get_judicial_decision').handler({ decisionId: '12' })).toEqual({
      ok: true,
      kind: 'judicial_decision',
      query: { decisionId: '12' },
      summary: 'No matching decision.',
    });
  });

  it('REST/MCP flat arguments build exactly the GraphQL operator object (same cursor identity)', () => {
    const flat = {
      sourceSystem: 'ccr_decision',
      decisionYear: 0,
      decisionYearFrom: -5,
      decisionYearTo: 5,
      decisionYearGte: -1,
      decisionDateIsNull: false,
      ecliIsNull: true,
      privacyClass: 'restricted',
      ignoredNull: null,
    };
    const filter = flatToFilter(DECISION_FLAT_RULES, flat);
    expect(filter).toEqual({
      sourceSystem: { eq: 'ccr_decision' },
      decisionYear: { eq: 0, between: { from: -5, to: 5 }, gte: -1 },
      decisionDate: { isNull: false },
      ecli: { isNull: true },
      privacyClass: { eq: 'restricted' },
    });
    expect(decisionCursorFhash(filter)).toBe(
      decisionCursorFhash({
        privacyClass: { eq: 'restricted' },
        ecli: { isNull: true },
        decisionDate: { isNull: false },
        decisionYear: { gte: -1, between: { from: -5, to: 5 }, eq: 0 },
        sourceSystem: { eq: 'ccr_decision' },
      })
    );
    expect(
      flatToFilter(DECISION_LINK_FLAT_RULES, {
        decisionId: '-1',
        validationStatus: ['accepted'],
        subjectRef: null,
      })
    ).toEqual({ decisionId: { eq: '-1' }, validationStatus: { in: ['accepted'] } });
  });
});
