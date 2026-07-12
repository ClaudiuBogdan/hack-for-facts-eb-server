/**
 * The vendored supported-combinations artifact (design §6.2) — BIDIRECTIONAL
 * parity with `routeAnalysis`:
 *
 *  1. hash pin: the byte-exact scraper copy hashes to `ANALYSIS_MATRIX_SHA256`
 *     (the scraper stamps the same hash into `analysis_generations.matrix_hash`);
 *  2. artifact → server: every `rollup` row routes to the SAME rollup table;
 *     every `rejected`/`bounded_fact_query` row is rejected with a named reason;
 *  3. server → artifact: the server's WHOLE acceptance space — every subset of
 *     the 7 wave-1 scope dims × every shape variant × every grain — must appear
 *     in the artifact as a `rollup` row with the same table. This closure
 *     direction is SKIP-GATED until the regenerated full-closure artifact lands
 *     (the v1 file carries 106 curated rows, not the programmatic closure);
 *  4. implicit-grain routing is exactly the union of the explicit-grain routes.
 *
 * The artifact is TypeBox-validated — never a trusted raw cast.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { ANALYSIS_MATRIX_SHA256, routeAnalysis } from '@/modules/procurement/core/combinations.js';
import {
  ANALYSIS_GRAINS,
  type AnalysisGrain,
  type BreakdownDimension,
} from '@/modules/procurement/core/constants.js';

import type { AnalysisScope } from '@/modules/procurement/core/analysis-scope.js';
import type { AnalysisShape } from '@/modules/procurement/core/policy.js';

// ── load + validate the vendored artifact ───────────────────────────────────────

const ARTIFACT_URL = new URL(
  '../../../src/modules/procurement/core/procurement-analysis-combinations-v1.json',
  import.meta.url
);

const ShapeSchema = Type.Union([
  Type.Literal('stats'),
  Type.Literal('series'),
  Type.Literal('breakdown'),
  Type.Literal('concentration'),
]);

const CombinationSchema = Type.Object({
  grain: Type.Union(ANALYSIS_GRAINS.map((g) => Type.Literal(g))),
  scopeDims: Type.Array(Type.String()),
  shape: ShapeSchema,
  breakdownDim: Type.Optional(Type.String()),
  serving: Type.Object({
    kind: Type.Union([
      Type.Literal('rollup'),
      Type.Literal('rejected'),
      Type.Literal('bounded_fact_query'),
    ]),
    rollup: Type.Optional(Type.String()),
    missingCapability: Type.Optional(Type.String()),
  }),
});

const ArtifactSchema = Type.Object({
  version: Type.String(),
  timeDims: Type.Array(Type.String()),
  combinations: Type.Array(CombinationSchema),
});

const raw = readFileSync(ARTIFACT_URL);
// eslint-disable-next-line no-restricted-syntax -- hash-pinned vendored artifact, TypeBox-validated on the next line
const parsed: unknown = JSON.parse(raw.toString('utf8'));
if (!Value.Check(ArtifactSchema, parsed)) {
  throw new Error('procurement-analysis-combinations-v1.json does not match the artifact schema');
}
const artifact = parsed;

/**
 * The v1 artifact is a curated 106-row matrix; the scraper is regenerating it as
 * the full programmatic closure (several hundred rows). The server→artifact
 * closure assertion (direction 3) stays skipped until that lands — it flips on
 * automatically once the vendored file grows past the curated size.
 */
const ARTIFACT_IS_FULL_CLOSURE = artifact.combinations.length > 150;

describe('vendored matrix artifact', () => {
  it('hashes to the pinned ANALYSIS_MATRIX_SHA256 (byte-exact scraper copy)', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(ANALYSIS_MATRIX_SHA256);
  });

  it('is the v1 artifact with the expected envelope', () => {
    expect(artifact.version).toBe('procurement-analysis-combinations-v1');
    expect(artifact.timeDims).toEqual(['from', 'to', 'year']);
    expect(artifact.combinations.length).toBeGreaterThan(0);
  });
});

// ── shared vocabulary ───────────────────────────────────────────────────────────

