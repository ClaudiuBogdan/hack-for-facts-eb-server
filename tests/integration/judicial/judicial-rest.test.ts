/**
 * API-04 — the judicial REST plugin over Fastify.inject (fake repos; the
 * native-DDL proof is judicial-api04.pg.test.ts).
 *
 * Proves the HTTP adapter itself: all 19 GET paths (and HEAD), static-before-
 * parametric routing, ORIGINAL query validation before any repo call (unknown
 * keys, duplicate scalars, lexical integers/booleans, repeated lists without
 * CSV splitting), the module envelopes and kernel statuses (400 / 404 /
 * sanitized 500 + requestId), Cache-Control no-store, and exact serialization
 * of stored JSON values, text IDs and native date/timestamp spellings.
 * Expectations are literal.
 */

import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { makeJudicialRestPlugin } from '@/modules/judicial/shell/rest/routes.js';
import { databaseError, invalidInput } from '@/modules/shared/index.js';

import type { JudicialRepos } from '@/modules/judicial/core/usecases.js';

const PREFIX = '/api/v1/judicial';

const asOf = {
  asOf: null,
  estimated: true,
  sourceSlug: 'portal_just',
  basis: 'max_stored_source_modified_at' as const,
  captureFreshnessAt: null,
  loadFreshnessAt: null,
};

const DECISION = {
  decisionId: '9223372036854775807',
  issuingBody: 'anspdcp',
  sourceSystem: 'anspdcp_communication',
  sourceRef: 'a/b:c?d#é',
  decisionNo: null,
  decisionYear: 0,
  decisionDate: '5874897-12-31 AD',
  decisionKind: null,
  outcomeNormalized: null,
  ecli: null,
  applicationNo: null,
  attrs: { total_amount_eur: '9007199254740993.0100', nested: { list: [1, null, 'x'] } },
  privacyClass: 'restricted' as const,
  sourceUrl: null,
  sourceObjectKey: 'k',
  createdAt: '0001-01-01T00:00:00.000001+00 BC',
  updatedAt: 'infinity',
};

const LINK = {
  linkId: '-9223372036854775808',
  decisionId: '9223372036854775807',
  subjectKind: 'company' as const,
  subjectRef: '  007,8 ',
  role: null,
  method: null,
  confidenceScore: '0.500',
  validationStatus: 'accepted' as const,
  evidence: null,
  resolverVersion: null,
  createdAt: '2026-01-02T03:04:05.123456+00 AD',
  updatedAt: '2026-01-02T03:04:05.123456+00 AD',
};

