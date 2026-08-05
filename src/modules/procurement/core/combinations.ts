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
  CORE_ANALYSIS_GRAINS,
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
  cpvGroup: 'cpvGroup',
  cpvClass: 'cpvClass',
  cpvCategory: 'cpvCategory',
  cpvCode: 'cpvCode',
  status: 'status',
  procedureType: 'procedureType',
  recordKind: 'recordKind',
  frameworkRole: 'frameworkRole',
  buyerRegion: 'buyerRegion',
  buyerCounty: 'buyerCounty',
  buyerSiruta: 'buyerSiruta',
  supplierRegion: 'supplierRegion',
  supplierCounty: 'supplierCounty',
  supplierSiruta: 'supplierSiruta',
};

/**
 * CPV hierarchy: a scope at level L fixes every breakdown at level ≤ L to a
 * single bucket (a cpvCode scope pins its category/class/group/division; a
 * group scope pins its division but leaves class/category/code free).
 */
const CPV_FINER_SCOPES: Readonly<Partial<Record<BreakdownDimension, readonly ScopeDimField[]>>> = {
  cpvDivision: ['cpvGroup', 'cpvClass', 'cpvCategory', 'cpvCode'],
  cpvGroup: ['cpvClass', 'cpvCategory', 'cpvCode'],
  cpvClass: ['cpvCategory', 'cpvCode'],
  cpvCategory: ['cpvCode'],
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

const RECORD_KIND_CONTRACT_ONLY =
  'record_kind exists only on the contract grain (award record vs framework umbrella is a contract-record property; direct acquisitions and procedures carry none)';

const FRAMEWORK_ROLE_CONTRACT_ONLY =
  'framework_role exists only on the contract grain (a framework role is a property of a contract record; direct acquisitions have no framework channel, and the framework/call-off populations ARE the roles)';

/**
 * A frameworkRole breakdown under the purchases-only default would render one
 * bucket and read as "there are no frameworks" — the exact misreading this
 * wave exists to end. Auto-widening instead would be worse: the buckets would
 * no longer sum to the stats answer for the same scope. Force the caller to
 * say `all` out loud.
 */
const FRAMEWORK_ROLE_BREAKDOWN_NEEDS_ALL =
  "breakdown(frameworkRole) needs scope.frameworkRole='all': the contract grain defaults to purchases only, so a role distribution under the default is a single bucket, and widening it silently would make the buckets disagree with procurementStats for the same scope";

// ── value-basis wave populations (design v1.1): explicit-only grains with
// narrower capability surfaces than the three core grains ──────────────────────

/**
 * Scope/dimension capability of the new populations. Anything not listed is
 * rejected with a named message: the parent-grain frameworks table has NO
 * supplier columns (ceilings are never attributable to one supplier), call-offs
 * carry only a validated CPV division, and modifications are counts-only.
 */
const NEW_GRAIN_SCOPE_DIMS: Readonly<Partial<Record<AnalysisGrain, ReadonlySet<ScopeDimField>>>> = {
  // Frameworks carry a full cpv_code (measured 514,609/514,609 rows) — the
  // whole CPV hierarchy is admitted. NO supplier fields exist at this grain.
  framework: new Set<ScopeDimField>([
    'authorityCui',
    'cpvDivision',
    'cpvGroup',
    'cpvClass',
    'cpvCategory',
    'cpvCode',
    'buyerRegion',
    'buyerCounty',
    'buyerSiruta',
  ]),
  // Supplier GEOGRAPHY is deliberately absent: no supplier_geo coverage row
  // is published for call-offs yet, and gating supplier geo on the buyer_geo
  // verdict would be dishonest — supplierCui itself stays servable.
  calloff: new Set<ScopeDimField>([
    'authorityCui',
    'supplierCui',
    'cpvDivision',
    'buyerRegion',
    'buyerCounty',
    'buyerSiruta',
  ]),
  // cpvDivision/recordKind map to the linked-contract enrichment columns
  // (linked_cpv_division 95.6% / linked_record_kind 99.9% populated).
  modification: new Set<ScopeDimField>([
    'authorityCui',
    'supplierCui',
    'cpvDivision',
    'recordKind',
    'buyerRegion',
    'buyerCounty',
    'buyerSiruta',
  ]),
};

const NEW_GRAIN_BREAKDOWN_DIMS: Readonly<
  Partial<Record<AnalysisGrain, ReadonlySet<BreakdownDimension>>>
> = {
  // Framework breakdowns are WITHHELD in v1: sliced ceiling totals carry up
  // to ~22% exact-repeat uncertainty inside single-buyer slices (review F3);
  // rankings unlock with the Phase-2 repeat-cluster keys. Stats/series only.
  framework: new Set<BreakdownDimension>([]),
  calloff: new Set<BreakdownDimension>([
    'authority',
    'supplier',
    'cpvDivision',
    'buyerRegion',
    'buyerCounty',
    'buyerSiruta',
  ]),
  modification: new Set<BreakdownDimension>([
    'authority',
    'supplier',
    'cpvDivision',
    'recordKind',
    'buyerRegion',
    'buyerCounty',
    'buyerSiruta',
  ]),
};

/** The structural rejection for a new-population grain, or undefined when servable. */
const newGrainExclusion = (
  grain: AnalysisGrain,
  scope: AnalysisScope,
  shape: AnalysisShape,
  dims: readonly ScopeDimField[],
  dimension?: BreakdownDimension
): string | undefined => {
  const allowedDims = NEW_GRAIN_SCOPE_DIMS[grain];
  if (allowedDims === undefined) return undefined;
  const badDim = dims.find((d) => !allowedDims.has(d));
  if (badDim !== undefined) {
    return `the '${grain}' population does not carry the ${badDim} dimension (design v1.1: frameworks are parent-grain without suppliers; call-offs and modifications carry a reduced column set)`;
  }
  if (dimension !== undefined && !(NEW_GRAIN_BREAKDOWN_DIMS[grain]?.has(dimension) ?? false)) {
    return `breakdown(${dimension}) is not available on the '${grain}' population`;
  }
  if (scope.q !== undefined) {
    return `q (title search) is not available on the '${grain}' population (no title column)`;
  }
  if (grain === 'modification' && (scope.valueMin !== undefined || scope.valueMax !== undefined)) {
    return 'the modification population is counts-only — value bounds do not apply (raw amendment deltas are quality-relabeled, not servable money)';
  }
  if (shape === 'concentration' && grain !== 'calloff') {
    return `concentration requires supplier money — only the calloff population supports it among the value-basis grains ('${grain}' has ${grain === 'framework' ? 'no supplier dimension' : 'no servable money'})`;
  }
  return undefined;
};

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
    // frameworkRole='all' is the OPPOSITE of a fixing value — it widens the
    // population back to every role, which is precisely what makes a role
    // distribution meaningful. Every other scope value pins one bucket.
    const fixesDimension =
      scope[fixingField] !== undefined &&
      !(fixingField === 'frameworkRole' && scope.frameworkRole === 'all');
    const fixedBy = fixesDimension
      ? fixingField
      : (CPV_FINER_SCOPES[dimension] ?? []).find((field) => scope[field] !== undefined);
    if (fixedBy !== undefined) {
      return err(
        invalidInput(
          `breakdown(${dimension}) is already fixed by the ${fixedBy} scope — a single-bucket breakdown is a stats answer; use procurementStats`,
          'dimension'
        )
      );
    }
    // Request-level, NOT a per-grain capability: routed as a grain exclusion
    // it gets swallowed by the implicit fan-out ("no grain can answer this")
    // and the caller never learns which word to add.
    if (dimension === 'frameworkRole' && scope.frameworkRole === undefined) {
      return err(invalidInput(FRAMEWORK_ROLE_BREAKDOWN_NEEDS_ALL, 'frameworkRole'));
    }
  }

  const dims = scopeDims(scope);
  // Implicit requests fan out over the CORE grains only: the value-basis
  // populations (framework/calloff/modification) answer ONLY when named —
  // mixing their blocks into implicit answers invites summing ceilings or
  // call-offs with awards (double-counting framework spend).
  const grains = scope.grain !== undefined ? [scope.grain] : CORE_ANALYSIS_GRAINS;

  const routes: AnalysisRoute[] = [];
  for (const grain of grains) {
    // A measure the policy table does not declare for this grain is skipped when
    // the grain set is implicit (e.g. procedure has no distinct entries); an
    // explicit grain/measure mismatch is caught by the shape executor.
    if (measure !== undefined && policyFor(grain, measure) === undefined) continue;

    // direct_acquisition rows never carry procedure_type; procedures carry no
    // supplier. An explicit grain gets the named rejection; an implicit grain is
    // skipped (the other labeled blocks still serve).
    let excluded: string | undefined = newGrainExclusion(grain, scope, shape, dims, dimension);
    if (excluded !== undefined) {
      // fall through to the shared rejection/skip handling below
    } else if (
      grain !== 'contract' &&
      grain !== 'modification' && // modifications expose the LINKED contract's record_kind
      (dims.includes('recordKind') || dimension === 'recordKind')
    ) {
      excluded = RECORD_KIND_CONTRACT_ONLY;
    } else if (
      grain !== 'contract' &&
      (dims.includes('frameworkRole') || dimension === 'frameworkRole')
    ) {
      excluded = FRAMEWORK_ROLE_CONTRACT_ONLY;
    } else if (
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
