/**
 * Direct acquisitions release 1 over the REAL GraphQL slice, REST plugin and
 * MCP dispatcher, all over one in-memory repository that hands the core every
 * supplier's real name (tests/fixtures/procurement/da-release.ts).
 *
 * The D6 test fails if ANY surface serves a name (or code) for a supplier that
 * is not a company with a valid fiscal code: every such name in the fixture
 * starts with SECRET, and every response body of every read on every surface is
 * searched for it. The same holds before `supplier_kind` exists, for the
 * suppliers the contract's fallback withholds. With the release disabled the
 * SDL still builds, `procurementDaRelease.enabled` is false, data reads answer
 * SERVICE_UNAVAILABLE / 503, and no MCP tool is registered.
 */
import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import {
  makeDaTotalsCache,
  type DaReleaseDeps,
} from '@/modules/procurement/core/da-release-usecases.js';
import {
  daReleaseTypeDefs,
  makeDaReleaseResolvers,
} from '@/modules/procurement/shell/graphql/da-release-schema.js';
import { makeDaReleaseMcpTools } from '@/modules/procurement/shell/mcp/da-release-tools.js';
import { makeDaReleaseRestPlugin } from '@/modules/procurement/shell/rest/da-release-routes.js';
import {
  baseTypeDefs,
  createMcpHttpDispatcher,
  mergeGraphqlSlices,
  scalarResolvers,
} from '@/modules/shared/index.js';
import { createKernelMcpServer } from '@/modules/shared/shell/mcp/server.js';

import {
  BAD_CODE_SUPPLIER,
  COMPANY,
  DATA_AS_OF,
  NATURAL_PERSON,
  PURCHASES,
  SECRET,
  SOLE_TRADER,
  UNVERIFIED,
  makeFakeDaRepo,
  type FakeDaRepoOptions,
} from '../../fixtures/procurement/da-release.js';

const PARTY = 'displayKind partyId name fiscalCode';
const PURCHASE = `purchaseId nativeId code sourceUrl outcome stateLabel publicationDay finalizationDay
  buyerDecisionAt supplierDecisionAt reportedValue counted countedValue
  notCountedReason { code labelEn labelRo } valueCorrected correctedValue
  reviewRule { rule effect descriptionEn descriptionRo } symbolicPrice listedNow title titleWithheld description descriptionWithheld
  categoryCode categoryLabel cpvDivision acquisitionTypeLabel buyer { ${PARTY} } supplier { ${PARTY} }`;
const ITEM =
  'itemIndex name nameWithheld unit quantity requestedQuantity unitPrice cataloguePrice reportedLineValue supplierRejected quantityCorrection';
const TOTALS = 'countedValue countedCount symbolicPriceCount purchaseCount';

interface Surfaces {
  readonly app: FastifyInstance;
  readonly deps: DaReleaseDeps;
}

const build = async (options: FakeDaRepoOptions): Promise<Surfaces> => {
  const deps: DaReleaseDeps = { repo: makeFakeDaRepo(options), totalsCache: makeDaTotalsCache() };
  const { typeDefs } = mergeGraphqlSlices(baseTypeDefs, [
    { source: 'procurement', typeDefs: daReleaseTypeDefs },
  ]);
  const app = fastifyLib({ logger: false });
  await app.register(
    makeGraphQLPlugin({
      schema: [typeDefs],
      resolvers: [{ ...scalarResolvers, ...makeDaReleaseResolvers(deps) }],
      isProduction: false,
      enableGraphiQL: false,
    })
  );
  await app.register(makeDaReleaseRestPlugin(deps), { prefix: '/api/v1/procurement/da' });
  await app.ready();
  return { app, deps };
};

interface GqlResponse {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly {
    readonly message: string;
    readonly extensions?: Record<string, unknown>;
  }[];
}

const gql = async (s: Surfaces, query: string, variables: Record<string, unknown> = {}) => {
  const res = await s.app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  return { raw: res.body, body: res.json<GqlResponse>() };
};