const makeRepos = (over: Partial<Record<keyof JudicialRepos, unknown>> = {}) => {
  const base = {
    courts: {
      list: vi.fn(async () => ok([])),
      getByCode: vi.fn(async () => ok(null)),
      listChildren: vi.fn(async () => ok([])),
      resolveCourt: vi.fn(async () => ok([])),
      resolveCategory: vi.fn(async () => ok([])),
    },
    cases: {
      getById: vi.fn(async () => ok(null)),
      getByNaturalKey: vi.fn(async () => ok(null)),
      listCursor: vi.fn(async () => ok({ items: [], next: null })),
      aggregate: vi.fn(async () => ok({ groups: [], denominator: 0, coverage: 0 })),
      getAsOf: vi.fn(async () => ok(asOf)),
    },
    hearings: { listForCase: vi.fn(async () => ok([])) },
    appeals: { listForCase: vi.fn(async () => ok([])) },
    parties: { listForCase: vi.fn(async () => ok([])) },
    dictionary: {
      getPublishableName: vi.fn(async () => ok(null)),
      getPublishableNames: vi.fn(async () => ok(new Map())),
      resolveCompanyName: vi.fn(async () => ok([])),
    },
    companyLinks: {
      summaryForCui: vi.fn(async () =>
        ok({
          cui: '123',
          companyName: null,
          caseCount: 0,
          courtLevels: [],
          years: [],
          coverage: 0,
          caveats: ['company-litigation links not yet published'],
        })
      ),
      listCasesForCui: vi.fn(async () => ok({ items: [], next: null })),
    },
    legalRefs: {
      listForCase: vi.fn(async () => ok([])),
      casesCitingAct: vi.fn(async () => ok({ items: [], next: null })),
    },
    lineage: { lineageForCase: vi.fn(async () => ok([])) },
    decisions: {
      listIssuingBodies: vi.fn(async () => ok([])),
      getById: vi.fn(async () => ok(null)),
      getBySource: vi.fn(async () => ok(null)),
      list: vi.fn(async () => ok({ items: [], next: null })),
      listSubjectLinks: vi.fn(async () => ok({ items: [], next: null })),
      resolveIssuingBodies: vi.fn(async () => ok([])),
      resolveSourceSystems: vi.fn(async () => ok([])),
    },
  };
  return { ...base, ...over } as typeof base;
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const boot = async (repos: ReturnType<typeof makeRepos>) => {
  app = fastifyLib({ logger: false });
  await app.register(makeJudicialRestPlugin({ repos }), { prefix: PREFIX });
  await app.ready();
  return app;
};

const get = async (repos: ReturnType<typeof makeRepos>, url: string) => {
  const a = app ?? (await boot(repos));
  return a.inject({ method: 'GET', url: `${PREFIX}${url}` });
};

/** The 19 reviewed GET paths, literal. */
const PATHS = [
  '/courts',
  '/courts/:code',
  '/cases',
  '/cases/lookup',
  '/cases/:caseId',
  '/cases/aggregate',
  '/cases/:caseId/legal-references',
  '/cases/:caseId/lineage',
  '/companies/:cui/litigation',
  '/companies/:cui/cases',
  '/acts/:targetActId/cases',
  '/filters/resolve',
  '/issuing-bodies',
  '/decisions',
  '/decisions/lookup',
  '/decisions/:decisionId',
  '/decisions/:decisionId/subject-links',
  '/decision-subject-links',
  '/decisions/filters/resolve',
];

describe('judicial REST — the 19 GET paths are mounted, GET/HEAD only', () => {
  it('registers exactly the reviewed paths with GET and HEAD, and no write method', async () => {
    const a = await boot(makeRepos());
    expect(PATHS).toHaveLength(19);
    for (const path of PATHS) {
      expect(a.hasRoute({ method: 'GET', url: `${PREFIX}${path}` }), path).toBe(true);
      expect(a.hasRoute({ method: 'HEAD', url: `${PREFIX}${path}` }), path).toBe(true);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        expect(a.hasRoute({ method, url: `${PREFIX}${path}` }), `${method} ${path}`).toBe(false);
      }
    }
    const post = await a.inject({ method: 'POST', url: `${PREFIX}/decisions` });
    expect(post.statusCode).toBe(404);
  });

  it('static paths win over parametric ones; /decisions/filters is an invalid id (400), not 404', async () => {
    const repos = makeRepos();
    const res = await get(repos, '/decisions/filters');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, error: 'InvalidInput', field: 'decisionId' });
    const lookup = await get(repos, '/decisions/lookup?sourceSystem=s&sourceRef=r');
    expect(lookup.statusCode).toBe(404);
    expect(repos.decisions.getBySource).toHaveBeenCalledWith('s', 'r');
    expect(repos.decisions.getById).not.toHaveBeenCalled();
    const aggregate = await get(repos, '/cases/aggregate?groupBy=court&institutionCode=X');
    expect(aggregate.statusCode).toBe(200);
    expect(repos.cases.aggregate).toHaveBeenCalledTimes(1);
    expect(repos.cases.getById).not.toHaveBeenCalled();
  });

  it('every reply is no-store; HEAD answers without a body', async () => {
    const repos = makeRepos();
    const okRes = await get(repos, '/issuing-bodies');
    expect(okRes.headers['cache-control']).toBe('no-store');
    const errRes = await get(repos, '/decisions?sourceSystem=x&first=0');
    expect(errRes.statusCode).toBe(400);
    expect(errRes.headers['cache-control']).toBe('no-store');
    const head = await app!.inject({
      method: 'HEAD',
      url: `${PREFIX}/issuing-bodies`,
    });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
  });
});

