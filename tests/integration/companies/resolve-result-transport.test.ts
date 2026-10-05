/**
 * Companies — `companyResolveResult` (and the legacy `companyResolve` array)
 * through the REGISTERED production composition (`buildRedesignApp`: kernel
 * schema + the companies slice and resolvers + Mercurius with the shared
 * error formatter, the per-request owning-result guard and its
 * `onResolution` finalizer), and the `resolve_company_filter` MCP tool over
 * the same in-memory world (no DB).
 *
 * The world is the current registry scope, the parents that are no longer
 * public, and the repository answers; an unrelated `health` root can be held
 * pending while the world changes. Each negative asserts the COMPLETED
 * payload: a resolve answer whose CUIs or scope no longer hold when the
 * operation completed is withheld with one SERVICE_UNAVAILABLE at its path.
 */

import { ok } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import {
  REGISTRY_MOVED_MESSAGE,
  type CompanyRegistryEnvelope,
} from '@/modules/companies/core/registry.js';
import {
  RESOLVE_SCOPE_CHANGED_MESSAGE,
  RESOLVE_SCOPE_MALFORMED_MESSAGE,
  RESOLVE_SCOPE_NOT_APPLICABLE_MESSAGE,
} from '@/modules/companies/core/usecases.js';
import { makeCompaniesResolvers } from '@/modules/companies/shell/graphql/resolvers.js';
import { companiesTypeDefs } from '@/modules/companies/shell/graphql/typedefs.js';
import { makeCompaniesMcpTools } from '@/modules/companies/shell/mcp/tools.js';
import { createContributorRegistry } from '@/modules/shared/index.js';

import {
  NEXT_EDITION_SCOPE,
  PUBLISHED_SCOPE,
  recheckOf,
} from '../../unit/companies/registry-fixtures.js';
import { stubFlows, stubRepo } from '../../unit/companies/repo-fixtures.js';

import type { CaenCodeHit, CompanyNameHit } from '@/modules/companies/core/types.js';
import type { KernelMcpTool } from '@/modules/shared/shell/mcp/types.js';
import type { FastifyInstance } from 'fastify';

const PUBLISHED_KEY = 'onrc:published:7:3:11';
const NEXT_KEY = 'onrc:published:8:4:12';
/** Synthetic edition-qualified names: their absence from a withheld payload is the assertion. */
const ACME_ONRC = 'EARLIER_ACME_QUALIFIED_NAME';
const BETA_ONRC = 'EARLIER_BETA_QUALIFIED_NAME';
const DIRECTORY = 'PUBLIC DIRECTORY NAME SA';

const KERNEL_CONFIG = {
  prodDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
  meiliHost: '',
  meiliApiKey: '',
  opensearchUrl: '',
};

interface Gate {
  readonly reached: Promise<void>;
  readonly opened: Promise<void>;
  enter(): void;
  open(): void;
}

const gate = (): Gate => {
  let enter: () => void = () => undefined;
  let open: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    reached,
    opened,
    enter: () => {
      enter();
    },
    open: () => {
      open();
    },
  };
};

const CAEN_ROWS: readonly CaenCodeHit[] = [
  { code: '1111', rev: 'rev0', key: 'rev0:1111', label: 'REV0 CATALOG LABEL' },
  { code: '1111', rev: 'rev2', key: 'rev2:1111', label: 'REV2 CATALOG LABEL' },
  { code: '1111', rev: 'rev3', key: 'rev3:1111', label: null },
];

