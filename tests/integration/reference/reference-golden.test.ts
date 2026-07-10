/**
 * Reference golden + tri-surface tests against LIVE transparenta_prod (read-only).
 *
 * Pinned to the verified 2026-06-17 reference snapshot:
 *   - core.public_entities 15,002 (UAT 3,213; parent1_cui not null 11,695)
 *   - CUI 4305857 = MUNICIPIUL CLUJ-NAPOCA (uat, siruta 54975, region Nord-Vest, 85 children)
 *   - entity_type buckets: 14 total; education 6,723; uat 3,213; public_entity 2,067; health 629
 *   - Nord-Vest public entities 1,946
 *   - core.territories 3,228 (42 counties, 8 regions)
 *   - core.classification_codes 3,111 (caen_rev2 1,675; caen_rev1 785; caen_rev3 651)
 *
 * Tri-surface: the GraphQL `referencePublicEntity` == the MCP `get_reference_public_entity`
 * item == `Entity.reference` (contributor parity). field_trace is null by default and
 * NEVER appears in MCP. Skips cleanly when PROD_DATABASE_URL is absent (CI without tunnel).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { loadRedesignConfig } from '@/infra/config/redesign-env.js';

import type { FastifyInstance } from 'fastify';

const HAS_DB = (process.env['PROD_DATABASE_URL'] ?? '').length > 0;
const CLUJ_CUI = '4305857';
const CLUJ_SIRUTA = '54975';

const d = HAS_DB ? describe : describe.skip;

let app: FastifyInstance;
let close: () => Promise<void>;

/** Swallow ONLY the benign stateless-MCP transport teardown error (kernel race). */
const onUncaught = (err: unknown): void => {
  if (err instanceof Error && err.message.includes('destroySoon')) return;
  throw err;
};

const gql = async (
  query: string,
  variables?: Record<string, unknown>
): Promise<{ data?: unknown; errors?: unknown }> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  return res.json();
};

const mcpCall = async (
  name: string,
  args: Record<string, unknown>
): Promise<{ raw: string; out: Record<string, unknown> }> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  // eslint-disable-next-line no-restricted-syntax -- test parses a trusted MCP JSON-RPC response body
  const body = JSON.parse(res.body) as {
    result?: { structuredContent?: unknown; content?: { text?: string }[] };
  };
  const structured = body.result?.structuredContent;
  if (structured !== undefined)
    return { raw: JSON.stringify(structured), out: structured as Record<string, unknown> };
  const text = body.result?.content?.[0]?.text ?? '{}';
  // eslint-disable-next-line no-restricted-syntax -- test parses the trusted MCP tool-output text payload
  return { raw: text, out: JSON.parse(text) as Record<string, unknown> };
};

interface PeNode {
  cui: string;
  name: string;
  entityType: string | null;
  isUat: boolean;
  defaultReportType: string | null;
  territory: {
    territorialSirutaCode: string | null;
    countyName: string | null;
    region: string | null;
    population: number | null;
  } | null;
  fieldTrace: unknown;
}