describe('judicial REST — ORIGINAL query validation before any repo call', () => {
  it.each<[string, string]>([
    ['an unknown key', '/decisions?sourceSystem=x&bogus=1'],
    ['a bracket key', '/decisions?sourceSystem[]=x'],
    ['a duplicate scalar', '/decisions?sourceSystem=x&sourceSystem=y'],
    ['a fractional first', '/decisions?sourceSystem=x&first=1.0'],
    ['a leading-zero first', '/decisions?sourceSystem=x&first=05'],
    ['a padded integer', '/decisions?sourceSystem=x&decisionYear=%201'],
    ['a non-integer year', '/decisions?sourceSystem=x&decisionYear=abc'],
    ['an upper-case boolean', '/decisions?sourceSystem=x&ecliIsNull=TRUE'],
    ['a numeric boolean', '/decisions?sourceSystem=x&ecliIsNull=1'],
    ['an unsafe integer', '/decisions?sourceSystem=x&decisionYear=9007199254740993'],
  ])('rejects %s with 400 and calls no repo', async (_label, url) => {
    const repos = makeRepos();
    const res = await get(repos, url);
    expect(res.statusCode).toBe(400);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ ok: false, error: 'InvalidInput' });
    expect(typeof body['requestId']).toBe('string');
    expect(JSON.stringify(body)).not.toContain('bogus');
    expect(repos.decisions.list).not.toHaveBeenCalled();
  });

  it('a page value outside 1..50 is 400 (never clamped) for decision and case-family lists', async () => {
    const repos = makeRepos();
    for (const url of [
      '/decisions?sourceSystem=x&first=0',
      '/decisions?sourceSystem=x&first=51',
      '/cases?institutionCode=X&first=0',
      '/companies/123/cases?first=51',
      '/acts/1/cases?first=-1',
    ]) {
      const res = await get(repos, url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toMatchObject({ error: 'InvalidInput', field: 'first' });
    }
    expect(repos.decisions.list).not.toHaveBeenCalled();
    expect(repos.cases.listCursor).not.toHaveBeenCalled();
    expect(repos.companyLinks.listCasesForCui).not.toHaveBeenCalled();
    expect(repos.legalRefs.casesCitingAct).not.toHaveBeenCalled();
  });

  it('repeated parameters are a list; one occurrence is one member; commas are never split', async () => {
    const repos = makeRepos();
    await get(
      repos,
      '/decisions/5/subject-links?validationStatus=accepted&validationStatus=rejected'
    );
    await get(
      repos,
      '/decision-subject-links?subjectKind=company&subjectRef=a,b&validationStatus=accepted'
    );
    expect(repos.decisions.listSubjectLinks).toHaveBeenNthCalledWith(1, {
      filter: { decisionId: { eq: '5' }, validationStatus: { in: ['accepted', 'rejected'] } },
      page: { first: 20 },
    });
    expect(repos.decisions.listSubjectLinks).toHaveBeenNthCalledWith(2, {
      filter: {
        subjectKind: { eq: 'company' },
        subjectRef: { eq: 'a,b' },
        validationStatus: { in: ['accepted'] },
      },
      page: { first: 20 },
    });
  });

  it('the nested route owns its decision anchor: an anchor in the query is an unknown key', async () => {
    const repos = makeRepos();
    for (const url of [
      '/decisions/5/subject-links?decisionId=6',
      '/decisions/5/subject-links?subjectKind=company&subjectRef=1',
      '/decision-subject-links?decisionId=5',
    ]) {
      const res = await get(repos, url);
      expect(res.statusCode, url).toBe(400);
    }
    expect(repos.decisions.listSubjectLinks).not.toHaveBeenCalled();
  });

  it('flat decision parameters build the exact operator object (typed, decoded once)', async () => {
    const repos = makeRepos();
    await get(
      repos,
      '/decisions?sourceSystem=&decisionYear=0&decisionYearFrom=-5&decisionYearTo=40000&decisionYearIsNull=false&decisionDateIsNull=true&privacyClass=restricted&first=7&after=c'
    );
    expect(repos.decisions.list).toHaveBeenCalledWith({
      filter: {
        sourceSystem: { eq: '' },
        decisionYear: { eq: 0, between: { from: -5, to: 40000 }, isNull: false },
        decisionDate: { isNull: true },
        privacyClass: { eq: 'restricted' },
      },
      page: { first: 7, after: 'c' },
    });
  });

  it('flat case parameters map to the same operators GraphQL expresses', async () => {
    const repos = makeRepos();
    await get(
      repos,
      '/cases?institutionCode=A&institutionCode=B&courtLevel=tribunal&year=2024&yearGte=2020&modifiedFrom=2026-01-01T00:00:00.123456Z&objectIsNull=false&q=x&sort=openedAt&dir=ASC'
    );
    expect(repos.cases.listCursor).toHaveBeenCalledWith({
      filter: {
        institutionCode: { in: ['A', 'B'] },
        courtLevel: { in: ['tribunal'] },
        year: { eq: 2024, gte: 2020 },
        modified: { between: { from: '2026-01-01T00:00:00.123456Z' } },
        hasObject: { isNull: false },
        q: { contains: 'x' },
      },
      sort: 'openedAt',
      dir: 'asc',
      page: { first: 20 },
    });
  });
});

