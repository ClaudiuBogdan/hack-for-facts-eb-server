/**
 * Procurement analysis — the supported-combinations matrix (design §6.2, F5).
 *
 * `WAVE1_CAPABILITIES` describes exactly what the scraper's five wave-1 rollups
 * can answer: which grains, which scope dimensions, which breakdown dimensions,
 * and whether counterparty keys are retained (distinct counts + concentration
 * need them). `routeAnalysis` maps (scope, shape, dimension?, measure?) onto a
 * rollup per grain — or rejects with the SPECIFIC missing capability named
 * (the bound-policy actionable-error discipline).
 *
 * The vendored `procurement-analysis-combinations-v2.json` artifact is the
 * scraper's checked-in copy of the same matrix; `ANALYSIS_MATRIX_SHA256` pins
 * its hash. Boot fails if the local bytes drift; analysis requests fail closed
 * when the active generation carries a different `matrix_hash`.
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import { scopeDims, type AnalysisScope, type ScopeDimField } from './analysis-scope.js';
import {
  ANALYSIS_GRAINS,
  type AnalysisGrain,
  type BreakdownDimension,
  type MeasureId,
} from './constants.js';
import { policyFor, type AnalysisShape } from './policy.js';

/**
 * SHA-256 of the vendored `procurement-analysis-combinations-v2.json` (a
 * byte-exact copy of the scraper's `prod-db/contracts/` artifact). The unit
 * suite recomputes the hash from the vendored file; the scraper stamps the
 * same constant into `analysis_generations.matrix_hash` at build time.
 */
export const ANALYSIS_MATRIX_SHA256 =
  '9f552ef40b548e0812eedb9d0009e60e6577a037ae7d477f328f557593f3bdf9';

export type AnalysisRollupId = 'edge' | 'authorityDims' | 'supplierCpv' | 'cpvCode' | 'regionCpv';

export interface RollupCapability {
  readonly rollup: AnalysisRollupId;
  /** DB table (schema-qualified) — the repo's single source for the mapping. */
  readonly table: string;
  readonly grains: readonly AnalysisGrain[];
  /** Scope dimensions this rollup can filter by. */
  readonly scopeDims: readonly ScopeDimField[];
  /** Dimensions this rollup can break down / facet by. */
  readonly breakdownDims: readonly BreakdownDimension[];
  /** Retains BOTH counterparty keys (per-bucket distinct counts). */
  readonly keyRetaining: boolean;
  /**
   * Counterparty keys this rollup retains. Concentration needs at least one of
   * them NOT fixed by the scope — a scope pinning every retained key leaves a
   * single-entity "concentration", which is a stats answer (the artifact omits
   * those combinations).
   */
  readonly counterpartyKeys: readonly ScopeDimField[];
}

const CONTRACT_DA: readonly AnalysisGrain[] = ['contract', 'direct_acquisition'];

/**
 * Array order IS the stats/series routing preference (`routeAnalysis` takes the
 * first fit), chosen to reproduce the vendored matrix's designated rollup for
 * every combination (`matrix-artifact.test.ts` asserts full BIDIRECTIONAL
 * parity with the v2 closure): region_cpv first (the smallest rollup —
 * owns division-only and platform-wide scopes), authority_dims for anything
 * authority/status/procedure-type shaped, supplier_cpv for supplier-anchored
 * scopes, the key-retaining edge for counterparty pairs, cpv_code last.
 * Breakdown/concentration invert to `ENTITY_FIRST_ORDER` below.
 */
export const WAVE1_CAPABILITIES: readonly RollupCapability[] = [
  {
    rollup: 'regionCpv',
    table: 'procurement.analysis_rollup_region_cpv_monthly',
    grains: ANALYSIS_GRAINS,
    scopeDims: ['buyerRegion', 'cpvDivision'],
    breakdownDims: ['buyerRegion', 'cpvDivision'],
    keyRetaining: false,
    counterpartyKeys: [],
  },
  {
    rollup: 'authorityDims',
    table: 'procurement.analysis_rollup_authority_dims_monthly',
    grains: ANALYSIS_GRAINS,
    scopeDims: ['authorityCui', 'cpvDivision', 'status', 'procedureType'],
    breakdownDims: ['authority', 'cpvDivision', 'status', 'procedureType'],
    keyRetaining: false,
    counterpartyKeys: [],
  },
  {
    rollup: 'supplierCpv',
    table: 'procurement.analysis_rollup_supplier_cpv_monthly',
    grains: CONTRACT_DA,
    scopeDims: ['supplierCui', 'cpvDivision'],
    breakdownDims: ['supplier', 'cpvDivision'],
    keyRetaining: false,
    counterpartyKeys: ['supplierCui'],
  },
  {
    rollup: 'edge',
    table: 'procurement.analysis_rollup_edge_monthly',
    grains: CONTRACT_DA, // procedures have no supplier — no procedure edges exist
    scopeDims: ['authorityCui', 'supplierCui'],
    breakdownDims: ['authority', 'supplier'],
    keyRetaining: true,
    counterpartyKeys: ['authorityCui', 'supplierCui'],
  },
  {
    rollup: 'cpvCode',
    table: 'procurement.analysis_rollup_cpv_code_monthly',
    grains: ANALYSIS_GRAINS,
    scopeDims: ['cpvCode', 'cpvDivision'],
    breakdownDims: ['cpvCode'],
    keyRetaining: false,
    counterpartyKeys: [],
  },
];

