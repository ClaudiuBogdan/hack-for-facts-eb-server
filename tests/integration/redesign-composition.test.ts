/**
 * Composition coverage for `buildRedesignApp` (review T-09): which modules
 * mount which GraphQL roots, and which modules cannot mount alone. Every
 * boot runs over the bare kernel with the pool pointed at a closed port; only
 * introspection executes.
 *
 * Measured composition units (a unit is the smallest module set that boots):
 *  - singles: pnrr, reference, companies, legal, parliament, procurement,
 *    primarii-transparency;
 *  - `judicial` needs `legal` (its SDL references `LegalAct`), measured as
 *    `['legal', 'judicial']` minus `legal`;
 *  - `ins-native` and `budget` need each other (`ins-native` uses the budget
 *    slice's `PeriodDate` / `ReportPeriodInput`; `budget` requires the INS
 *    population port, review N/N6/N7), measured as one unit.
 *
 * Invariants:
 *  - every unit adds its roots on top of the kernel's, never removes one;
 *  - no root is contributed by two units (a module never forks another's
 *    surface);
 *  - the standalone defaults are exactly the union of the units, so nothing
 *    mounts outside a module and no module is silently dropped;
 *  - the three lone boots fail with their documented reasons.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { BUDGET_GROUPED_ROOTS } from '@/modules/budget/shell/graphql/legacy/grouped-typedefs.js';
import { BUDGET_LEGACY_ROOTS } from '@/modules/budget/shell/graphql/legacy/typedefs.js';
import { INS_LEGACY_ROOTS } from '@/modules/ins-native/index.js';

import type { FastifyInstance } from 'fastify';

type Modules = NonNullable<Parameters<typeof buildRedesignApp>[0]['modules']>;

const SINGLE_MODULES: readonly Modules[number][] = [
  'pnrr',
  'reference',
  'companies',
  'legal',
  'parliament',
  'procurement',
  'primarii-transparency',
];

const apps: FastifyInstance[] = [];

const boot = (modules: Modules | undefined): ReturnType<typeof buildRedesignApp> =>
  buildRedesignApp({
    logLevel: 'silent',
    ...(modules === undefined ? {} : { modules }),
    procurementWarmCache: false,
    kernelConfig: {
      prodDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
      meiliHost: '',
      meiliApiKey: '',
      opensearchUrl: '',
    },
  });

const queryFields = async (modules: Modules | undefined): Promise<Set<string>> => {
  const built = await boot(modules);
  apps.push(built.app);
  await built.app.ready();
  const res = await built.app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    payload: { query: '{ __type(name: "Query") { fields { name } } }' },
  });
  expect(res.statusCode).toBe(200);
  const data = res.json<{ data: Record<'__type', { fields: { name: string }[] }> }>().data;
  return new Set(data.__type.fields.map((f) => f.name));
};

const minus = (a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> =>
  new Set([...a].filter((x) => !b.has(x)));

describe('redesign app composition: modules and the roots they mount', () => {
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it('mounts every unit on top of the kernel, disjointly, and the defaults are their union', async () => {
    const kernel = await queryFields([]);
    expect(kernel.size).toBeGreaterThan(0);

    const contributed = new Map<string, Set<string>>();
    const measure = async (unit: string, modules: Modules, base: ReadonlySet<string>) => {
      const fields = await queryFields(modules);
      // A unit only adds roots; the kernel's own stay.
      for (const root of kernel)
        expect(fields, `${unit} dropped kernel root ${root}`).toContain(root);
      contributed.set(unit, minus(minus(fields, kernel), base));
    };
    for (const module of SINGLE_MODULES) await measure(module, [module], new Set());
    await measure('judicial', ['legal', 'judicial'], contributed.get('legal') ?? new Set());
    await measure('ins-native+budget', ['ins-native', 'budget'], new Set());

    // No root is served by two units.
    const owners = new Map<string, string>();
    for (const [unit, roots] of contributed) {
      for (const root of roots) {
        expect(
          owners.get(root),
          `root ${root} mounted by ${owners.get(root) ?? ''} and ${unit}`
        ).toBeUndefined();
        owners.set(root, unit);
      }
    }

    // The standalone defaults mount exactly the union of the units' roots.
    const defaults = await queryFields(undefined);
    const union = new Set([...kernel, ...owners.keys()]);
    expect([...minus(defaults, union)].sort(), 'roots on the defaults but in no unit').toEqual([]);
    expect([...minus(union, defaults)].sort(), 'unit roots missing from the defaults').toEqual([]);

    // The legacy client roots live where design 13 says they do.
    const native = contributed.get('ins-native+budget') ?? new Set<string>();
    for (const root of [...BUDGET_LEGACY_ROOTS, ...BUDGET_GROUPED_ROOTS, ...INS_LEGACY_ROOTS]) {
      expect(native, `legacy root ${root} is not on the budget/INS unit`).toContain(root);
    }
    expect(contributed.get('judicial')?.size ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it.each([
    {
      modules: ['budget'] as const,
      reason: "module 'budget' requires 'ins-native' on the kernel build",
    },
    { modules: ['ins-native'] as const, reason: 'Unknown type "PeriodDate"' },
    { modules: ['judicial'] as const, reason: 'Unknown type "LegalAct"' },
  ])(
    'refuses $modules alone: $reason',
    async ({ modules, reason }) => {
      await expect(boot([...modules])).rejects.toThrow(reason);
    },
    60_000
  );
});