describe('judicial REST — envelopes and statuses', () => {
  it('a valid but absent detail is 404 with the module envelope', async () => {
    const repos = makeRepos();
    for (const url of ['/decisions/12', '/cases/12', '/courts/NOPE']) {
      const res = await get(repos, url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toMatchObject({ ok: false, error: 'NotFound' });
    }
    const lookup = await get(repos, '/cases/lookup?institutionCode=A&caseNumber=1');
    expect(lookup.statusCode).toBe(404);
  });

  it('the ambiguous two-field lookup is 400 with the fixed message, and no child read follows', async () => {
    const repos = makeRepos({
      cases: {
        ...makeRepos().cases,
        getByNaturalKey: vi.fn(async () =>
          err(invalidInput('case lookup is ambiguous; use caseId', 'caseNumber'))
        ),
      },
    });
    const res = await get(repos, '/cases/lookup?institutionCode=A&caseNumber=1%2F2024');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      ok: false,
      error: 'InvalidInput',
      message: 'case lookup is ambiguous; use caseId',
      field: 'caseNumber',
      requestId: expect.any(String) as unknown,
    });
    expect(repos.hearings.listForCase).not.toHaveBeenCalled();
    expect(repos.cases.getAsOf).not.toHaveBeenCalled();
  });

  it('/cases/lookup requires both natural-key parameters', async () => {
    const repos = makeRepos();
    const res = await get(repos, '/cases/lookup?institutionCode=A');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ field: 'caseNumber' });
    expect(repos.cases.getByNaturalKey).not.toHaveBeenCalled();
  });

  it('a database failure is a sanitized 500: no cause, SQL or driver text, a requestId', async () => {
    const repos = makeRepos({
      decisions: {
        ...makeRepos().decisions,
        listIssuingBodies: vi.fn(async () =>
          err(
            databaseError(
              'decisions.listIssuingBodies failed',
              new Error('relation "x" SELECT secret')
            )
          )
        ),
      },
    });
    const res = await get(repos, '/issuing-bodies');
    expect(res.statusCode).toBe(500);
    const body = res.json<Record<string, unknown>>();
    expect(body).toEqual({
      ok: false,
      error: 'Database',
      message: 'judicial read failed; quote the requestId to report it',
      requestId: expect.any(String) as unknown,
    });
    expect(res.body).not.toMatch(/SELECT|secret|listIssuingBodies|cause/u);
  });

  it('a thrown handler fault is the same sanitized envelope (no framework body)', async () => {
    const repos = makeRepos({
      decisions: {
        ...makeRepos().decisions,
        listIssuingBodies: vi.fn(async () => {
          throw new Error('boom SELECT secret');
        }),
      },
    });
    const res = await get(repos, '/issuing-bodies');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ ok: false, error: 'Database' });
    expect(res.body).not.toMatch(/boom|secret/u);
  });

  it('serializes stored JSON values, text IDs and exceptional native spellings unchanged', async () => {
    const repos = makeRepos({
      decisions: {
        ...makeRepos().decisions,
        getById: vi.fn(async () => ok(DECISION)),
        listSubjectLinks: vi.fn(async () =>
          ok({ items: [{ node: LINK, cursor: 'C1' }], next: 'C1' })
        ),
      },
    });
    const detail = await get(repos, '/decisions/9223372036854775807');
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({
      ok: true,
      data: DECISION,
      requestId: expect.any(String) as unknown,
    });
    // The high id and the decimal amount keep their exact spelling in the BODY.
    expect(detail.body).toContain('"decisionId":"9223372036854775807"');
    expect(detail.body).toContain('"total_amount_eur":"9007199254740993.0100"');
    const links = await get(repos, '/decisions/9223372036854775807/subject-links');
    expect(links.json()).toEqual({
      ok: true,
      data: [LINK],
      requestId: expect.any(String) as unknown,
      meta: { cursor: { next: 'C1' } },
    });
    expect(links.body).toContain('"evidence":null');
    expect(links.body).toContain('"linkId":"-9223372036854775808"');
  });

  it('stored JSON arrays and scalars are not coerced to objects', async () => {
    for (const attrs of [[1, 'x'], 'scalar', 42, true, null]) {
      const repos = makeRepos({
        decisions: {
          ...makeRepos().decisions,
          getById: vi.fn(async () => ok({ ...DECISION, attrs })),
        },
      });
      const local = fastifyLib({ logger: false });
      await local.register(makeJudicialRestPlugin({ repos }), { prefix: PREFIX });
      const res = await local.inject({ method: 'GET', url: `${PREFIX}/decisions/1` });
      expect(res.json<{ data: { attrs: unknown } }>().data.attrs).toEqual(attrs);
      await local.close();
    }
  });

  it('the nullable lineage target serializes as null', async () => {
    const edge = {
      lineageCandidateId: '9',
      fromCaseId: '100',
      toCaseId: null,
      lineageType: 'appeal',
      method: 'm',
      confidenceScore: null,
      validationStatus: 'candidate',
    };
    const repos = makeRepos({ lineage: { lineageForCase: vi.fn(async () => ok([edge])) } });
    const res = await get(repos, '/cases/100/lineage');
    expect(res.json()).toEqual({
      ok: true,
      data: [edge],
      requestId: expect.any(String) as unknown,
    });
    const bad = await get(repos, '/cases/-1/lineage');
    expect(bad.statusCode).toBe(400);
  });
});