export interface AnalysisRoute {
  readonly rollup: RollupCapability;
  readonly grain: AnalysisGrain;
}

/** Breakdown/concentration preference (the artifact's documented order). */
const ENTITY_FIRST_ORDER: readonly RollupCapability[] = (
  ['edge', 'supplierCpv', 'authorityDims', 'cpvCode', 'regionCpv'] as const
).flatMap((id) => WAVE1_CAPABILITIES.filter((cap) => cap.rollup === id));

/** Which scope field pins each breakdown dimension to a single bucket. */
const DIMENSION_SCOPE_FIELD: Readonly<Record<BreakdownDimension, ScopeDimField>> = {
  authority: 'authorityCui',
  supplier: 'supplierCui',
  cpvDivision: 'cpvDivision',
  cpvCode: 'cpvCode',
  status: 'status',
  procedureType: 'procedureType',
  buyerRegion: 'buyerRegion',
};

const DISTINCT_MEASURES: readonly MeasureId[] = ['distinctSuppliers', 'distinctAuthorities'];

/**
 * Per-grain dimension exclusions the rollup schema enforces (vendored-matrix
 * parity): the rollups carry the column for OTHER grains, but this grain's rows
 * never populate it, so serving would silently return an empty answer instead
 * of the honest rejection.
 */
const GRAIN_DIM_EXCLUSIONS: readonly {
  readonly grain: AnalysisGrain;
  readonly dim: 'procedureType';
  readonly reason: string;
}[] = [
  {
    grain: 'direct_acquisition',
    dim: 'procedureType',
    reason:
      'direct_acquisition grain has no procedure_type dimension (only contracts via linkage and procedures natively)',
  },
];

/** Human tag for reject messages: `authorityCui×status` or `platform-wide`. */
const dimsTag = (dims: readonly ScopeDimField[]): string =>
  dims.length === 0 ? 'platform-wide' : dims.join('×');

const shapeTag = (shape: AnalysisShape, dimension?: BreakdownDimension): string =>
  dimension !== undefined ? `${shape}(${dimension})` : shape;

/**
 * Route an analysis request onto wave-1 rollups, one route per answerable grain.
 * Rejections name the missing capability so the caller (human or agent) knows
 * exactly what is not built and why.
 */