/** Representative dim values (routeAnalysis never inspects values, only presence). */
const DIM_VALUES: Readonly<Record<string, string>> = {
  authorityCui: '4267117',
  supplierCui: '11805367',
  cpvDivision: '33',
  cpvCode: '33600000',
  status: 'awarded',
  procedureType: 'licitatie-deschisa',
  buyerRegion: 'Nord-Vest',
  buyerCounty: 'CJ',
  supplierCounty: 'CJ',
  supplierRegion: 'Nord-Vest',
};

/** The artifact keys breakdowns by scope-dim names; the API uses party nouns. */
const ARTIFACT_TO_API_DIM: Readonly<Record<string, BreakdownDimension>> = {
  authorityCui: 'authority',
  supplierCui: 'supplier',
  cpvDivision: 'cpvDivision',
  cpvCode: 'cpvCode',
  status: 'status',
  procedureType: 'procedureType',
  buyerRegion: 'buyerRegion',
};
const API_TO_ARTIFACT_DIM: Readonly<Record<BreakdownDimension, string>> = {
  authority: 'authorityCui',
  supplier: 'supplierCui',
  cpvDivision: 'cpvDivision',
  cpvCode: 'cpvCode',
  status: 'status',
  procedureType: 'procedureType',
  buyerRegion: 'buyerRegion',
};

const scopeOf = (grain: AnalysisGrain | undefined, dims: readonly string[]): AnalysisScope => {
  const scope: { -readonly [K in keyof AnalysisScope]: AnalysisScope[K] } = {};
  if (grain !== undefined) scope.grain = grain;
  for (const dim of dims) {
    scope[dim as Exclude<keyof AnalysisScope, 'grain' | 'year'>] = DIM_VALUES[dim] ?? dim;
  }
  return scope;
};

/** Stable lookup key. Concentration rows ignore the artifact's retained-key dim. */
const comboKey = (
  grain: string,
  shape: string,
  dims: readonly string[],
  breakdownDim: string | undefined
): string =>
  [
    grain,
    shape,
    [...dims].sort().join('+'),
    shape === 'breakdown' ? (breakdownDim ?? '') : '',
  ].join('|');

const artifactByKey = new Map<string, (typeof artifact.combinations)[number][]>();
for (const combo of artifact.combinations) {
  const key = comboKey(combo.grain, combo.shape, combo.scopeDims, combo.breakdownDim);
  const list = artifactByKey.get(key) ?? [];
  list.push(combo);
  artifactByKey.set(key, list);
}

// ── direction 2: every artifact row agrees with routeAnalysis ──────────────────

describe('artifact → server: every artifact row agrees with routeAnalysis', () => {
  it.each(
    artifact.combinations.map((combo) => ({
      combo,
      label: `${combo.grain} ${combo.shape}(${combo.breakdownDim ?? ''}) {${combo.scopeDims.join(',')}} → ${combo.serving.kind}`,
    }))
  )('$label', ({ combo }) => {
    const dimension =
      combo.shape === 'breakdown' && combo.breakdownDim !== undefined
        ? ARTIFACT_TO_API_DIM[combo.breakdownDim]
        : undefined;
    const result = routeAnalysis(scopeOf(combo.grain, combo.scopeDims), combo.shape, dimension);

    if (combo.serving.kind === 'rollup') {
      const routes = result._unsafeUnwrap();
      expect(routes).toHaveLength(1);
      expect(routes[0]?.grain).toBe(combo.grain);
      expect(routes[0]?.rollup.table).toBe(`procurement.${combo.serving.rollup ?? ''}`);
    } else {
      const error = result._unsafeUnwrapErr();
      expect(error.type).toBe('InvalidInput');
      expect(error.message.length).toBeGreaterThan(0);
      if (combo.serving.kind === 'bounded_fact_query') {
        // Servable-by-fact-query per the artifact; the server does not build
        // that path in wave 1 and must reject with that exact framing.
        expect(error.message).toContain('bounded fact query');
      }
    }
  });
});

// ── directions 3 + 4: enumerate the server's whole acceptance space ────────────