// ── the composed production app, no database (pre-SQL rejections only) ─────────

describe('judicial surfaces in the composed redesign app under the production formatter', () => {
  const MCP_HEADERS = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };

  const bootProduction = async (): Promise<FastifyInstance> => {
    const saved = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const built = await buildRedesignApp({
        logLevel: 'silent',
        modules: ['legal', 'judicial'],
        procurementWarmCache: false,
        kernelConfig: {
          prodDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
          meiliHost: '',
          meiliApiKey: '',
          opensearchUrl: '',
        },
      });
      await built.app.ready();
      return built.app;
    } finally {
      if (saved === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = saved;
    }
  };

  const mcpCall = (a: FastifyInstance, id: number, name: string, args: unknown, ip: string) =>
    a.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      remoteAddress: ip,
      headers: MCP_HEADERS,
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });

  it('REST, HTTP GraphQL and /api/v1/mcp reject a malformed decision id with the typed error before SQL', async () => {
    app = await bootProduction();
    const r = await app.inject({ method: 'GET', url: `${PREFIX}/decisions/01` });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ ok: false, error: 'InvalidInput', field: 'decisionId' });
    const g = await app.inject({
      method: 'POST',
      url: '/api/v1/graphql',
      payload: { query: '{ judicialDecision(decisionId: "01") { decisionId } }' },
    });
    const gBody = g.json<{ data: unknown; errors?: { extensions?: { code?: string } }[] }>();
    expect(gBody.data).toEqual({ judicialDecision: null });
    expect(gBody.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
    const m = await mcpCall(app, 1, 'get_judicial_decision', { decisionId: '01' }, '10.9.0.1');
    expect(m.statusCode).toBe(200);
    const mBody = m.json<{ result?: { structuredContent?: unknown; isError?: boolean } }>();
    expect(mBody.result?.isError).toBe(true);
    expect(mBody.result?.structuredContent).toMatchObject({
      ok: false,
      errorType: 'InvalidInput',
      errorCode: 'INVALID_INPUT',
    });
  }, 120_000);

  it('strict MCP input refuses an unknown key over the real tools/call transport', async () => {
    app = await bootProduction();
    const m = await mcpCall(
      app,
      2,
      'list_judicial_decisions',
      { sourceSystem: 'x', bogus: 1 },
      '10.9.0.2'
    );
    expect(m.json()).toMatchObject({ result: { isError: true } });
    expect(m.body).toContain('MCP error -32602');
    expect(m.body).toContain('Unrecognized key');
  }, 120_000);
});
