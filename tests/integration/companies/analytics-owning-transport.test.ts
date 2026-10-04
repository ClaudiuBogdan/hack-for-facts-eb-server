/**
 * Companies analytics roots through the REGISTERED production composition
 * (`buildRedesignApp`: kernel schema + the companies/analytics slice +
 * Mercurius with the per-request owning-result guard and its `onResolution`
 * finalizer), over the in-memory engine and a mutable current state.
 *
 * An analytics answer is computed (its own guard read before the engine and
 * after the labels), then an unrelated `health` root stays pending while the
 * privacy epoch or the ONRC source moves. When the operation settles, the
 * answer's release is decided once more: a stale one nulls only that root
 * with ONE INVALID_INPUT carrying `extensions.field: release` (empty answers
 * included); an unconfirmable state is SERVICE_UNAVAILABLE; the unrelated
 * root is unaffected and nothing crosses requests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { makeCompanyAnalysisResolvers } from '@/modules/companies/shell/graphql/analytics-resolvers.js';
import { companyAnalysisTypeDefs } from '@/modules/companies/shell/graphql/analytics-typedefs.js';
import { companiesTypeDefs } from '@/modules/companies/shell/graphql/typedefs.js';

import {
  DATASET,
  analyticsDeps,
  currentPublication,
  fakeLabels,
  fakePrivacy,
  fakeReleases,
  makeInMemoryEngine,
  releaseRow,
} from '../../unit/companies/analytics/analytics-fixtures.js';

import type { FastifyInstance } from 'fastify';

const KERNEL_CONFIG = {
  prodDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
  meiliHost: '',
  meiliApiKey: '',
  opensearchUrl: '',
};

const FIGURE = '9007199254741973.32';

interface Gate {
  readonly reached: Promise<void>;
  enter(): void;
  open(): void;
  readonly opened: Promise<void>;
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

const makeWorld = () => {
  const privacy = fakePrivacy();
  const engine = makeInMemoryEngine(DATASET.companies, DATASET.statements, [7]);
  const releases = fakeReleases(releaseRow(7, DATASET.companies, DATASET.statements), [], privacy);
  const analytics = analyticsDeps(engine, releases, fakeLabels({ '100': 'ALFA SRL' }));
  const holds: { health?: Gate } = {};
  return { privacy, engine, analytics, holds };
};
type World = ReturnType<typeof makeWorld>;

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const buildApp = async (world: World): Promise<FastifyInstance> => {
  const analytics = makeCompanyAnalysisResolvers(world.analytics);
  const { app } = await buildRedesignApp({
    logLevel: 'silent',
    modules: [],
    kernelConfig: KERNEL_CONFIG,
    graphqlSlices: [
      { source: 'companies', typeDefs: `${companiesTypeDefs}\n\n${companyAnalysisTypeDefs}` },
    ],
    graphqlResolvers: {
      Query: {
        ...analytics.Query,
        // The kernel `health` root with its IO replaced by a gate.
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

interface GqlBody {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly {
    readonly message: string;
    readonly path?: readonly (string | number)[];
    readonly extensions?: Record<string, unknown>;
  }[];
}

const gql = async (app: FastifyInstance, query: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/graphql', payload: { query } });
  return { body: res.json<GqlBody>(), text: res.body };
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Wait until the answers' own guard reads (before engine + after labels) were taken. */
const answered = async (world: World, reads: number): Promise<void> => {
  await vi.waitFor(() => {
    expect(world.privacy.reads).toBe(reads);
  });
  await flush();
};

const STATS = `s: companyAnalysisStats(metrics: [TURNOVER]) {
  release { releaseId source { editionId } } companies metrics { sum }
}`;
const RECORDS_EMPTY = `r: companyAnalysisRecords(scope: { cuis: ["999"] }) {
  release { releaseId } totalCount edges { cursor }
}`;

const pendingBeside = async (world: World, roots: string) => {
  world.holds.health = gate();
  const app = await buildApp(world);
  const pending = gql(app, `{ ${roots} h: health { overall } }`);
  await world.holds.health.reached;
  return { app, pending };
};