const makeWorld = () => {
  const state: {
    current: CompanyRegistryEnvelope;
    privateCuis: Set<string>;
    names: boolean;
    degraded: boolean;
  } = {
    current: PUBLISHED_SCOPE,
    /** Parents no longer public (the recheck reports them). */
    privateCuis: new Set<string>(),
    names: true,
    degraded: false,
  };
  const holds: { health?: Gate } = {};
  const events: string[] = [];
  /** Labels as the repository attributes them under `scope`. */
  const namesUnder = (scope: CompanyRegistryEnvelope): CompanyNameHit[] => {
    const edition = scope.state === 'published';
    return [
      {
        dim: 'name',
        value: '2816464',
        label: edition ? ACME_ONRC : 'ACME CORE',
        cui: '2816464',
        confidence: 0.75,
        labelSource: edition ? 'onrc_edition' : 'core_organization',
      },
      {
        dim: 'name',
        value: '14918042',
        label: DIRECTORY,
        cui: '14918042',
        confidence: 0.5,
        labelSource: 'core_organization',
      },
    ];
  };
  const repo = stubRepo({
    captureRegistryScope: vi.fn(async () => {
      events.push('capture');
      return ok(state.current);
    }),
    confirmRegistryScope: vi.fn(
      async (_scope: CompanyRegistryEnvelope, cuis: readonly string[]) => {
        events.push('recheck');
        return ok(
          recheckOf(
            state.current,
            cuis.filter((c) => state.privateCuis.has(c))
          )
        );
      }
    ),
    resolveByName: vi.fn(
      async (_q: string, _limit: number, _meili: unknown, scope: CompanyRegistryEnvelope) => {
        events.push('name-read');
        const hits = state.names
          ? namesUnder(scope).filter((h) => h.cui === null || !state.privateCuis.has(h.cui))
          : [];
        return ok({ hits, degraded: state.degraded });
      }
    ),
    findByRegistrationNumber: vi.fn(async () => {
      events.push('regnum-read');
      return ok([
        {
          dim: 'regnum' as const,
          value: '9900001',
          label: BETA_ONRC,
          cui: '9900001',
          confidence: null,
          labelSource: 'onrc_edition' as const,
        },
      ]);
    }),
    resolveCaen: vi.fn(async () => {
      events.push('caen-read');
      return ok(CAEN_ROWS);
    }),
    resolveCounty: vi.fn(async () => {
      events.push('county-read');
      return ok(['Cluj']);
    }),
  });
  return { state, holds, events, repo };
};

type World = ReturnType<typeof makeWorld>;

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const buildApp = async (world: World): Promise<FastifyInstance> => {
  const companies = makeCompaniesResolvers({
    repo: world.repo,
    flowsRepo: stubFlows(),
    meili: null,
    registry: createContributorRegistry(),
    hubStats: { get: vi.fn() },
  });
  const { app } = await buildRedesignApp({
    logLevel: 'silent',
    modules: [],
    kernelConfig: KERNEL_CONFIG,
    graphqlSlices: [{ source: 'companies', typeDefs: companiesTypeDefs }],
    graphqlResolvers: {
      ...companies,
      Query: {
        ...(companies['Query'] as Record<string, unknown>),
        // The kernel `health` root with its IO replaced by a gate: an
        // unrelated root that can stay pending.
        health: async () => {
          const held = world.holds.health;
          if (held !== undefined) {
            held.enter();
            await held.opened;
          }
          return { overall: 'fixture' };
        },
      },
    },
  });
  apps.push(app);
  await app.ready();
  return app;
};

const resolveTool = (world: World): KernelMcpTool => {
  const tool = makeCompaniesMcpTools({
    repo: world.repo,
    flowsRepo: stubFlows(),
    meili: null,
    clientBaseUrl: 'https://client.test',
    hubStats: { get: vi.fn() },
  }).find((t) => t.name === 'resolve_company_filter');
  if (tool === undefined) throw new Error('resolve_company_filter is not registered');
  return tool;
};

interface GqlBody {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly {
    readonly message: string;
    readonly path?: readonly (string | number)[];
    readonly extensions?: { readonly code?: string };
  }[];
}

const gql = async (
  app: FastifyInstance,
  query: string
): Promise<{ body: GqlBody; text: string }> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    payload: { query },
  });
  return { body: res.json<GqlBody>(), text: res.body };
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const HIT = 'dim value label cui confidence revision key labelSource';
const RESULT = `hits { ${HIT} } degraded ambiguous scopeKey
  registry { state editionId publicationEpoch accessEpoch scopeKey }`;