const rest = async (s: Surfaces, url: string) => {
  const res = await s.app.inject({ method: 'GET', url: `/api/v1/procurement/da${url}` });
  return { status: res.statusCode, raw: res.body, body: res.json<Record<string, unknown>>() };
};

const callTool = async (deps: DaReleaseDeps, name: string, args: Record<string, unknown>) => {
  const dispatcher = createMcpHttpDispatcher(() =>
    createKernelMcpServer(makeDaReleaseMcpTools(deps))
  );
  const response = (await dispatcher.dispatch({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as { result?: { structuredContent?: Record<string, unknown>; content?: unknown } };
  await dispatcher.close();
  const content = response.result?.structuredContent;
  if (content === undefined) throw new Error(`no structured content from ${name}`);
  return { raw: JSON.stringify(response), content };
};

/** Every read on every surface, as raw response text. */
const everyResponse = async (s: Surfaces): Promise<readonly [string, string][]> => {
  const out: [string, string][] = [];
  const push = (label: string, raw: string) => out.push([label, raw]);
  const all = { page: 1, pageSize: 100 };
  push(
    'gql list',
    (await gql(s, `{ procurementDaPurchases(pageSize: 100) { items { ${PURCHASE} } total } }`)).raw
  );
  for (const purchase of PURCHASES) {
    push(
      `gql detail ${purchase.purchaseId}`,
      (
        await gql(
          s,
          `query($id: ID!) { procurementDaPurchase(purchaseId: $id) { purchase { ${PURCHASE} } items { ${ITEM} } } }`,
          { id: purchase.purchaseId }
        )
      ).raw
    );
    push(
      `rest detail ${purchase.purchaseId}`,
      (await rest(s, `/purchases/lookup?purchaseId=${purchase.purchaseId}`)).raw
    );
    push(
      `mcp detail ${purchase.purchaseId}`,
      (await callTool(s.deps, 'get_procurement_da_purchase', { purchaseId: purchase.purchaseId }))
        .raw
    );
  }
  for (const groupBy of ['buyer', 'supplier', 'cpvDivision', 'month', 'year', null]) {
    const arg = groupBy === null ? '' : `, groupBy: ${groupBy}`;
    push(
      `gql totals ${String(groupBy)}`,
      (
        await gql(
          s,
          `{ procurementDaTotals(pageSize: 100${arg}) { overall { ${TOTALS} } groups { key noSupplier party { ${PARTY} } ${TOTALS} } } }`
        )
      ).raw
    );
    push(
      `rest totals ${String(groupBy)}`,
      (await rest(s, `/totals?pageSize=100${groupBy === null ? '' : `&groupBy=${groupBy}`}`)).raw
    );
    push(
      `mcp totals ${String(groupBy)}`,
      (
        await callTool(s.deps, 'aggregate_procurement_da_totals', {
          ...all,
          ...(groupBy === null ? {} : { groupBy }),
        })
      ).raw
    );
  }
  push('rest list', (await rest(s, '/purchases?pageSize=100')).raw);
  push('mcp list', (await callTool(s.deps, 'list_procurement_da_purchases', all)).raw);
  // Probing withheld suppliers by code must not reveal anything either.
  for (const party of [SOLE_TRADER, NATURAL_PERSON, UNVERIFIED, BAD_CODE_SUPPLIER]) {
    const code = party.fiscalCode ?? '';
    if (!/^[0-9]{1,10}$/u.test(code)) continue;
    push(
      `gql probe ${code}`,
      (
        await gql(
          s,
          `query($c: String) { procurementDaPurchases(filter: { supplierFiscalCode: $c }) { items { ${PURCHASE} } total } }`,
          { c: code }
        )
      ).raw
    );
    push(`rest probe ${code}`, (await rest(s, `/purchases?supplierFiscalCode=${code}`)).raw);
    push(
      `mcp probe ${code}`,
      (await callTool(s.deps, 'list_procurement_da_purchases', { supplierFiscalCode: code })).raw
    );
  }
  return out;
};

describe('D6 on every surface', () => {
  let surfaces: Surfaces;
  beforeAll(async () => {
    surfaces = await build({ supplierKindColumn: true });
  });
  afterAll(async () => {
    await surfaces.app.close();
  });

  it('no surface serves a name or code for a supplier that is not a company with a valid code', async () => {
    const withheld = [SOLE_TRADER, NATURAL_PERSON, UNVERIFIED, BAD_CODE_SUPPLIER];
    const responses = await everyResponse(surfaces);
    expect(responses.length).toBeGreaterThan(40);
    for (const [label, raw] of responses) {
      expect(raw, label).not.toContain(SECRET);
      for (const party of withheld) {
        // Probes included: no surface echoes a supplier code back.
        expect(raw, label).not.toContain(`"${party.fiscalCode ?? ''}"`);
        expect(raw, label).not.toContain(`"${party.portalPartyId}"`);
      }
    }
    // ...while a company is named.
    expect(responses.some(([, raw]) => raw.includes(COMPANY.name ?? '~'))).toBe(true);
  });

  it('serves withheld suppliers as natural_person with every identifying field null', async () => {
    const { body } = await gql(
      surfaces,
      `{ procurementDaPurchases(pageSize: 100) { items { code supplier { ${PARTY} } } } }`
    );
    const items = (
      body.data?.['procurementDaPurchases'] as {
        items: { supplier: Record<string, unknown> | null }[];
      }
    ).items;
    const kinds = new Set(items.map((item) => item.supplier?.['displayKind'] ?? 'none'));
    expect(kinds).toEqual(new Set(['company', 'natural_person', 'none']));
    for (const item of items.filter((i) => i.supplier?.['displayKind'] === 'natural_person'))
      expect(item.supplier).toEqual({
        displayKind: 'natural_person',
        partyId: null,
        name: null,
        fiscalCode: null,
      });
  });
});

describe('free-text privacy gate', () => {
  let surfaces: Surfaces;
  beforeAll(async () => {
    surfaces = await build({});
  });
  afterAll(async () => {
    await surfaces.app.close();
  });

  it('serves title, description and line names only when marked public, else null with a marker', async () => {
    const { body, raw } = await gql(
      surfaces,
      `query($id: ID!) { procurementDaPurchase(purchaseId: $id) { purchase { title titleWithheld description descriptionWithheld categoryLabel } items { name nameWithheld } } }`,
      { id: PURCHASES[1]?.purchaseId ?? '' }
    );
    expect(raw).not.toContain(SECRET);
    expect(body.data?.['procurementDaPurchase']).toEqual({
      purchase: {
        title: null,
        titleWithheld: 'privacy',
        description: null,
        descriptionWithheld: 'privacy',
        categoryLabel: 'Materiale de constructii',
      },
      items: [
        { name: 'Beton refractar', nameWithheld: null },
        { name: null, nameWithheld: 'privacy' },
      ],
    });
    const open = await gql(
      surfaces,
      `query($id: ID!) { procurementDaPurchase(purchaseId: $id) { purchase { title titleWithheld } } }`,
      { id: PURCHASES[0]?.purchaseId ?? '' }
    );
    expect(open.body.data?.['procurementDaPurchase']).toEqual({
      purchase: { title: 'Public title 1', titleWithheld: null },
    });
  });
});

describe('D6 before supplier_kind exists', () => {
  let surfaces: Surfaces;
  beforeAll(async () => {
    surfaces = await build({ supplierKindColumn: false });
  });
  afterAll(async () => {
    await surfaces.app.close();
  });

  it('withholds every supplier without a valid code on every surface', async () => {
    const responses = await everyResponse(surfaces);
    for (const [label, raw] of responses) {
      for (const party of [NATURAL_PERSON, BAD_CODE_SUPPLIER]) {
        expect(raw, label).not.toContain(party.name ?? '~');
        expect(raw, label).not.toContain(`"${party.portalPartyId}"`);
      }
    }
  });
});

describe('parity and envelope', () => {
  let surfaces: Surfaces;
  beforeAll(async () => {
    surfaces = await build({});
  });
  afterAll(async () => {
    await surfaces.app.close();
  });

  it('serves the same purchase on GraphQL, REST and MCP, with dataAsOf', async () => {
    const id = PURCHASES[1]?.purchaseId ?? '';
    const g = await gql(
      surfaces,
      `query($id: ID!) { procurementDaPurchase(purchaseId: $id) { purchase { ${PURCHASE} } items { ${ITEM} } dataAsOf countedValueBasis } }`,
      { id }
    );
    expect(g.body.errors, g.raw).toBeUndefined();
    const fromGql = g.body.data?.['procurementDaPurchase'] as Record<string, unknown>;
    const r = await rest(surfaces, `/purchases/lookup?purchaseId=${id}`);
    expect(r.status).toBe(200);
    const m = await callTool(surfaces.deps, 'get_procurement_da_purchase', { purchaseId: id });
    expect((r.body['data'] as Record<string, unknown>)['purchase']).toEqual(fromGql['purchase']);
    expect((m.content['item'] as Record<string, unknown>)['purchase']).toEqual(fromGql['purchase']);
    expect(fromGql['dataAsOf']).toBe(DATA_AS_OF);
    expect((r.body['meta'] as Record<string, unknown>)['dataAsOf']).toBe(DATA_AS_OF);
    expect(fromGql['purchase']).toMatchObject({
      reportedValue: '3150000.00',
      countedValue: '3150.00',
      valueCorrected: true,
      reviewRule: { rule: 'quantity_unit_mix', effect: 'correct' },
    });
  });

  it('serves the same totals on all three surfaces', async () => {
    const g = await gql(
      surfaces,
      `{ procurementDaTotals(groupBy: month, pageSize: 100) { overall { ${TOTALS} } groups { key ${TOTALS} } groupCount } }`
    );
    const r = await rest(surfaces, '/totals?groupBy=month&pageSize=100');
    const m = await callTool(surfaces.deps, 'aggregate_procurement_da_totals', {
      groupBy: 'month',
      pageSize: 100,
    });
    const fromGql = g.body.data?.['procurementDaTotals'] as Record<string, unknown>;
    expect((r.body['data'] as Record<string, unknown>)['overall']).toEqual(fromGql['overall']);
    expect((m.content['item'] as Record<string, unknown>)['overall']).toEqual(fromGql['overall']);
  });

  it('maps input errors to INVALID_INPUT / 400 and refuses unknown REST parameters', async () => {
    const g = await gql(
      surfaces,
      `{ procurementDaPurchases(filter: { cpvDivision: "4" }) { total } }`
    );
    expect(g.body.errors?.[0]?.extensions?.['code']).toBe('INVALID_INPUT');
    expect((await rest(surfaces, '/purchases?cpvDivision=4')).status).toBe(400);
    expect((await rest(surfaces, '/purchases?supplierName=x')).status).toBe(400);
    expect((await rest(surfaces, '/purchases?counted=yes')).status).toBe(400);
    expect((await rest(surfaces, `/purchases/lookup?purchaseId=${'f'.repeat(64)}`)).status).toBe(
      404
    );
  });
});

describe('disabled', () => {
  let surfaces: Surfaces;
  beforeAll(async () => {
    surfaces = await build({ enabled: false });
  });
  afterAll(async () => {
    await surfaces.app.close();
  });

  it('serves the SDL, reports enabled=false and refuses data reads', async () => {
    const status = await gql(surfaces, '{ procurementDaRelease { enabled dataAsOf } }');
    expect(status.body.data?.['procurementDaRelease']).toEqual({ enabled: false, dataAsOf: null });
    const list = await gql(surfaces, '{ procurementDaPurchases { total } }');
    expect(list.body.errors?.[0]?.extensions?.['code']).toBe('SERVICE_UNAVAILABLE');
    const r = await rest(surfaces, '/purchases');
    expect(r.status).toBe(503);
    expect(r.body['error']).toBe('ServiceUnavailable');
    expect((await rest(surfaces, '/status')).body['data']).toEqual({
      enabled: false,
      dataAsOf: null,
    });
  });
});