const staleAt = (path: string, text: string): unknown =>
  expect.objectContaining({
    path: [path],
    message: expect.stringContaining(text) as unknown,
    extensions: expect.objectContaining({
      code: 'INVALID_INPUT',
      type: 'InvalidInput',
      field: 'release',
    }) as unknown,
  });

describe('an analytics answer is decided again when its whole operation settled', () => {
  it('stable control: served, with one more fresh state read at completion', async () => {
    const world = makeWorld();
    const { pending } = await pendingBeside(world, STATS);
    await answered(world, 2);
    world.holds.health?.open();
    const { body } = await pending;
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      s: {
        release: { releaseId: '7', source: { editionId: '42' } },
        companies: '6',
        metrics: [{ sum: FIGURE }],
      },
      h: { overall: 'fixture' },
    });
    // Before the engine, after the labels, and the operation's final decision.
    expect(world.privacy.reads).toBe(3);
  });

  it('a privacy change while a sibling root is pending withholds the computed answer', async () => {
    const world = makeWorld();
    const { pending } = await pendingBeside(world, STATS);
    await answered(world, 2);
    world.privacy.epoch = '1';
    world.holds.health?.open();
    const { body, text } = await pending;
    expect(body.data).toEqual({ s: null, h: { overall: 'fixture' } });
    expect(body.errors).toEqual([staleAt('s', 'release 7 was withdrawn after a privacy change')]);
    expect(text).not.toContain(FIGURE);
  });

  it('an ONRC source event (same epoch) withholds the computed answer', async () => {
    const world = makeWorld();
    const { pending } = await pendingBeside(world, STATS);
    await answered(world, 2);
    world.privacy.onrc = currentPublication({ editionId: '43' });
    world.holds.health?.open();
    const { body, text } = await pending;
    expect(body.data).toEqual({ s: null, h: { overall: 'fixture' } });
    expect(body.errors).toEqual([staleAt('s', 'no longer the published source')]);
    expect(text).not.toContain(FIGURE);
  });

  it('an EMPTY answer (zero records) names a release too: withheld when it went stale', async () => {
    const world = makeWorld();
    const { pending } = await pendingBeside(world, RECORDS_EMPTY);
    await answered(world, 2);
    world.privacy.onrc = currentPublication({ publicationState: 'unavailable' });
    world.holds.health?.open();
    const { body } = await pending;
    expect(body.data).toEqual({ r: null, h: { overall: 'fixture' } });
    expect(body.errors).toEqual([staleAt('r', 'no longer the published source')]);
  });

  it('every analytics root is decided on its own; an unconfirmable state is SERVICE_UNAVAILABLE', async () => {
    const world = makeWorld();
    const { pending } = await pendingBeside(
      world,
      `a: companyAnalysisRelease { release { releaseId } }
       b: companyAnalysisSeries(metric: TURNOVER) { release { releaseId } points { fiscalYear } }`
    );
    await answered(world, 4);
    world.privacy.inRecovery = true;
    world.holds.health?.open();
    const { body } = await pending;
    expect(body.data).toEqual({ a: null, b: null, h: { overall: 'fixture' } });
    expect(body.errors).toHaveLength(2);
    for (const path of ['a', 'b'])
      expect(body.errors).toContainEqual(
        expect.objectContaining({
          path: [path],
          message: 'companies analytics cannot confirm the current privacy state; retry later',
          extensions: expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }) as unknown,
        })
      );
  });

  it('independent requests are decided independently; an unrelated-only query reads no state', async () => {
    const world = makeWorld();
    const app = await buildApp(world);
    const unrelated = await gql(app, '{ h: health { overall } }');
    expect(unrelated.body).toEqual({ data: { h: { overall: 'fixture' } } });
    expect(world.privacy.reads).toBe(0);
    const first = await gql(app, `{ ${STATS} }`);
    expect(first.body.errors).toBeUndefined();
    world.privacy.epoch = '1';
    const second = await gql(app, `{ ${STATS} }`);
    // Refused before any engine work now (the active release is withdrawn).
    expect(second.body.data).toEqual({ s: null });
    expect(second.body.errors?.[0]?.extensions).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