const count = (world: World, event: string): number =>
  world.events.filter((e) => e === event).length;

/** Wait until `n` rechecks were taken (the pins completed), then settle microtasks. */
const rechecksTaken = async (world: World, n: number): Promise<void> => {
  await vi.waitFor(() => {
    expect(count(world, 'recheck')).toBe(n);
  });
  await flush();
};

const withheldAt = (path: string, message: string): unknown =>
  expect.objectContaining({
    message,
    path: [path],
    extensions: expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }),
  });

const refusedAt = (path: string, message: string): unknown =>
  expect.objectContaining({
    message,
    path: [path],
    extensions: expect.objectContaining({ code: 'INVALID_INPUT' }),
  });

/** The MCP envelope as GraphQL selects it (state casing and BigInt strings agree). */
const PUBLISHED_ENVELOPE = {
  state: 'PUBLISHED',
  editionId: '7',
  publicationEpoch: '3',
  accessEpoch: '11',
  scopeKey: PUBLISHED_KEY,
};

describe('companyResolveResult: the answer with its scope, on GraphQL and MCP alike', () => {
  it('a stable NAME result carries hits, flags and the pinned scope; the legacy array is the same hits; MCP reports the same metadata', async () => {
    const world = makeWorld();
    const app = await buildApp(world);
    const { body } = await gql(
      app,
      `{
        r: companyResolveResult(dim: NAME, q: "acme") { ${RESULT} }
        legacy: companyResolve(dim: NAME, q: "acme") { ${HIT} }
      }`
    );
    expect(body.errors).toBeUndefined();
    const r = body.data?.['r'] as Record<string, unknown>;
    expect(r).toEqual({
      hits: [
        {
          dim: 'NAME',
          value: '2816464',
          label: ACME_ONRC,
          cui: '2816464',
          confidence: 0.75,
          revision: null,
          key: null,
          labelSource: 'onrc_edition',
        },
        {
          dim: 'NAME',
          value: '14918042',
          label: DIRECTORY,
          cui: '14918042',
          confidence: 0.5,
          revision: null,
          key: null,
          labelSource: 'core_organization',
        },
      ],
      degraded: false,
      ambiguous: true,
      scopeKey: PUBLISHED_KEY,
      registry: PUBLISHED_ENVELOPE,
    });
    expect(body.data?.['legacy']).toEqual(r['hits']);
    // Two roots: each its pin (capture, read, recheck) and one final recheck.
    expect([count(world, 'capture'), count(world, 'name-read'), count(world, 'recheck')]).toEqual([
      2, 2, 4,
    ]);

    const mcp = await resolveTool(world).handler({ dim: 'name', q: 'acme' });
    expect(mcp.ok).toBe(true);
    expect(mcp.items).toEqual(r['hits']);
    expect(mcp.meta).toEqual({
      count: 2,
      degraded: false,
      ambiguous: true,
      registryScope: PUBLISHED_KEY,
      registry: expect.objectContaining(PUBLISHED_ENVELOPE),
    });
  });

  it('zero hits and limit <= 0 are scoped answers on both surfaces (no unscoped shortcut)', async () => {
    const world = makeWorld();
    world.state.names = false;
    const app = await buildApp(world);
    const { body } = await gql(
      app,
      `{
        empty: companyResolveResult(dim: NAME, q: "nothing") { ${RESULT} }
        zero: companyResolveResult(dim: REGNUM, q: "J40/1/2000", limit: 0) { ${RESULT} }
        negative: companyResolveResult(dim: NAME, q: "acme", limit: -2) { ${RESULT} }
      }`
    );
    expect(body.errors).toBeUndefined();
    const scopedEmpty = {
      hits: [],
      degraded: false,
      ambiguous: false,
      scopeKey: PUBLISHED_KEY,
      registry: PUBLISHED_ENVELOPE,
    };
    expect(body.data).toEqual({ empty: scopedEmpty, zero: scopedEmpty, negative: scopedEmpty });
    // limit <= 0 reads nothing but is pinned and rechecked.
    expect(count(world, 'regnum-read')).toBe(0);
    expect(count(world, 'name-read')).toBe(1);
    expect(count(world, 'capture')).toBe(3);

    const mcp = await resolveTool(world).handler({ dim: 'regnum', q: 'J40/1/2000', limit: 0 });
    expect(mcp.items).toEqual([]);
    expect(mcp.meta).toEqual({
      count: 0,
      degraded: false,
      ambiguous: false,
      registryScope: PUBLISHED_KEY,
      registry: expect.objectContaining(PUBLISHED_ENVELOPE),
    });
  });

  it('degraded name resolution is reported apart from a successful zero, on both surfaces', async () => {
    const world = makeWorld();
    world.state.names = false;
    const app = await buildApp(world);
    const healthy = await gql(app, `{ r: companyResolveResult(dim: NAME, q: "x") { ${RESULT} } }`);
    world.state.degraded = true;
    const down = await gql(app, `{ r: companyResolveResult(dim: NAME, q: "x") { ${RESULT} } }`);
    expect(healthy.body.data?.['r']).toMatchObject({ hits: [], degraded: false });
    expect(down.body.data?.['r']).toEqual({
      ...(healthy.body.data?.['r'] as object),
      degraded: true,
    });
    const mcp = await resolveTool(world).handler({ dim: 'name', q: 'x' });
    expect(mcp.meta).toMatchObject({ count: 0, degraded: true, registryScope: PUBLISHED_KEY });
    expect(String(mcp.summary)).toContain('degraded');
  });

  it('a malformed, different or catalog registryScope is refused with INVALID_INPUT before any resolve read, on both surfaces', async () => {
    const world = makeWorld();
    const app = await buildApp(world);
    const { body } = await gql(
      app,
      `{
        m: companyResolveResult(dim: NAME, q: "acme", registryScope: "onrc:unavailable:7:3:11") { scopeKey }
        d: companyResolveResult(dim: REGNUM, q: "J40/1/2000", registryScope: "${NEXT_KEY}") { scopeKey }
        c: companyResolveResult(dim: CAEN, q: "1111", registryScope: "${PUBLISHED_KEY}") { scopeKey }
      }`
    );
    expect(body.data).toEqual({ m: null, d: null, c: null });
    expect(body.errors).toHaveLength(3);
    expect(body.errors).toEqual(
      expect.arrayContaining([
        refusedAt('m', RESOLVE_SCOPE_MALFORMED_MESSAGE),
        refusedAt('d', RESOLVE_SCOPE_CHANGED_MESSAGE),
        refusedAt('c', RESOLVE_SCOPE_NOT_APPLICABLE_MESSAGE),
      ])
    );
    // Only the well-formed NAME/REGNUM key is compared with a capture; nothing is read.
    expect(world.events).toEqual(['capture']);

    const tool = resolveTool(world);
    for (const [args, message] of [
      [{ dim: 'name', q: 'acme', registryScope: '' }, RESOLVE_SCOPE_MALFORMED_MESSAGE],
      [{ dim: 'regnum', q: 'J40/1/2000', registryScope: NEXT_KEY }, RESOLVE_SCOPE_CHANGED_MESSAGE],
      [
        { dim: 'county', q: 'cluj', registryScope: PUBLISHED_KEY },
        RESOLVE_SCOPE_NOT_APPLICABLE_MESSAGE,
      ],
    ] as const) {
      expect(await tool.handler(args)).toEqual({ ok: false, kind: 'resolution', error: message });
    }
    expect(count(world, 'name-read') + count(world, 'regnum-read')).toBe(0);
    expect(count(world, 'county-read')).toBe(0);
  });

  it('the scope the caller holds binds the answer: the same key is served, the next edition is refused', async () => {
    const world = makeWorld();
    const app = await buildApp(world);
    const held = await gql(
      app,
      `{ r: companyResolveResult(dim: REGNUM, q: "J40/1/2000", registryScope: "${PUBLISHED_KEY}") { ${RESULT} } }`
    );
    expect(held.body.errors).toBeUndefined();
    expect(held.body.data?.['r']).toMatchObject({
      hits: [{ cui: '9900001', label: BETA_ONRC, labelSource: 'onrc_edition' }],
      scopeKey: PUBLISHED_KEY,
    });
    world.state.current = NEXT_EDITION_SCOPE;
    const stale = await gql(
      app,
      `{ r: companyResolveResult(dim: REGNUM, q: "J40/1/2000", registryScope: "${PUBLISHED_KEY}") { scopeKey } }`
    );
    expect(stale.body.data).toEqual({ r: null });
    expect(stale.body.errors).toEqual([refusedAt('r', RESOLVE_SCOPE_CHANGED_MESSAGE)]);
    expect(stale.text).not.toContain(BETA_ONRC);
  });

  it('CAEN and COUNTY: catalog hits with their own revision/key/label source, null scope, no pin and no final check', async () => {
    const world = makeWorld();
    world.holds.health = gate();
    const app = await buildApp(world);
    const pending = gql(
      app,
      `{
        c: companyResolveResult(dim: CAEN, q: "1111") { ${RESULT} }
        k: companyResolveResult(dim: COUNTY, q: "cluj") { ${RESULT} }
        h: health { overall }
      }`
    );
    await world.holds.health.reached;
    await flush();
    world.state.current = NEXT_EDITION_SCOPE; // a publication: catalogs are not scoped by it
    world.holds.health.open();
    const { body } = await pending;
    expect(body.errors).toBeUndefined();
    const c = body.data?.['c'] as Record<string, unknown>;
    expect(c).toEqual({
      hits: [
        {
          dim: 'CAEN',
          value: '1111',
          label: 'REV0 CATALOG LABEL',
          cui: null,
          confidence: null,
          revision: 'rev0',
          key: 'rev0:1111',
          labelSource: 'current_db_catalog',
        },
        {
          dim: 'CAEN',
          value: '1111',
          label: 'REV2 CATALOG LABEL',
          cui: null,
          confidence: null,
          revision: 'rev2',
          key: 'rev2:1111',
          labelSource: 'current_db_catalog',
        },
        {
          dim: 'CAEN',
          value: '1111',
          label: 'rev3:1111',
          cui: null,
          confidence: null,
          revision: 'rev3',
          key: 'rev3:1111',
          labelSource: null,
        },
      ],
      degraded: false,
      ambiguous: true,
      scopeKey: null,
      registry: null,
    });
    expect(body.data?.['k']).toMatchObject({ scopeKey: null, registry: null });
    expect(world.events).toEqual(['caen-read', 'county-read']);

    const mcp = await resolveTool(world).handler({ dim: 'caen', q: '1111' });
    expect(mcp.items).toEqual(c['hits']);
    expect(mcp.meta).toEqual({
      count: 3,
      degraded: false,
      ambiguous: true,
      registry: null,
      registryScope: null,
    });
  });
});