d('Reference golden (live prod)', () => {
  beforeAll(async () => {
    const config = loadRedesignConfig(process.env);
    const built = await buildRedesignApp({
      kernelConfig: config.kernel,
      logLevel: 'silent',
      modules: ['reference'],
    });
    app = built.app;
    close = built.app.close.bind(built.app);
    await app.ready();
    // The stateless-MCP transport (SDK hono server) schedules a delayed forceClose
    // after each request; once the socket is gone it throws `destroySoon is not a
    // function` — a KERNEL transport teardown race, not a module defect. Swallow
    // only that exact benign post-response error so the file reports clean.
    process.on('uncaughtException', onUncaught);
  }, 60_000);

  afterAll(async () => {
    await close?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('uncaughtException', onUncaught);
  });

  it('public-entity detail (golden) — territory enrichment + field_trace gated off', async () => {
    const res = await gql(
      `query($cui: CUI!){ referencePublicEntity(cui:$cui){ cui name entityType isUat defaultReportType territory{ territorialSirutaCode countyName region population } fieldTrace } }`,
      { cui: CLUJ_CUI }
    );
    expect(res.errors).toBeUndefined();
    const e = (res.data as { referencePublicEntity: PeNode }).referencePublicEntity;
    expect(e.cui).toBe(CLUJ_CUI);
    expect(e.name).toContain('CLUJ-NAPOCA');
    expect(e.entityType).toBe('uat');
    expect(e.isUat).toBe(true);
    expect(e.territory?.territorialSirutaCode).toBe(CLUJ_SIRUTA);
    expect(e.territory?.region).toBe('Nord-Vest');
    expect(e.fieldTrace).toBeNull(); // gated off by default
  });

  it('includeTrace:true populates field_trace', async () => {
    const res = await gql(
      `query($cui: CUI!){ referencePublicEntity(cui:$cui, includeTrace:true){ fieldTrace } }`,
      { cui: CLUJ_CUI }
    );
    const e = (res.data as { referencePublicEntity: { fieldTrace: unknown } })
      .referencePublicEntity;
    expect(e.fieldTrace).not.toBeNull();
    expect(typeof e.fieldTrace).toBe('object');
  });

  it('list + totalCount + region filter (Nord-Vest = 1,946)', async () => {
    const res = await gql(
      `query{ referencePublicEntities(filter:{ region:{ eq:"Nord-Vest" } }, first:5){ edges{ node{ cui } } totalCount } }`
    );
    const c = (res.data as { referencePublicEntities: { edges: unknown[]; totalCount: number } })
      .referencePublicEntities;
    expect(c.totalCount).toBe(1946);
    expect(c.edges.length).toBe(5);
  });

  it('virtual region keeps empty-in and eq+in intersection semantics', async () => {
    const total = async (filter: string): Promise<number> => {
      const res = await gql(
        `query{ referencePublicEntities(filter:${filter}, first:1){ totalCount } }`
      );
      expect(res.errors).toBeUndefined();
      return (res.data as { referencePublicEntities: { totalCount: number } })
        .referencePublicEntities.totalCount;
    };

    expect(await total('{region:{in:[]}}')).toBe(0);
    expect(await total('{region:{eq:"Nord-Vest", in:["Centru"]}}')).toBe(0);
    expect(await total('{region:{eq:"Nord-Vest", in:["Nord-Vest","Centru"]}}')).toBe(1946);
  });

  it('cursor pagination is keyset-stable (no overlap across pages)', async () => {
    const page1 = await gql(
      `query{ referencePublicEntities(first:10){ edges{ node{ cui } cursor } pageInfo{ endCursor hasNextPage } } }`
    );
    const c1 = (
      page1.data as {
        referencePublicEntities: {
          edges: { node: { cui: string } }[];
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      }
    ).referencePublicEntities;
    expect(c1.pageInfo.hasNextPage).toBe(true);
    const page2 = await gql(
      `query($a:String){ referencePublicEntities(first:10, after:$a){ edges{ node{ cui } } } }`,
      { a: c1.pageInfo.endCursor }
    );
    const c2 = (page2.data as { referencePublicEntities: { edges: { node: { cui: string } }[] } })
      .referencePublicEntities;
    const set1 = new Set(c1.edges.map((e) => e.node.cui));
    const overlap = c2.edges.filter((e) => set1.has(e.node.cui));
    expect(overlap).toEqual([]);
  });

  it('cursor pagination on a NON-default sort (entity_type) round-trips', async () => {
    // Regression: the resolver's edge-cursor dir MUST match the repo's sort dir for
    // entity_type, else page-2 cursors are rejected as a filter/sort mismatch.
    const p1 = await gql(
      `query{ referencePublicEntities(first:5, sort: entity_type){ edges{ node{ cui } } pageInfo{ endCursor hasNextPage } } }`
    );
    const c1 = (
      p1.data as {
        referencePublicEntities: {
          edges: { node: { cui: string } }[];
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      }
    ).referencePublicEntities;
    expect(c1.pageInfo.hasNextPage).toBe(true);
    const p2 = await gql(
      `query($a:String){ referencePublicEntities(first:5, sort: entity_type, after:$a){ edges{ node{ cui } } } }`,
      { a: c1.pageInfo.endCursor }
    );
    expect(p2.errors).toBeUndefined();
    const c2 = (p2.data as { referencePublicEntities: { edges: { node: { cui: string } }[] } })
      .referencePublicEntities;
    expect(c2.edges.length).toBeGreaterThan(0);
  });

  it('updatedAt serializes as an ISO string (timestamptz ::text cast)', async () => {
    const res = await gql(`query($cui:CUI!){ referencePublicEntity(cui:$cui){ updatedAt } }`, {
      cui: CLUJ_CUI,
    });
    const u = (res.data as { referencePublicEntity: { updatedAt: string } }).referencePublicEntity
      .updatedAt;
    expect(res.errors).toBeUndefined();
    expect(typeof u).toBe('string');
    expect(u).toMatch(/^\d{4}-\d{2}-\d{2}/u);
  });

  it('sort:updated_at paginates without error (the broken-Date-sort regression)', async () => {
    const p1 = await gql(
      `query{ referencePublicEntities(first:5, sort: updated_at){ edges{ node{ cui } } totalCount pageInfo{ endCursor hasNextPage } } }`
    );
    expect(p1.errors).toBeUndefined();
    const c1 = (
      p1.data as {
        referencePublicEntities: {
          totalCount: number;
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      }
    ).referencePublicEntities;
    // totalCount is the FILTERED total (15,002), NOT "remaining after cursor".
    expect(c1.totalCount).toBe(15002);
    const p2 = await gql(
      `query($a:String){ referencePublicEntities(first:5, sort: updated_at, after:$a){ edges{ node{ cui } } totalCount } }`,
      { a: c1.pageInfo.endCursor }
    );
    expect(p2.errors).toBeUndefined();
    // totalCount stays the full denominator on page 2 (review BLOCKER fix).
    expect(
      (p2.data as { referencePublicEntities: { totalCount: number } }).referencePublicEntities
        .totalCount
    ).toBe(15002);
  });

  it('classification resolve scoped to a system does not leak other systems', async () => {
    const m = await mcpCall('resolve_reference_classification', {
      system: 'caen_rev2',
      q: '1',
      limit: 20,
    });
    const items = (m.out['items'] as { kind: string; hint?: string }[]) ?? [];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.hint === 'caen_rev2')).toBe(true);
  });

  it('children tree (golden has 85)', async () => {
    const res = await gql(`query($cui:CUI!){ referencePublicEntityChildren(cui:$cui){ cui } }`, {
      cui: CLUJ_CUI,
    });
    const children = (res.data as { referencePublicEntityChildren: unknown[] })
      .referencePublicEntityChildren;
    expect(children.length).toBe(85);
  });

  it('aggregate by entity_type (education = 6,723; 14 buckets)', async () => {
    const res = await gql(`query{ referencePublicEntityAggregate(by: entity_type){ key count } }`);
    const buckets = (
      res.data as { referencePublicEntityAggregate: { key: string; count: number }[] }
    ).referencePublicEntityAggregate;
    expect(buckets.length).toBe(14);
    expect(buckets.find((b) => b.key === 'education')?.count).toBe(6723);
    expect(buckets.find((b) => b.key === 'uat')?.count).toBe(3213);
  });

  it('territory detail by siruta + counties (42) + regions (8) rollups', async () => {
    const res = await gql(
      `query($s:SIRUTA!){ referenceTerritory(siruta:$s){ name countyName } referenceCounties{ countyCode } referenceRegions{ region uatCount } }`,
      { s: CLUJ_SIRUTA }
    );
    const d2 = res.data as {
      referenceTerritory: { name: string } | null;
      referenceCounties: unknown[];
      referenceRegions: unknown[];
    };
    expect(d2.referenceTerritory?.name).toContain('CLUJ-NAPOCA');
    expect(d2.referenceCounties.length).toBe(42);
    expect(d2.referenceRegions.length).toBe(8);
  });

  it('classification systems + filter (caen_rev2 = 1,675) + code detail round-trip', async () => {
    const sys = await gql(`query{ referenceClassificationSystems{ system count } }`);
    const systems = (
      sys.data as { referenceClassificationSystems: { system: string; count: number }[] }
    ).referenceClassificationSystems;
    expect(systems.find((s) => s.system === 'caen_rev2')?.count).toBe(1675);
    expect(systems.find((s) => s.system === 'caen_rev1')?.count).toBe(785);

    const list = await gql(
      `query{ referenceClassificationCodes(filter:{ system:{ eq:"caen_rev2" } }, first:1){ edges{ node{ system code } } } }`
    );
    const node = (
      list.data as {
        referenceClassificationCodes: { edges: { node: { system: string; code: string } }[] };
      }
    ).referenceClassificationCodes.edges[0]?.node;
    expect(node?.system).toBe('caen_rev2');
    // round-trip: fetch the same code by PK
    const one = await gql(
      `query($s:String!,$c:String!){ referenceClassificationCode(system:$s, code:$c){ system code } }`,
      { s: node?.system, c: node?.code }
    );
    const got = (
      one.data as { referenceClassificationCode: { system: string; code: string } | null }
    ).referenceClassificationCode;
    expect(got?.code).toBe(node?.code);
  });

  it('Entity.reference contributor parity (same card via the registry)', async () => {
    const res = await gql(
      `query($cui:CUI!){ entity(cui:$cui){ cui reference{ cui name isUat entityType } } }`,
      { cui: CLUJ_CUI }
    );
    const ref = (
      res.data as {
        entity: {
          reference: {
            cui: string;
            name: string;
            isUat: boolean;
            entityType: string | null;
          } | null;
        };
      }
    ).entity.reference;
    expect(ref?.cui).toBe(CLUJ_CUI);
    expect(ref?.name).toContain('CLUJ-NAPOCA');
    expect(ref?.isUat).toBe(true);
    expect(ref?.entityType).toBe('uat');
  });

  it('GraphQL ≡ MCP equivalence for the public-entity card (and MCP omits field_trace)', async () => {
    const g = await gql(
      `query($cui:CUI!){ referencePublicEntity(cui:$cui){ cui name entityType isUat } }`,
      { cui: CLUJ_CUI }
    );
    const ge = (g.data as { referencePublicEntity: PeNode }).referencePublicEntity;
    const m = await mcpCall('get_reference_public_entity', { cui: CLUJ_CUI });
    const item = m.out['item'] as
      | { cui: string; name: string; entityType: string | null; isUat: boolean }
      | undefined;
    expect(item?.cui).toBe(ge.cui);
    expect(item?.name).toBe(ge.name);
    expect(item?.entityType).toBe(ge.entityType);
    expect(item?.isUat).toBe(ge.isUat);
    expect(m.raw).not.toContain('field_trace');
  });

  it('MCP resolve — public_entity name → CUI, territory name → SIRUTA', async () => {
    const pe = await mcpCall('resolve_reference_filter', {
      dim: 'public_entity',
      q: 'Cluj-Napoca',
      limit: 5,
    });
    const peItems = pe.out['items'] as { kind: string; value: string }[];
    expect(peItems.some((i) => i.value === CLUJ_CUI)).toBe(true);
    expect(peItems.every((i) => i.kind === 'public_entity')).toBe(true);

    const terr = await mcpCall('resolve_reference_filter', {
      dim: 'territory',
      q: 'Cluj-Napoca',
      limit: 5,
    });
    const terrItems = terr.out['items'] as { kind: string; value: string }[];
    expect(terrItems.some((i) => i.value === CLUJ_SIRUTA)).toBe(true);
  });

  it('field_trace never appears in an MCP list response', async () => {
    const m = await mcpCall('search_reference_public_entities', {
      filter: { isUat: { eq: true } },
      limit: 5,
    });
    expect(m.raw).not.toContain('field_trace');
    expect(m.raw.toLowerCase()).not.toContain('"fieldtrace":{');
    // summary carries the denominator
    expect(String(m.out['summary'])).toContain('15,002');
  });
});