export const routeAnalysis = (
  scope: AnalysisScope,
  shape: AnalysisShape,
  dimension?: BreakdownDimension,
  measure?: MeasureId
): Result<readonly AnalysisRoute[], ApiError> => {
  if (shape === 'concentration' && scope.supplierCui !== undefined) {
    return err(
      invalidInput(
        'supplier concentration requires supplierCui to remain free; a supplier-scoped concentration is a single-supplier tautology — use procurementStats',
        'supplierCui'
      )
    );
  }

  if (measure !== undefined && DISTINCT_MEASURES.includes(measure)) {
    const measuredKey = measure === 'distinctSuppliers' ? 'supplierCui' : 'authorityCui';
    const oppositeKey = measure === 'distinctSuppliers' ? 'authorityCui' : 'supplierCui';
    if (scope[measuredKey] !== undefined) {
      return err(
        invalidInput(
          `${measure} requires the measured key ${measuredKey} to remain free; use recordCount for a scope that fixes it`,
          measuredKey
        )
      );
    }
    const requestedDims = scopeDims(scope);
    if (scope.grain === undefined && requestedDims.length === 0) {
      return err(
        invalidInput(
          `${measure} at platform scope requires an explicit contract grain; unbounded direct-acquisition distinct series is not advertised`,
          'grain'
        )
      );
    }
    if (scope.grain === 'direct_acquisition' && scope[oppositeKey] === undefined) {
      return err(
        invalidInput(
          `unbounded direct-acquisition ${measure} is not advertised; bind ${oppositeKey} or use recordCount`,
          oppositeKey
        )
      );
    }
  }

  // Named structural rejections first — these are contract fields whose serving
  // capability does not exist yet, not malformed input.
  if (scope.supplierRegion !== undefined || scope.supplierCounty !== undefined) {
    return err(
      invalidInput(
        'supplier geography (supplierRegion/supplierCounty) requires the ONRC supplier-geo resolution, which is not built (milestone M3)',
        scope.supplierRegion !== undefined ? 'supplierRegion' : 'supplierCounty'
      )
    );
  }
  if (scope.buyerCounty !== undefined) {
    return err(
      invalidInput(
        'buyerCounty scope requires a buyer_county rollup, which is not built (wave-2 candidate) — use buyerRegion',
        'buyerCounty'
      )
    );
  }

  // A breakdown over a dimension the scope already FIXES is a single bucket —
  // that is a stats answer, not a distribution (the artifact omits these rows).
  if (shape === 'breakdown' && dimension !== undefined) {
    const fixingField = DIMENSION_SCOPE_FIELD[dimension];
    const fixedBy =
      scope[fixingField] !== undefined
        ? fixingField
        : dimension === 'cpvDivision' && scope.cpvCode !== undefined
          ? 'cpvCode'
          : undefined;
    if (fixedBy !== undefined) {
      return err(
        invalidInput(
          `breakdown(${dimension}) is already fixed by the ${fixedBy} scope — a single-bucket breakdown is a stats answer; use procurementStats`,
          'dimension'
        )
      );
    }
  }

  const dims = scopeDims(scope);
  if (scope.cpvCode !== undefined && dims.length > 1) {
    const others = dims.filter((d) => d !== 'cpvCode');
    return err(
      invalidInput(
        `8-digit cpvCode combined with ${dimsTag(others)} is a bounded fact query, not served by the wave-1 rollups (the cpv_code rollup carries no other dimension) — use cpvDivision or drop the extra dimension`,
        'cpvCode'
      )
    );
  }

  const needsKeyRetention = measure !== undefined && DISTINCT_MEASURES.includes(measure);
  const grains = scope.grain !== undefined ? [scope.grain] : ANALYSIS_GRAINS;

  // Shape-specific preference, mirroring the artifact's documented orders:
  //  - stats/series ownership: region_cpv (division-only/platform) > authority_dims
  //    > supplier_cpv > edge > cpv_code — the WAVE1_CAPABILITIES array order;
  //  - breakdown/concentration: edge > supplier_cpv > authority_dims > cpv_code >
  //    region_cpv, restricted to rollups carrying the grain + dims.
  const searchOrder =
    shape === 'breakdown' || shape === 'concentration' ? ENTITY_FIRST_ORDER : WAVE1_CAPABILITIES;

  const routes: AnalysisRoute[] = [];
  for (const grain of grains) {
    // A measure the policy table does not declare for this grain is skipped when
    // the grain set is implicit (e.g. procedure has no distinct entries), and
    // rejected below when explicit.
    if (measure !== undefined && policyFor(grain, measure) === undefined) continue;

    // A dimension this grain's rows never populate: explicit grain → the named
    // rejection; implicit → skip the grain (the other labeled blocks still serve).
    const exclusion = GRAIN_DIM_EXCLUSIONS.find(
      (e) => e.grain === grain && (dims.includes(e.dim) || dimension === e.dim)
    );
    if (exclusion !== undefined) {
      if (scope.grain !== undefined) return err(invalidInput(exclusion.reason, 'scope'));
      continue;
    }

    const candidate = searchOrder.find(
      (cap) =>
        cap.grains.includes(grain) &&
        dims.every((d) => cap.scopeDims.includes(d)) &&
        (dimension === undefined || cap.breakdownDims.includes(dimension)) &&
        (!needsKeyRetention || cap.keyRetaining) &&
        (shape !== 'concentration' || cap.counterpartyKeys.some((key) => scope[key] === undefined))
    );
    if (candidate !== undefined) routes.push({ rollup: candidate, grain });
  }

  if (routes.length === 0) {
    const needed = [...dims, ...(dimension !== undefined ? [dimension] : [])];
    const suffix = needsKeyRetention
      ? ' with counterparty key retention (only the authority×supplier edge rollup retains keys)'
      : shape === 'concentration'
        ? ' retaining supplier keys with at least one counterparty key not fixed by the scope (a fully-pinned concentration is a stats answer)'
        : '';
    return err(
      invalidInput(
        `${shapeTag(shape, dimension)} under ${dimsTag(dims)} scope${
          scope.grain !== undefined ? ` on the ${scope.grain} grain` : ''
        } requires a ${needed.length > 0 ? needed.join('×') : 'platform'} rollup${suffix}, which is not built (wave-2 candidate)`,
        'scope'
      )
    );
  }
  return ok(routes);
};