describe('a completed resolve answer is decided again when its whole operation settled', () => {
  const resolveBesideHealth = (field: string): string => `{
    r: ${field}
    h: health { overall }
  }`;

  it('stable control: a NAME answer beside a pending root is served after one final recheck', async () => {
    const world = makeWorld();
    world.holds.health = gate();
    const app = await buildApp(world);
    const pending = gql(
      app,
      resolveBesideHealth(`companyResolveResult(dim: NAME, q: "acme") { hits { cui } scopeKey }`)
    );
    await world.holds.health.reached;
    await rechecksTaken(world, 1);
    world.holds.health.open();
    const { body } = await pending;
    expect(body.errors).toBeUndefined();
    expect(body.data?.['r']).toEqual({
      hits: [{ cui: '2816464' }, { cui: '14918042' }],
      scopeKey: PUBLISHED_KEY,
    });
    expect(world.events).toEqual(['capture', 'name-read', 'recheck', 'recheck']);
  });

  it('a returned parent turning private while another root is pending withholds the answer', async () => {
    const world = makeWorld();
    world.holds.health = gate();
    const app = await buildApp(world);
    const pending = gql(
      app,
      resolveBesideHealth(
        `companyResolveResult(dim: NAME, q: "acme") { hits { cui label } scopeKey }`
      )
    );
    await world.holds.health.reached;
    await rechecksTaken(world, 1);
    world.state.privateCuis.add('2816464');
    world.holds.health.open();
    const { body, text } = await pending;
    expect(body.data).toEqual({ r: null, h: { overall: 'fixture' } });
    expect(body.errors).toEqual([withheldAt('r', REGISTRY_MOVED_MESSAGE)]);
    expect(text).not.toContain(ACME_ONRC);
    expect(text).not.toContain(DIRECTORY);
    // Decided, never re-read.
    expect(world.events).toEqual(['capture', 'name-read', 'recheck', 'recheck']);
  });

  it('an EMPTY scoped answer whose scope moved before completion is withheld (its scopeKey is a claim)', async () => {
    const world = makeWorld();
    world.state.names = false;
    world.holds.health = gate();
    const app = await buildApp(world);
    const pending = gql(
      app,
      resolveBesideHealth(`companyResolveResult(dim: NAME, q: "nothing") { hits { cui } scopeKey }`)
    );
    await world.holds.health.reached;
    await rechecksTaken(world, 1);
    world.state.current = NEXT_EDITION_SCOPE;
    world.holds.health.open();
    const { body, text } = await pending;
    expect(body.data).toEqual({ r: null, h: { overall: 'fixture' } });
    expect(body.errors).toEqual([withheldAt('r', REGISTRY_MOVED_MESSAGE)]);
    expect(text).not.toContain(PUBLISHED_KEY);
  });

  it('the legacy array is decided the same way (an access move withholds its REGNUM hits)', async () => {
    const world = makeWorld();
    world.holds.health = gate();
    const app = await buildApp(world);
    const pending = gql(
      app,
      resolveBesideHealth(`companyResolve(dim: REGNUM, q: "J40/1/2000") { cui label }`)
    );
    await world.holds.health.reached;
    await rechecksTaken(world, 1);
    world.state.current = { ...PUBLISHED_SCOPE, accessEpoch: '12' };
    world.holds.health.open();
    const { body, text } = await pending;
    expect(body.data).toEqual({ r: null, h: { overall: 'fixture' } });
    expect(body.errors).toEqual([withheldAt('r', REGISTRY_MOVED_MESSAGE)]);
    expect(text).not.toContain(BETA_ONRC);
  });

  it('independent requests are decided independently', async () => {
    const world = makeWorld();
    world.holds.health = gate();
    const app = await buildApp(world);
    const delayed = gql(
      app,
      resolveBesideHealth(`companyResolveResult(dim: REGNUM, q: "J40/1/2000") { scopeKey }`)
    );
    await world.holds.health.reached;
    await rechecksTaken(world, 1);
    const independent = await gql(
      app,
      `{ r: companyResolveResult(dim: REGNUM, q: "J40/1/2000") { scopeKey } }`
    );
    expect(independent.body).toEqual({ data: { r: { scopeKey: PUBLISHED_KEY } } });
    world.state.current = NEXT_EDITION_SCOPE;
    world.holds.health.open();
    expect((await delayed).body.data).toEqual({ r: null, h: { overall: 'fixture' } });
    const next = await gql(
      app,
      `{ r: companyResolveResult(dim: REGNUM, q: "J40/1/2000") { scopeKey } }`
    );
    expect(next.body).toEqual({ data: { r: { scopeKey: NEXT_KEY } } });
  });
});
