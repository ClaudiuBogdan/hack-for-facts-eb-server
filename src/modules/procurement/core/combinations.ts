/**
 * Procurement analysis — request validation (design §5, backend-independent).
 *
 * `routeAnalysis` validates an analysis request and fans it out to one route per
 * answerable grain. It enforces the SEMANTIC rules that hold regardless of
 * storage backend and rejects with the specific field named:
 *
 *  - a supplier-fixed concentration is a single-supplier tautology;
 *  - a distinct measure needs its measured key free;
 *  - a breakdown over a dimension the scope already fixes is a single bucket;
 *  - direct acquisitions have no procedure_type; procedures have no supplier.
 *
 * It no longer encodes a rollup-capability matrix: the ClickHouse wide fact
 * tables answer arbitrary dimension conjunctions, so the geography / 8-digit
 * cpvCode "not built yet" rejections the Postgres wave-1 rollups needed are
 * gone. A route now carries only its grain; the repo owns the SQL.
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

export interface AnalysisRoute {
  readonly grain: AnalysisGrain;
}

/** Which scope field pins each breakdown dimension to a single bucket. */
const DIMENSION_SCOPE_FIELD: Readonly<Record<BreakdownDimension, ScopeDimField>> = {
  authority: 'authorityCui',
  supplier: 'supplierCui',
  cpvDivision: 'cpvDivision',
  cpvCode: 'cpvCode',
  status: 'status',
  procedureType: 'procedureType',
  buyerRegion: 'buyerRegion',
  buyerCounty: 'buyerCounty',
  buyerSiruta: 'buyerSiruta',
  supplierRegion: 'supplierRegion',
  supplierCounty: 'supplierCounty',
  supplierSiruta: 'supplierSiruta',
};

/** Breakdown dimensions that require supplier columns (absent on procedures). */
const SUPPLIER_BREAKDOWN_DIMS: ReadonlySet<BreakdownDimension> = new Set([
  'supplier',
  'supplierRegion',
  'supplierCounty',
  'supplierSiruta',
]);

const DISTINCT_MEASURES: readonly MeasureId[] = ['distinctSuppliers', 'distinctAuthorities'];

/** Scope dimensions that anchor a supplier — none exist on the procedure grain. */
const SUPPLIER_SCOPE_DIMS: readonly ScopeDimField[] = [
  'supplierCui',
  'supplierCounty',
  'supplierRegion',
  'supplierSiruta',
];

const DA_NO_PROCEDURE_TYPE =
  'direct_acquisition grain has no procedure_type dimension (only contracts via linkage and procedures natively)';

const PROCEDURE_NO_SUPPLIER =
  'procedure grain has no supplier dimension (a procedure predates its award; suppliers exist on contracts and direct acquisitions)';

/**
 * Route an analysis request onto one route per answerable grain (explicit grain
 * → that grain; absent → every grain the request can answer). A grain the
 * request structurally excludes is REJECTED when the grain is explicit and
 * SKIPPED when the grain set is implicit.
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
    if (scope[measuredKey] !== undefined) {
      return err(
        invalidInput(
          `${measure} requires the measured key ${measuredKey} to remain free; use recordCount for a scope that fixes it`,
          measuredKey
        )
      );
    }
  }

  // A breakdown over a dimension the scope already FIXES is a single bucket —
  // that is a stats answer, not a distribution.
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
  const grains = scope.grain !== undefined ? [scope.grain] : ANALYSIS_GRAINS;

  const routes: AnalysisRoute[] = [];
  for (const grain of grains) {
    // A measure the policy table does not declare for this grain is skipped when
    // the grain set is implicit (e.g. procedure has no distinct entries); an
    // explicit grain/measure mismatch is caught by the shape executor.
    if (measure !== undefined && policyFor(grain, measure) === undefined) continue;

    // direct_acquisition rows never carry procedure_type; procedures carry no
    // supplier. An explicit grain gets the named rejection; an implicit grain is
    // skipped (the other labeled blocks still serve).
    let excluded: string | undefined;
    if (
      grain === 'direct_acquisition' &&
      (dims.includes('procedureType') || dimension === 'procedureType')
    ) {
      excluded = DA_NO_PROCEDURE_TYPE;
    } else if (
      grain === 'procedure' &&
      (shape === 'concentration' ||
        (dimension !== undefined && SUPPLIER_BREAKDOWN_DIMS.has(dimension)) ||
        SUPPLIER_SCOPE_DIMS.some((d) => dims.includes(d)))
    ) {
      excluded = PROCEDURE_NO_SUPPLIER;
    }
    if (excluded !== undefined) {
      if (scope.grain !== undefined) return err(invalidInput(excluded, 'scope'));
      continue;
    }

    routes.push({ grain });
  }

  if (routes.length === 0) {
    return err(
      invalidInput(
        'no analysis grain can answer this request (the requested measure or dimension is not declared for any applicable grain)',
        'scope'
      )
    );
  }
  return ok(routes);
};