const WAVE1_SCOPE_DIMS = [
  'authorityCui',
  'supplierCui',
  'cpvDivision',
  'cpvCode',
  'status',
  'procedureType',
  'buyerRegion',
] as const;

/** All parse-legal subsets (cpvDivision XOR cpvCode is enforced at parse time). */
const dimSubsets = (): readonly (readonly string[])[] => {
  const subsets: string[][] = [];
  for (let mask = 0; mask < 1 << WAVE1_SCOPE_DIMS.length; mask += 1) {
    const dims = WAVE1_SCOPE_DIMS.filter((_, i) => (mask & (1 << i)) !== 0);
    if (dims.includes('cpvDivision') && dims.includes('cpvCode')) continue;
    subsets.push([...dims]);
  }
  return subsets;
};

interface ShapeVariant {
  readonly shape: AnalysisShape;
  readonly dimension?: BreakdownDimension;
}

const SHAPE_VARIANTS: readonly ShapeVariant[] = [
  { shape: 'stats' },
  // Routing is measure-independent for additive measures; the distinct measures'
  // edge-only key-retention invariant is covered in combinations.test.ts.
  { shape: 'series' },
  ...(Object.keys(API_TO_ARTIFACT_DIM) as BreakdownDimension[]).map((dimension) => ({
    shape: 'breakdown' as const,
    dimension,
  })),
  { shape: 'concentration' },
];

describe('server → artifact: the full acceptance space', () => {
  // TODO(awaits regenerated artifact): this closure assertion is the ONLY piece
  // gated on the scraper's full-closure regeneration; it flips on automatically
  // once the vendored file grows past the curated 106 rows.
  it.skipIf(!ARTIFACT_IS_FULL_CLOSURE)(
    'every server-accepted (grain × dims × shape) appears in the artifact with the same rollup',
    () => {
      const mismatches: string[] = [];
      for (const dims of dimSubsets()) {
        for (const grain of ANALYSIS_GRAINS) {
          for (const variant of SHAPE_VARIANTS) {
            const result = routeAnalysis(scopeOf(grain, dims), variant.shape, variant.dimension);
            if (result.isErr()) continue; // rejections are covered by direction 2
            const route = result.value[0];
            const key = comboKey(
              grain,
              variant.shape,
              dims,
              variant.dimension !== undefined ? API_TO_ARTIFACT_DIM[variant.dimension] : undefined
            );
            const rows = (artifactByKey.get(key) ?? []).filter(
              (row) => row.serving.kind === 'rollup'
            );
            const tag = `${grain} ${variant.shape}(${variant.dimension ?? ''}) {${dims.join(',')}}`;
            if (rows.length === 0) {
              mismatches.push(`${tag}: server accepts, artifact has no rollup row`);
            } else if (
              !rows.some((row) => `procurement.${row.serving.rollup ?? ''}` === route?.rollup.table)
            ) {
              mismatches.push(
                `${tag}: server routes to ${route?.rollup.table ?? '?'}, artifact designates ${rows
                  .map((row) => row.serving.rollup)
                  .join('/')}`
              );
            }
          }
        }
      }
      expect(mismatches).toEqual([]);
    }
  );

  it('implicit-grain routing is exactly the union of the explicit-grain routes', () => {
    const mismatches: string[] = [];
    for (const dims of dimSubsets()) {
      for (const variant of SHAPE_VARIANTS) {
        const explicit = ANALYSIS_GRAINS.flatMap((grain) => {
          const result = routeAnalysis(scopeOf(grain, dims), variant.shape, variant.dimension);
          return result.isOk()
            ? result.value.map((route) => `${route.grain}:${route.rollup.rollup}`)
            : [];
        });
        const implicitResult = routeAnalysis(
          scopeOf(undefined, dims),
          variant.shape,
          variant.dimension
        );
        const implicit = implicitResult.isOk()
          ? implicitResult.value.map((route) => `${route.grain}:${route.rollup.rollup}`)
          : [];
        if (explicit.join(',') !== implicit.join(',')) {
          mismatches.push(
            `${variant.shape}(${variant.dimension ?? ''}) {${dims.join(',')}}: explicit [${explicit.join(',')}] != implicit [${implicit.join(',')}]`
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
