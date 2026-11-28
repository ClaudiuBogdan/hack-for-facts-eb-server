/**
 * Procurement analysis — the shape executors (design §5.2). Pure, deps-first,
 * `Result`-returning; GraphQL and MCP call the SAME executors (tri-surface parity).
 *
 * Invariants enforced here, not in the shell:
 *  - ONE generation per request: every top-level executor resolves the active
 *    generation ONCE and pins every read (and every derived operand — share,
 *    facets) to that buildId, so a cutover mid-request cannot mix builds;
 *  - grains never merge: every answer is an array of LABELED per-grain blocks,
 *    and there is no cross-grain sum field anywhere;
 *  - gate composition (design §5.4): spend gates money; time is consulted when
 *    the scope is time-bounded or the shape is a series; geo when the scope or
 *    dimension involves buyer geography. Degraded classes serve WITH caveats;
 *    an abstaining class blocks the shape for that grain — and a blocked block
 *    never fabricates reads (its envelope counts are null, not zero);
 *  - money is null when unobserved OR gate-abstained (never zero), with caveats
 *    distinguishing the two;
 *  - quarter/year series are derived in core ONLY for additive laws; distinct
 *    counts are bucketed by the repo (COUNT(DISTINCT) per bucket) and never
 *    re-bucketed here;
 *  - breakdowns reconcile by construction: top + other + unknown must sum to the
 *    same read's totals, and a mismatch is an internal error, not an answer;
 *  - shares are validated derivations over two stats reads — an operand failure
 *    IS the answer, never a partial ratio.
 *
 * All ratio/money arithmetic is `decimal.js`; ratios are emitted as decimal
 * STRINGS (§14.1 — no floats on the wire).
 */

import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  disclosureKeyOf,
  invalidInput,
  isWithheldOrganizationIdentifier,
  busyRetryLater,
  retryAfterSecondsOf,
  serviceUnavailable,
  type ApiError,
  type SupplierDisclosurePort,
} from '@/modules/shared/index.js';

import {
  canonicalScopeEcho,
  isSubsetScope,
  sameWindow,
  scopeDims,
  scopeRowFilters,
  scopeWindow,
  supplierScoped,
  type AnalysisScope,
} from './analysis-scope.js';
import { CA_MONEY_JOINT_NOTE } from './ca-money-analysis.js';
import { routeAnalysis, type AnalysisRoute } from './combinations.js';
import {
  DA_NATURAL_PERSON_BUCKET,
  type FrameworkRoleFilter,
  type GenerationCapabilities,
  SEARCH_WINDOW_MAX,
  TOPN_SIRUTA_MAX,
  type AnalysisGrain,
  type BreakdownDimension,
  type MeasureId,
  type SeriesBucket,
} from './constants.js';
import { buildEnvelope, type AnswerEnvelope, type EnvelopeReads } from './envelope.js';
import { publicPartyName } from './free-text-rule.js';
import {
  decideAnswer,
  decideMoney,
  type AnswerabilityReason,
  type BasisCoverageRow,
  type GateDecision,
} from './gate-v2.js';
import {
  anchorPolicy,
  moneyAnchorMeasure,
  policyFor,
  type PolicyEntry,
  type ValueBasis,
} from './policy.js';
import {
  ANALYSIS_RECORDS_SORTS,
  type ActiveGeneration,
  type AnalysisRecordRow,
  type AnalysisRecordsSort,
  type AnalysisRepo,
  type AnalysisStatsRead,
  type DaSupplierNamesPort,
} from './ports.js';
import { sourceNotes } from './source-capture.js';
import {
  servedSupplierName,
  type ServedSupplierKind,
  type SupplierNaming,
} from './supplier-naming.js';

export interface AnalysisDeps {
  readonly analysisRepo: AnalysisRepo;
  /**
   * Route override — the ClickHouse dev backend routes permissively
   * (geography dims the rollup matrix rejects are valid there). Defaults to
   * the rollup-matrix `routeAnalysis`.
   */
  readonly routeAnalysis?: typeof routeAnalysis;
  /**
   * Site-wide D6 (PROCUREMENT_SUPPLIER_DISCLOSURE_ENFORCED): supplier buckets of
   * the DA grain carry a displayKind, and a withheld supplier code is never
   * echoed back in `canonicalScope`.
   */
  readonly supplierDisclosure?: SupplierDisclosurePort;
  /**
   * The D6-gated names of DA supplier buckets (PROC-B51G). Absent: no bucket is named
   * (`displayName` null); never any other name source.
   */
  readonly daSupplierNames?: DaSupplierNamesPort;
}

/**
 * Every key a request's blocks can be served under: the request generation's
 * and each per-grain source's (the v3 DA grain resolves its own generation).
 */
const servedKeys = (gen: ActiveGeneration): readonly (string | undefined)[] => [
  gen.disclosureKey,
  ...Object.values(gen.grainSources ?? {}).map((source) => source.generation.disclosureKey),
];

/**
 * The echoed scope: a supplier code D6 withholds is never repeated in a response.
 * The echo is shared by every block of the answer, so the code is echoed only when
 * the set that lists it public comes from the very publication EVERY block can be
 * keyed by (`servedKeys`): an echo decided under another state (a publish, or
 * supplier_privacy coming back or going away, mid-request) would not match some
 * block's key, so it says `withheld`.
 */
const echoScope = async (
  deps: AnalysisDeps,
  scope: AnalysisScope,
  gen: ActiveGeneration
): Promise<string> => {
  if (deps.supplierDisclosure?.enforced !== true || scope.supplierCui === undefined)
    return canonicalScopeEcho(scope);
  const codes = await deps.supplierDisclosure.publicSupplierCodes();
  if (codes.isErr() || !codes.value.has(scope.supplierCui))
    return canonicalScopeEcho({ ...scope, supplierCui: 'withheld' });
  const key = disclosureKeyOf(codes.value);
  return servedKeys(gen).every((served) => served === key)
    ? canonicalScopeEcho(scope)
    : canonicalScopeEcho({ ...scope, supplierCui: 'withheld' });
};

// ── result shapes ──────────────────────────────────────────────────────────────

/** Count fields are null ONLY when the whole block is gate-blocked (not read). */
/** Structured per-measure money verdict (review F5): a contract block can
 * simultaneously carry awarded=disclosed, estimated=abstained and
 * mod-adjusted=served — prose caveats alone cannot represent that. */
export interface AnalysisMoneyVerdict {
  readonly measure: MeasureId;
  readonly answerability: 'served' | 'degraded' | 'abstained';
  readonly reason: AnswerabilityReason | null;
  readonly caveats: readonly string[];
}

export interface AnalysisStatsBlock {
  readonly grain: AnalysisGrain;
  readonly recordCount: string | null;
  readonly withValueCount: string | null;
  readonly withEstimatedCount: string | null;
  readonly valueAwardedSum: string | null;
  readonly valueEstimatedSum: string | null;
  /** Framework grain only: Σ attributed ceiling — never mixed into awarded. */
  readonly valueCeilingSum: string | null;
  /** Contract grain only: Σ modification-adjusted value (anchored chains). */
  readonly valueModAdjustedSum: string | null;
  readonly valueAwardedMatchedSum: string | null;
  readonly avgValueAwarded: string | null;
  /**
   * Supplier-money reads only (association dedup): consortium money withheld
   * from per-supplier totals in this scope. Null on attributed-basis reads.
   */
  readonly valueWithheldAssociationSum: string | null;
  readonly minMonth: string | null;
  readonly maxMonth: string | null;
  /** One verdict per declared money measure of this grain. */
  readonly moneyVerdicts: readonly AnalysisMoneyVerdict[];
  readonly meta: AnswerEnvelope;
}

export interface AnalysisStatsResult {
  /** Labeled per-grain blocks, side by side — NEVER a cross-grain sum. */
  readonly blocks: readonly AnalysisStatsBlock[];
}

export interface AnalysisSeriesPoint {
  readonly bucket: string;
  readonly value: string | null;
}

export interface AnalysisSeriesBlock {
  readonly grain: AnalysisGrain;
  readonly measure: MeasureId;
  readonly bucket: SeriesBucket;
  readonly points: readonly AnalysisSeriesPoint[];
  readonly meta: AnswerEnvelope;
}

export interface AnalysisBreakdownBucket {
  readonly key: string | null;
  readonly kind: 'top' | 'other' | 'unknown';
  readonly recordCount: string;
  readonly withValueCount: string;
  /** Awarded money only — null on grains whose anchor money is another basis. */
  readonly valueAwardedSum: string | null;
  /** The grain's ANCHOR money (awarded / ceiling / call-off value). */
  readonly valueSum: string | null;
  /** Share of the scope total on the ranking basis, as a decimal string. */
  readonly shareOfScope: string | null;
  /**
   * DA supplier buckets under D6: `company` for a named supplier, `natural_person`
   * for the one withheld bucket. Absent elsewhere (and while D6 is off on legacy).
   */
  readonly displayKind?: ServedSupplierKind | 'natural_person';
  /**
   * With `displayKind` (PROC-B51G): a company bucket's public registry name, only when its
   * supplier name is public; null for natural_person and for a company whose name is not public.
   * The only name a client may show for a DA supplier bucket. Read per answer, never cached.
   */
  readonly displayName?: string | null;
}

export interface AnalysisBreakdownBlock {
  readonly grain: AnalysisGrain;
  readonly dimension: BreakdownDimension;
  readonly rankedBy: 'value' | 'count';
  readonly buckets: readonly AnalysisBreakdownBucket[];
  /**
   * Supplier-money breakdowns only (supplier-keyed dimension or
   * supplier-scoped request): the consortium money withheld from every
   * bucket in this scope — buckets + this field reconcile to the
   * attributed total (the under-map disclosure). Null otherwise.
   */
  readonly valueWithheldAssociationSum: string | null;
  readonly meta: AnswerEnvelope;
}

export interface AnalysisConcentrationBlock {
  readonly grain: AnalysisGrain;
  readonly basis: 'value' | 'count';
  /** Distinct KNOWN suppliers in scope; null when the block is gate-blocked. */
  readonly supplierCount: number | null;
  readonly top1Share: string | null;
  readonly top5Share: string | null;
  readonly hhi: string | null;
  readonly totalRon: string | null;
  /**
   * Contract grain only: the awarded money in scope that belongs to
   * multi-member consortium awards and therefore enters NO supplier's measure
   * (the internal split is unpublished). `totalRon` + this + the
   * unknown-supplier weight reconcile to the scope's attributed total, so a
   * surface can state truthfully what the concentration covers instead of
   * calling the remainder "supplier unidentified". Null when the amount is not
   * quotable (see the qualitative disclosure modes) or nothing is withheld.
   */
  readonly valueWithheldAssociationSum: string | null;
  readonly meta: AnswerEnvelope;
}

export interface AnalysisShareResult {
  readonly share: string | null;
  readonly answerability: 'served' | 'degraded' | 'abstained';
  readonly reason?: AnswerabilityReason;
  readonly numerator: AnalysisStatsBlock;
  readonly denominator: AnalysisStatsBlock;
  readonly caveats: readonly string[];
}

export interface AnalysisFacetsResult {
  readonly blocks: readonly AnalysisBreakdownBlock[];
}

// ── shared helpers ─────────────────────────────────────────────────────────────

export const TOPN_DEFAULT = 10;
export const TOPN_MAX = 100;
export const FACET_DIMENSIONS_MAX = 3;

const RATIO_DP = 4;
const MONEY_DP = 2;

const d = (v: string | null | undefined): Decimal => new Decimal(v ?? '0');

/** Resolve the active generation or fail with the clean not-published error. */
const activeGen = async (repo: AnalysisRepo): Promise<Result<ActiveGeneration, ApiError>> => {
  const r = await repo.activeGeneration();
  if (r.isErr()) return err(r.error);
  if (r.value === null) {
    return err(serviceUnavailable('procurement analysis package not published'));
  }
  // matrixHash is informational passthrough now — the ClickHouse fact tables
  // answer arbitrary conjunctions, so a matrix hash no longer gates serving.
  return ok(r.value);
};

const PROCEDURE_LIFECYCLE_NOTE =
  'procedures are tender lifecycles (a procedure yields contracts) — never sum this count with contract/direct-acquisition counts';

const NO_AWARDED_VALUES_CAVEAT =
  'no awarded values observed in scope — the sum is null (unobserved), not zero';

/**
 * The value→count ranking fallback (repo-decided): a value ORDER BY over a
 * scope with no value-bearing rows on this breakdown's money basis is an
 * all-zero tie, and reporting rankedBy=value for it would name a ranking that
 * was never made. The buckets below ARE count-ranked (re-ranked before top-N).
 */
const NO_VALUE_TO_RANK_CAVEAT =
  'ranked by record count: no record in this scope carries an accepted value on this breakdown’s money basis, so a value ranking would order an all-zero tie';

const CALLOFF_PARTIAL_NOTE =
  'call-offs are the REPORTED subsequent contracts under framework agreements (~63k reported vs ~828k frameworks) — framework execution is mostly unobserved, and call-off totals must never be summed with contract awards (double-counts framework spend)';

const FRAMEWORK_CEILING_NOTE =
  'framework ceilings are maximum committed amounts attributed once per framework identity — an upper bound on possible call-off spend, NOT money spent; mixed-value framework groups are quarantined and excluded from every figure; rankings/sliced ceiling totals are withheld until repeat-cluster disclosure lands (per-slice repeat uncertainty can reach ~22%)';

const MODIFICATION_COUNTS_NOTE =
  'modifications are amendment events, not purchases — this population serves counts only; usable amendment values reach analytics solely through the contract grain’s modification-adjusted measure';

const LEGACY_CONTRACT_POPULATION_NOTE =
  'temporary framework-role compatibility mode: contract analytics include standalone awards, framework ceilings and call-offs from the legacy build-8 population; these are legacy totals, not purchases-only spending, until the framework-role data build is published';

/** The money-build contract grain could not be read (PROC-KB0Z). */
const CA_MONEY_UNAVAILABLE = 'contract awards are unavailable: the money build could not be read';
/** A shape the money-build contract grain does not answer yet (PROC-KB0Z slice a). */
const CA_MONEY_SHAPE_UNSERVED =
  'this answer is not yet served for contract awards from the money build (stats and series are)';

const grainNotes = (
  grain: AnalysisGrain,
  capabilities: GenerationCapabilities
): readonly string[] =>
  grain === 'procedure'
    ? [PROCEDURE_LIFECYCLE_NOTE]
    : // No base build was read (legacy retired or unreadable): the grain abstains, so no build's
      // population is described.
      grain === 'contract' &&
        !capabilities.frameworkRole &&
        capabilities.analysisBaseUnavailable !== true
      ? [LEGACY_CONTRACT_POPULATION_NOTE]
      : grain === 'calloff'
        ? [CALLOFF_PARTIAL_NOTE]
        : grain === 'framework'
          ? [FRAMEWORK_CEILING_NOTE]
          : grain === 'modification'
            ? [MODIFICATION_COUNTS_NOTE]
            : [];

/**
 * The same words mean something different here than on the record list, and the
 * counts differ by orders of magnitude — `reparatii drumuri comunale` matched 1
 * record as a title substring and 14 as an all-words engine search. Disclosed
 * rather than reconciled: an aggregate that quietly used a different population
 * than the list it links to is worse than one that says so.
 */
const Q_TITLE_CAVEAT =
  'q filters on record titles (case-insensitive substring); title coverage is partial per grain, so untitled records are excluded from every figure. The record list reads the same q as a full-text search over titles, party names and identifiers, so its result count legitimately differs from these figures';

const VALUE_BOUNDS_CAVEAT =
  'value bounds restrict every figure (including counts) to records whose accepted awarded value falls in range';

/** Row-filter caveats — a scope q / value bound reshapes the population of EVERY figure. */
const rowFilterCaveats = (scope: AnalysisScope): readonly string[] => [
  ...(scope.q !== undefined ? [Q_TITLE_CAVEAT] : []),
  ...(scope.valueMin !== undefined || scope.valueMax !== undefined ? [VALUE_BOUNDS_CAVEAT] : []),
];

/**
 * The contract-grain populations a `frameworkRole` selects once the build
 * publishes the column, as the repo compiles them:
 *
 *  - absent  → the purchases-only DEFAULT: `framework_role IS NULL OR
 *              framework_role = 'standalone'` (standalone ∪ unstamped rows);
 *  - `'all'` → every row;
 *  - a role  → exactly that role (so `'standalone'` EXCLUDES unstamped rows).
 *
 * Containment therefore is: all ⊃ default ⊃ standalone; all ⊃ every other
 * role; default and the other roles are disjoint (Codex P2 on the first cut,
 * which had collapsed default and standalone into one population).
 */
type FrameworkRolePopulation = FrameworkRoleFilter | 'default';

const frameworkRolePopulation = (role: FrameworkRoleFilter | undefined): FrameworkRolePopulation =>
  role ?? 'default';

/** `inner` ⊆ `outer` under the containment above. */
const frameworkRolePopulationWithin = (
  numerator: FrameworkRoleFilter | undefined,
  denominator: FrameworkRoleFilter | undefined
): boolean => {
  const inner = frameworkRolePopulation(numerator);
  const outer = frameworkRolePopulation(denominator);
  if (outer === 'all') return true;
  if (inner === outer) return true;
  return outer === 'default' && inner === 'standalone';
};

/** `inner` ⊂ `outer` STRICTLY (a genuinely smaller population). */
const frameworkRolePopulationNarrows = (
  numerator: FrameworkRoleFilter | undefined,
  denominator: FrameworkRoleFilter | undefined
): boolean =>
  frameworkRolePopulationWithin(numerator, denominator) &&
  frameworkRolePopulation(numerator) !== frameworkRolePopulation(denominator);

/** Scope-derived caveats appended to every envelope of a shape. */
const scopeNotes = (
  grain: AnalysisGrain,
  scope: AnalysisScope,
  gen: ActiveGeneration
): readonly string[] => [
  ...rowFilterCaveats(scope),
  ...grainNotes(grain, gen.capabilities),
  ...sourceNotes(grain, gen.sourceCapture),
  ...(gen.notes ?? []),
  ...(grain === 'contract' &&
  gen.capabilities.contractMoneyV3 === true &&
  scope.supplierCui !== undefined
    ? [CA_MONEY_JOINT_NOTE]
    : []),
];

/** The stats read projected onto the envelope's fields. */
const readsOf = (read: AnalysisStatsRead): EnvelopeReads => ({
  rows: read.rows,
  withValue: read.withValue,
  undatedCount: read.undatedCount,
  undatedValueRon: read.undatedValueRon,
});

// Every grain declares a money-anchor entry (recordCount on the counts-only
// modification grain); it carries the stats block's value basis, date basis
// and terminality.
const statsPolicy = (grain: AnalysisGrain): PolicyEntry =>
  anchorPolicy(
    grain,
    moneyAnchorMeasure(grain) as 'recordCount' | 'valueAwardedSum' | 'valueCeilingSum'
  );

/** The basis of a grain's ANCHOR money (design v1.1): frameworks anchor on the ceiling. */
const anchorBasis = (grain: AnalysisGrain): ValueBasis =>
  grain === 'framework' ? 'ceiling' : 'awarded';

/** Generation + per-basis coverage rows, resolved ONCE per request. Coverage
 * failure degrades to undefined: awarded serving is unaffected; every
 * non-awarded basis and new-population verdict then abstains (fail-closed). */
const BUILD_PIN_RE = /^[1-9][0-9]{0,18}$/u;

/**
 * Resolve the active generation and, when the caller pinned one, prove it is
 * the same build. A page reads its figures, its rankings and its record list
 * in separate requests; a publication between them would otherwise answer
 * one page from two builds. Only the ACTIVE build is usable: a retired or
 * unknown pin is refused (field `build`) so the caller re-reads the active
 * build and starts over, never silently mixing generations.
 */
/** Static client text for a busy analytics backend (never an upstream message). */
const BUSY_MESSAGE = 'procurement analytics is busy; retry shortly';

const genWithCoverage = async (
  repo: AnalysisRepo,
  build?: string,
  /** The request's single grain, when it names one: a pin is checked against THAT grain's source. */
  grain?: AnalysisGrain
): Promise<
  Result<{ gen: ActiveGeneration; cov: readonly BasisCoverageRow[] | undefined }, ApiError>
> => {
  if (build !== undefined && !BUILD_PIN_RE.test(build)) {
    return err(invalidInput('build must be an analysis build id (digits)', 'build'));
  }
  const genR = await activeGen(repo);
  if (genR.isErr()) return err(genR.error);
  // A grain with its own source (direct acquisitions on procurement_v3) reads
  // neither the base generation nor its coverage. Any other grain answers a busy
  // base as retryable before its pin is checked: while the base is busy the
  // generation carries only the DA build, so the pin cannot be judged.
  const ownSource = grain !== undefined && genR.value.grainSources?.[grain] !== undefined;
  const baseBusy = genR.value.capabilities.analysisBaseBusyRetryAfterSeconds;
  if (!ownSource && baseBusy !== undefined) return err(busyRetryLater(BUSY_MESSAGE, baseBusy));
  // Two sources publish independently (ClickHouse and procurement_v3): one pin
  // cannot hold both, so a pinned request must name its grain.
  if (
    build !== undefined &&
    grain === undefined &&
    genR.value.grainSources !== undefined &&
    Object.keys(genR.value.grainSources).length > 0
  ) {
    return err(
      invalidInput(
        'a build pin needs scope.grain while direct acquisitions publish separately; pin one grain per request',
        'build'
      )
    );
  }
  const activeBuild =
    (grain === undefined ? undefined : genR.value.grainSources?.[grain]?.generation.buildId) ??
    genR.value.buildId;
  if (build !== undefined && build !== activeBuild) {
    return err(
      invalidInput(
        // The pin is never echoed: any 13 digits pass its form, a personal code included.
        `the pinned analysis build is not the active build (${activeBuild}); re-read the active build and repeat the request`,
        'build'
      )
    );
  }
  const covR = await repo.basisCoverage(genR.value.buildId);
  // Coverage is optional, but a busy refusal is retryable: a grain that needs
  // it answers that rather than gates computed without coverage.
  if (!ownSource && covR.isErr() && retryAfterSecondsOf(covR.error) !== undefined)
    return err(covR.error);
  return ok({ gen: genR.value, cov: covR.isOk() ? covR.value : undefined });
};

/**
 * The generation and coverage that answer `grain` in this request. A grain
 * served by another source (direct acquisitions on procurement_v3) carries its
 * own: its gates, envelope buildId, notes and reads all use it, so a block
 * never wears another source's verdict.
 */
const sourceFor = (
  gen: ActiveGeneration,
  cov: readonly BasisCoverageRow[] | undefined,
  grain: AnalysisGrain
): { gen: ActiveGeneration; cov: readonly BasisCoverageRow[] | undefined } => {
  const source = gen.grainSources?.[grain];
  return source === undefined ? { gen, cov } : { gen: source.generation, cov: source.coverage };
};

/**
 * The envelope of a block, stating the basis of the source that answered it:
 * the v3 DA grain is dated by finalization_day only (no publication fallback).
 */
const envelopeOn = (
  gen: ActiveGeneration,
  ...[policy, ...rest]: Parameters<typeof buildEnvelope>
): AnswerEnvelope => {
  const v3 = policy.grain === 'direct_acquisition' && gen.capabilities.directAcquisitionV3 === true;
  const caMoney = policy.grain === 'contract' && gen.capabilities.contractMoneyV3 === true;
  const envelope = buildEnvelope(
    v3
      ? { ...policy, dateBasis: 'finalization_day (direct acquisitions release 1)' }
      : caMoney
        ? { ...policy, dateBasis: 'award_day (contract conclusion, money build)' }
        : policy,
    ...rest
  );
  // D6 decides which supplier scopes the money-build contract grain reads, as on the DA grain.
  const disclosureKey =
    policy.grain === 'direct_acquisition' || caMoney ? (gen.disclosureKey ?? 'off') : null;
  // The amount fields keep their names; the structured basis says what they sum.
  return v3 && envelope.valueBasis === 'awarded'
    ? { ...envelope, valueBasis: 'counted', disclosureKey }
    : { ...envelope, disclosureKey };
};

/** AND-compose gate decisions: any abstain blocks; degradations and caveats merge. */
const composeGates = (decisions: readonly GateDecision[]): GateDecision => {
  const reason =
    decisions.find((decision) => !decision.allow && decision.reason !== undefined)?.reason ??
    decisions.find((decision) => decision.degraded && decision.reason !== undefined)?.reason;
  return {
    allow: decisions.every((decision) => decision.allow),
    degraded: decisions.some((decision) => decision.degraded),
    caveats: decisions.flatMap((decision) => decision.caveats),
    ...(reason === undefined ? {} : { reason }),
  };
};

/**
 * The gate classes a SHAPE must pass for a grain (design §5.4, S3): `time`
 * whenever the scope is time-bounded or the shape is a series; `geo` whenever
 * region geography is in the scope or is the breakdown dimension (buyer or
 * supplier — county/SIRUTA follow the same coverage class). Spend is NOT
 * here — it gates money fields/bases, not the shape.
 */
const shapeGate = (
  gen: ActiveGeneration,
  cov: readonly BasisCoverageRow[] | undefined,
  grain: AnalysisGrain,
  scope: AnalysisScope,
  options: {
    readonly isSeries?: boolean;
    readonly dimension?: BreakdownDimension;
    /** The shapes that do not read stats or a plain series (the money contract grain abstains). */
    readonly shape?: 'concentration' | 'records' | 'distinct';
  }
): GateDecision => {
  const decisions: GateDecision[] = [];
  if (grain === 'contract' && gen.capabilities.contractMoneyV3 === true) {
    if (gen.capabilities.contractMoneyV3Unavailable === true) {
      decisions.push({
        allow: false,
        degraded: false,
        caveats: [CA_MONEY_UNAVAILABLE],
        reason: 'MISSING_QUALITY_VERDICT',
      });
    } else if (options.dimension !== undefined || options.shape !== undefined) {
      decisions.push({
        allow: false,
        degraded: false,
        caveats: [CA_MONEY_SHAPE_UNSERVED],
        reason: 'GENERATION_LACKS_CAPABILITY',
      });
    }
  }
  if (grain !== 'direct_acquisition' && gen.capabilities.analysisBaseUnavailable === true) {
    decisions.push({
      allow: false,
      degraded: false,
      caveats: ['this grain is unavailable: the analytics build could not be read'],
      reason: 'MISSING_QUALITY_VERDICT',
    });
  }
  if (grain === 'direct_acquisition' && gen.capabilities.directAcquisitionV3Unavailable === true) {
    decisions.push({
      allow: false,
      degraded: false,
      caveats: [
        'direct acquisitions (release 1) are unavailable: their publication could not be read',
      ],
      reason: 'MISSING_QUALITY_VERDICT',
    });
  }
  if (options.isSeries === true || scopeWindow(scope) !== undefined) {
    decisions.push(decideAnswer(gen.quality, grain, 'time', cov));
  }
  // Every buyer/supplier geography level consults the geo verdict —
  // county/SIRUTA follow the same coverage class as regions (review F2).
  // The PARTY decides which coverage ratios the caveat may quote: supplier
  // surfaces never quote the buyer ratios (geo/disclosure finding 1). When
  // both parties are involved, buyer wins the text — its ratios exist on
  // every generation and the class is buyer-decided anyway.
  const buyerGeoInvolved =
    scope.buyerRegion !== undefined ||
    scope.buyerCounty !== undefined ||
    scope.buyerSiruta !== undefined ||
    (options.dimension !== undefined &&
      (['buyerRegion', 'buyerCounty', 'buyerSiruta'] as BreakdownDimension[]).includes(
        options.dimension
      ));
  const supplierGeoInvolved =
    scope.supplierRegion !== undefined ||
    scope.supplierCounty !== undefined ||
    scope.supplierSiruta !== undefined ||
    (options.dimension !== undefined &&
      (['supplierRegion', 'supplierCounty', 'supplierSiruta'] as BreakdownDimension[]).includes(
        options.dimension
      ));
  if (buyerGeoInvolved || supplierGeoInvolved) {
    decisions.push(
      decideAnswer(gen.quality, grain, 'geo', cov, buyerGeoInvolved ? 'buyer' : 'supplier')
    );
  }
  return composeGates(decisions);
};

/**
 * The grain's anchor-money gate, or null on counts-only grains (modification):
 * a null gate never joins envelope composition — counts serve cleanly instead
 * of wearing an irrelevant awarded-spend abstention (review F4).
 */
const anchorMoneyGate = (
  gen: ActiveGeneration,
  cov: readonly BasisCoverageRow[] | undefined,
  grain: AnalysisGrain
): GateDecision | null =>
  moneyAnchorMeasure(grain) === 'recordCount'
    ? null
    : decideMoney(gen.quality, cov, grain, anchorBasis(grain));

// ── stats ──────────────────────────────────────────────────────────────────────

/**
 * Association-withheld disclosure (user decision 2026-07-25; assoc review
 * finding 2): whenever a supplier-money read reports withheld consortium
 * mass, the envelope must say so with the scope-exact amount and share —
 * the buyer and supplier surfaces have to reconcile in front of the reader.
 * `withheldRon` is non-null ONLY on supplier-money reads (repo contract).
 */
const withheldCaveats = (
  withheldRon: string | null,
  servedRon: string | null
): readonly string[] => {
  if (withheldRon === null) return [];
  const withheld = d(withheldRon);
  if (!withheld.greaterThan(0)) return [];
  const attributed = withheld.plus(servedRon ?? '0');
  const share = attributed.greaterThan(0) ? withheld.div(attributed).mul(100).toFixed(1) : null;
  return [
    `supplier attribution: ${withheld.toFixed(MONEY_DP)} RON of ${attributed.toFixed(MONEY_DP)} RON awarded in this scope${share === null ? '' : ` (${share}%)`} belongs to multi-member consortium awards — the internal split is not published, so per-supplier money excludes it (withheld, never redistributed)`,
  ];
};

/** Dimensions whose breakdown reads supplier money regardless of scope. */
const SUPPLIER_KEYED_DIMS: ReadonlySet<BreakdownDimension> = new Set([
  'supplier',
  'supplierRegion',
  'supplierCounty',
  'supplierSiruta',
]);

const QUALITATIVE_ENTITY_WITHHELD =
  'per-supplier money for this supplier excludes any multi-member consortium awards it participates in — the internal split is not published and consortium mass is never attributed to individual members, so no withheld amount is quoted per entity (it would depend on the technical carrier election)';
const QUALITATIVE_BOUNDED_WITHHELD =
  'value-bounded supplier reads exclude multi-member consortium awards entirely — their per-supplier values are unpublished, so they cannot satisfy a value bound and no withheld amount is quoted';
const CARRIER_PLACEMENT_NOTE =
  "consortium withheld mass is counted in the region of the award's representative (carrier) member";

/**
 * How the withheld consortium mass is disclosed for a scope (user decisions
 * 2026-07-25, codex findings 4a/4b):
 *  - entity scopes (supplierCui) and value-bounded scopes are QUALITATIVE —
 *    the number would be carrier-dependent (4a) or silently collapsed (4b),
 *    so the caveat explains the exclusion without quoting an amount;
 *  - aggregate scopes stay NUMERIC (exact nationally; carrier-placed on
 *    supplier-geo slices, disclosed by the placement note).
 * Callers gate on moneyAllowed and grain==='contract' — only supplier-money
 * contract reads have a withheld population at all.
 */
const withheldDisclosure = (
  scope: AnalysisScope,
  withheldRon: string | null,
  servedRon: string | null
): { readonly ron: string | null; readonly caveats: readonly string[] } => {
  const qualitative: string[] = [
    ...(scope.supplierCui !== undefined ? [QUALITATIVE_ENTITY_WITHHELD] : []),
    ...(scope.valueMin !== undefined || scope.valueMax !== undefined
      ? [QUALITATIVE_BOUNDED_WITHHELD]
      : []),
  ];
  if (qualitative.length > 0) return { ron: null, caveats: qualitative };
  const numeric = withheldCaveats(withheldRon, servedRon);
  const placement =
    numeric.length > 0 &&
    (scope.supplierCounty !== undefined ||
      scope.supplierRegion !== undefined ||
      scope.supplierSiruta !== undefined)
      ? [CARRIER_PLACEMENT_NOTE]
      : [];
  return { ron: withheldRon, caveats: [...numeric, ...placement] };
};

/**
 * Typed abstention for the mod-adjusted basis under supplier-sliced scopes:
 * adjustments attach to the CONTRACT (attributed population), so a
 * supplier-money read has no mod-adjusted column to serve. The policy table
 * declares the measure legal; the SCOPE makes it unavailable — that is an
 * abstention with a reason, not a transport error.
 */
const SUPPLIER_SCOPE_NO_MOD_ADJUSTED: GateDecision = {
  allow: false,
  degraded: false,
  caveats: [
    'mod-adjusted money exists only for the attributed (buyer-side) population — supplier-scoped reads abstain on this basis (per-supplier adjustment splits are not published)',
  ],
  reason: 'GENERATION_LACKS_CAPABILITY',
};

const statsBlockFor = async (
  deps: AnalysisDeps,
  requestGen: ActiveGeneration,
  requestCov: readonly BasisCoverageRow[] | undefined,
  route: AnalysisRoute,
  scope: AnalysisScope,
  canonicalScope: string
): Promise<Result<AnalysisStatsBlock, ApiError>> => {
  const { grain } = route;
  const { gen, cov } = sourceFor(requestGen, requestCov, grain);
  // Per-basis money gates (design v1.1): each money field follows ITS OWN
  // basis verdict — bases never substitute for one another. The grain's
  // ANCHOR basis (awarded; ceiling on frameworks) also gates undated money;
  // the counts-only modification grain composes NO money gate (review F4).
  const spend = anchorMoneyGate(gen, cov, grain);
  const estGate =
    policyFor(grain, 'valueEstimatedSum') !== undefined
      ? decideMoney(gen.quality, cov, grain, 'estimated')
      : null;
  // Mod-adjusted money exists only at the ATTRIBUTED (buyer) grain; the
  // supplier-money profile deliberately omits it (mixing populations). A
  // supplier-scoped read must therefore ABSTAIN the basis with a typed
  // verdict — never publish a 'served' verdict beside a NULL value
  // (geo/disclosure review finding 5).
  const modGate =
    policyFor(grain, 'valueModAdjustedSum') !== undefined
      ? supplierScoped(scope)
        ? SUPPLIER_SCOPE_NO_MOD_ADJUSTED
        : decideMoney(gen.quality, cov, grain, 'modAdjusted')
      : null;
  const basisCaveats = [
    ...(estGate !== null && (estGate.degraded || !estGate.allow) ? estGate.caveats : []),
    ...(modGate !== null && (modGate.degraded || !modGate.allow) ? modGate.caveats : []),
  ];
  const verdictOf = (measure: MeasureId, gate: GateDecision): AnalysisMoneyVerdict => ({
    measure,
    answerability: gate.allow ? (gate.degraded ? 'degraded' : 'served') : 'abstained',
    reason: gate.reason ?? null,
    caveats: gate.caveats,
  });
  const moneyVerdicts: AnalysisMoneyVerdict[] = [
    ...(spend !== null
      ? [verdictOf(grain === 'framework' ? 'valueCeilingSum' : 'valueAwardedSum', spend)]
      : []),
    ...(estGate !== null ? [verdictOf('valueEstimatedSum', estGate)] : []),
    ...(modGate !== null ? [verdictOf('valueModAdjustedSum', modGate)] : []),
    // Same population as the adjusted basis ⇒ same verdict; publishing it
    // keeps the client from pairing a served baseline with an abstained total.
    ...(modGate !== null && policyFor(grain, 'valueAwardedMatchedSum') !== undefined
      ? [verdictOf('valueAwardedMatchedSum', modGate)]
      : []),
  ];
  const spendGates = spend !== null ? [spend] : [];
  const moneyAllowed = spend?.allow ?? false;
  const blockGate = shapeGate(gen, cov, grain, scope, {});

  // An abstaining time/geo class blocks the whole block for this grain — no read
  // happens and nothing is fabricated (envelope reads are null, not zero).
  if (!blockGate.allow) {
    return ok({
      grain,
      recordCount: null,
      withValueCount: null,
      withEstimatedCount: null,
      valueAwardedSum: null,
      valueEstimatedSum: null,
      valueCeilingSum: null,
      valueModAdjustedSum: null,
      valueAwardedMatchedSum: null,
      avgValueAwarded: null,
      valueWithheldAssociationSum: null,
      minMonth: null,
      maxMonth: null,
      moneyVerdicts,
      meta: envelopeOn(
        gen,
        statsPolicy(grain),
        composeGates([blockGate, ...spendGates]),
        gen.buildId,
        null,
        canonicalScope,
        moneyAllowed,
        scopeNotes(grain, scope, gen)
      ),
    });
  }

  const readR = await deps.analysisRepo.statsFor(route, scope, gen);
  if (readR.isErr()) return err(readR.error);
  const read = readR.value;

  // Money is null when its basis gate abstains AND when no valued rows were
  // observed — caveats distinguish the two; never coalesced to zero (S8).
  const awardedObserved = read.valueAwardedSum !== null;
  const awarded =
    moneyAllowed && awardedObserved ? d(read.valueAwardedSum).toFixed(MONEY_DP) : null;
  const estimated =
    estGate !== null && estGate.allow && read.valueEstimatedSum !== null
      ? d(read.valueEstimatedSum).toFixed(MONEY_DP)
      : null;
  const ceiling =
    grain === 'framework' && moneyAllowed && read.valueCeilingSum !== null
      ? d(read.valueCeilingSum).toFixed(MONEY_DP)
      : null;
  const modAdjusted =
    modGate !== null && modGate.allow && read.valueModAdjustedSum !== null
      ? d(read.valueModAdjustedSum).toFixed(MONEY_DP)
      : null;
  const awardedMatched =
    modGate !== null && modGate.allow && read.valueAwardedMatchedSum !== null
      ? d(read.valueAwardedMatchedSum).toFixed(MONEY_DP)
      : null;
  const withValue = d(read.withValue);
  const avg =
    awarded !== null && withValue.greaterThan(0)
      ? d(read.valueAwardedSum).div(withValue).toFixed(MONEY_DP)
      : null;
  const noValueCaveats =
    moneyAllowed && !awardedObserved && grain !== 'framework' && grain !== 'modification'
      ? [NO_AWARDED_VALUES_CAVEAT]
      : [];
  // Withheld consortium mass follows the SAME anchor gate as the money it
  // qualifies (it is awarded-basis mass) — never disclosed as a number when
  // the money itself is suppressed. Disclosure mode (numeric vs qualitative)
  // is decided by the scope shape (findings 4a/4b).
  // Only supplier-money reads have a withheld population (repo profile
  // election mirrors supplierScoped) — a buyer read under value bounds is
  // NOT affected and gets no consortium caveat.
  // The money build flags joint wins itself and totals quote their money per firm
  // (association_unattributed), so that source's amount is served as read (CA_MONEY_JOINT_NOTE).
  const withheldD =
    moneyAllowed && grain === 'contract' && supplierScoped(scope)
      ? gen.capabilities.contractMoneyV3 === true
        ? { ron: read.valueWithheldAssociationSum, caveats: [] as readonly string[] }
        : withheldDisclosure(scope, read.valueWithheldAssociationSum, read.valueAwardedSum)
      : { ron: null, caveats: [] as readonly string[] };
  const withheld = withheldD.ron !== null ? d(withheldD.ron).toFixed(MONEY_DP) : null;

  return ok({
    grain,
    recordCount: read.rows,
    withValueCount: read.withValue,
    withEstimatedCount: read.withEstimated,
    valueAwardedSum: awarded,
    valueEstimatedSum: estimated,
    valueCeilingSum: ceiling,
    valueModAdjustedSum: modAdjusted,
    valueAwardedMatchedSum: awardedMatched,
    avgValueAwarded: avg,
    valueWithheldAssociationSum: withheld,
    minMonth: read.minMonth,
    maxMonth: read.maxMonth,
    moneyVerdicts,
    meta: envelopeOn(
      gen,
      statsPolicy(grain),
      composeGates([blockGate, ...spendGates]),
      gen.buildId,
      readsOf(read),
      canonicalScope,
      moneyAllowed,
      [...noValueCaveats, ...basisCaveats, ...withheldD.caveats, ...scopeNotes(grain, scope, gen)]
    ),
  });
};

/** Stats over an ALREADY-RESOLVED generation (share/facets reuse it — S1). */
const statsWithGen = async (
  deps: AnalysisDeps,
  gen: ActiveGeneration,
  cov: readonly BasisCoverageRow[] | undefined,
  scope: AnalysisScope
): Promise<Result<AnalysisStatsResult, ApiError>> => {
  const routesR = (deps.routeAnalysis ?? routeAnalysis)(
    scope,
    'stats',
    undefined,
    undefined,
    gen.capabilities
  );
  if (routesR.isErr()) return err(routesR.error);
  const canonicalScope = await echoScope(deps, scope, gen);

  const blocks: AnalysisStatsBlock[] = [];
  for (const route of routesR.value) {
    const blockR = await statsBlockFor(deps, gen, cov, route, scope, canonicalScope);
    if (blockR.isErr()) return err(blockR.error);
    blocks.push(blockR.value);
  }
  return ok({ blocks });
};

/** `procurementStats` — labeled per-grain blocks; no cross-grain sum exists. */
export const analysisStats = async (
  deps: AnalysisDeps,
  input: { readonly scope: AnalysisScope; readonly build?: string }
): Promise<Result<AnalysisStatsResult, ApiError>> => {
  const gcR = await genWithCoverage(deps.analysisRepo, input.build, input.scope.grain);
  if (gcR.isErr()) return err(gcR.error);
  return statsWithGen(deps, gcR.value.gen, gcR.value.cov, input.scope);
};

// ── series ─────────────────────────────────────────────────────────────────────

/** 'YYYY-MM' → the requested bucket label ('YYYY-MM' | 'YYYY-Qn' | 'YYYY'). */
const bucketLabel = (month: string, bucket: SeriesBucket): string => {
  if (bucket === 'month') return month;
  const year = month.slice(0, 4);
  if (bucket === 'year') return year;
  const q = Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1;
  return `${year}-Q${String(q)}`;
};

export const analysisSeries = async (
  deps: AnalysisDeps,
  input: {
    readonly scope: AnalysisScope;
    readonly bucket: SeriesBucket;
    readonly measure: MeasureId;
    readonly build?: string;
  }
): Promise<Result<readonly AnalysisSeriesBlock[], ApiError>> => {
  const { scope, bucket, measure } = input;

  if (scope.grain !== undefined && policyFor(scope.grain, measure) === undefined) {
    return err(
      invalidInput(
        `measure '${measure}' is not declared for grain '${scope.grain}' (see the policy table)`,
        'measure'
      )
    );
  }

  // The generation first: routing needs its live capabilities.
  const gcR = await genWithCoverage(deps.analysisRepo, input.build, scope.grain);
  if (gcR.isErr()) return err(gcR.error);
  const requestGen = gcR.value.gen;
  const requestCov = gcR.value.cov;
  const routesR = (deps.routeAnalysis ?? routeAnalysis)(
    scope,
    'series',
    undefined,
    measure,
    requestGen.capabilities
  );
  if (routesR.isErr()) return err(routesR.error);
  const canonicalScope = await echoScope(deps, scope, requestGen);

  const blocks: AnalysisSeriesBlock[] = [];
  for (const route of routesR.value) {
    const { grain } = route;
    const { gen, cov } = sourceFor(requestGen, requestCov, grain);
    const policy = policyFor(grain, measure);
    if (policy === undefined) continue; // implicit grain without the measure
    if (!policy.legalShapes.includes('series')) {
      return err(
        invalidInput(
          `measure '${measure}' is not legal for shape 'series' (legal shapes: ${policy.legalShapes.join(', ')})`,
          'measure'
        )
      );
    }

    // A supplier-sliced scope has no mod-adjusted column (attributed-only
    // population) — substitute the typed abstention BEFORE gate composition
    // so the request abstains instead of reaching the repo and erroring
    // (geo/disclosure review finding 5).
    const spend =
      policy.valueBasis === 'modAdjusted' && supplierScoped(scope)
        ? SUPPLIER_SCOPE_NO_MOD_ADJUSTED
        : decideMoney(gen.quality, cov, grain, policy.valueBasis ?? anchorBasis(grain));
    const blockedBlock = (gated: GateDecision): AnalysisSeriesBlock => ({
      grain,
      measure,
      bucket,
      points: [],
      meta: envelopeOn(
        gen,
        policy,
        gated,
        gen.buildId,
        null,
        canonicalScope,
        spend.allow,
        scopeNotes(grain, scope, gen)
      ),
    });

    // Structurally blocked time answers (procedure grain until M1).
    if (policy.blocked !== undefined) {
      const caveat = `${policy.policyKey}: time answers are blocked (${policy.blocked.reason}; unblocks at ${policy.blocked.milestone})`;
      blocks.push(
        blockedBlock({
          allow: false,
          degraded: false,
          caveats: [caveat],
          reason: 'GENERATION_LACKS_CAPABILITY',
        })
      );
      continue;
    }

    const gated = composeGates([
      shapeGate(gen, cov, grain, scope, {
        isSeries: true,
        ...(policy.law === 'distinct' && { shape: 'distinct' as const }),
      }),
      ...(policy.gateClass === 'spend' ? [spend] : []),
    ]);
    if (!gated.allow) {
      blocks.push(blockedBlock(gated));
      continue;
    }

    if (policy.law === 'distinct') {
      const key = measure === 'distinctSuppliers' ? 'supplier' : 'authority';
      const rowsR = await deps.analysisRepo.distinctSeriesFor(route, scope, gen, key, bucket);
      if (rowsR.isErr()) return err(rowsR.error);
      const rows = rowsR.value;
      const undated = rows.find((r) => r.bucket === null);
      const reads: EnvelopeReads = {
        rows: rows.reduce((acc, r) => acc.plus(r.recordCount), new Decimal(0)).toFixed(0),
        withValue: rows.reduce((acc, r) => acc.plus(r.withValue), new Decimal(0)).toFixed(0),
        undatedCount: undated?.recordCount ?? '0',
        undatedValueRon: undated?.valueAwardedSum ?? null,
      };
      blocks.push({
        grain,
        measure,
        bucket,
        points: rows.flatMap((r) =>
          r.bucket === null ? [] : [{ bucket: r.bucket, value: r.value }]
        ),
        meta: envelopeOn(gen, policy, gated, gen.buildId, reads, canonicalScope, spend.allow, [
          'distinct counts are computed per bucket and must never be summed across buckets',
          ...scopeNotes(grain, scope, gen),
        ]),
      });
      continue;
    }

    // Additive law: monthly storage; quarter/year derived here, and ONLY here.
    const rowsR = await deps.analysisRepo.seriesFor(route, scope, gen, measure);
    if (rowsR.isErr()) return err(rowsR.error);
    const rows = rowsR.value;
    const undated = rows.find((r) => r.month === null);

    // A bucket whose contributing months all report null stays null (unobserved
    // money, S8) — only observed values are summed.
    const byBucket = new Map<string, Decimal | null>();
    for (const row of rows) {
      if (row.month === null) continue;
      const label = bucketLabel(row.month, bucket);
      const previous = byBucket.has(label) ? (byBucket.get(label) ?? null) : null;
      if (row.value === null) {
        if (!byBucket.has(label)) byBucket.set(label, null);
        continue;
      }
      byBucket.set(label, (previous ?? new Decimal(0)).plus(row.value));
    }
    const isMoney = policy.valueBasis !== null;
    const points: AnalysisSeriesPoint[] = [...byBucket.entries()].map(([label, value]) => ({
      bucket: label,
      value: value !== null ? value.toFixed(isMoney ? MONEY_DP : 0) : null,
    }));

    const reads: EnvelopeReads = {
      rows: rows.reduce((acc, r) => acc.plus(r.recordCount), new Decimal(0)).toFixed(0),
      withValue: rows.reduce((acc, r) => acc.plus(r.withValue), new Decimal(0)).toFixed(0),
      undatedCount: undated?.recordCount ?? '0',
      undatedValueRon: undated?.valueAwardedSum ?? null,
    };

    // Supplier-money series exclude the withheld consortium mass exactly like
    // stats/breakdown do — the envelope must say so here too (geo/disclosure
    // review finding 2). Qualitative scopes (entity / value-bounded, findings
    // 4a/4b) get their caveat WITHOUT the extra stats read; numeric scopes
    // fetch the scope-total withheld with one extra stats read.
    const supplierMoneySeries =
      grain === 'contract' &&
      supplierScoped(scope) &&
      policy.gateClass === 'spend' &&
      (policy.valueBasis ?? anchorBasis(grain)) === 'awarded';
    let seriesWithheldCaveats: readonly string[] = [];
    if (supplierMoneySeries) {
      const qualitative = withheldDisclosure(scope, null, null);
      if (qualitative.caveats.length > 0) {
        seriesWithheldCaveats = qualitative.caveats;
      } else {
        const statsR = await deps.analysisRepo.statsFor(route, scope, gen);
        if (statsR.isErr()) return err(statsR.error);
        seriesWithheldCaveats = withheldDisclosure(
          scope,
          statsR.value.valueWithheldAssociationSum,
          statsR.value.valueAwardedSum
        ).caveats;
      }
    }

    blocks.push({
      grain,
      measure,
      bucket,
      points,
      meta: envelopeOn(gen, policy, gated, gen.buildId, reads, canonicalScope, spend.allow, [
        ...seriesWithheldCaveats,
        ...scopeNotes(grain, scope, gen),
      ]),
    });
  }
  return ok(blocks);
};

// ── breakdown ──────────────────────────────────────────────────────────────────

/** SIRUTA breakdowns may request every UAT bucket (full-country map paint). */
const SIRUTA_DIMS: ReadonlySet<BreakdownDimension> = new Set(['buyerSiruta', 'supplierSiruta']);

const topNMaxFor = (dimensions: readonly BreakdownDimension[]): number =>
  dimensions.some((dim) => SIRUTA_DIMS.has(dim)) ? TOPN_SIRUTA_MAX : TOPN_MAX;

const normalizeTopN = (
  topN: number | undefined,
  maxTopN: number = TOPN_MAX
): Result<number, ApiError> => {
  if (topN === undefined) return ok(TOPN_DEFAULT);
  if (!Number.isInteger(topN) || topN < 1 || topN > maxTopN) {
    return err(invalidInput(`topN must be an integer from 1 to ${String(maxTopN)}`, 'topN'));
  }
  return ok(topN);
};

const breakdownBlockFor = async (
  deps: AnalysisDeps,
  requestGen: ActiveGeneration,
  requestCov: readonly BasisCoverageRow[] | undefined,
  route: AnalysisRoute,
  scope: AnalysisScope,
  dimension: BreakdownDimension,
  topN: number,
  canonicalScope: string,
  rankByReq?: 'value' | 'count'
): Promise<Result<AnalysisBreakdownBlock, ApiError>> => {
  const { grain } = route;
  const { gen, cov } = sourceFor(requestGen, requestCov, grain);
  // The ranking money is the grain's ANCHOR basis (ceiling on frameworks);
  // the counts-only modification grain has NO money gate (spend = null).
  const spend = anchorMoneyGate(gen, cov, grain);
  const blockGate = shapeGate(gen, cov, grain, scope, { dimension });
  const spendGates = spend !== null ? [spend] : [];
  const moneyAllowed = spend?.allow ?? false;

  // An explicit count request always ranks by count; value (explicit or the
  // default) still yields to the money gate — never rank by suppressed money.
  const requestedRankedBy: 'value' | 'count' =
    rankByReq === 'count' || spend === null ? 'count' : spend.allow ? 'value' : 'count';
  const gateSuppressedRank =
    requestedRankedBy === 'count' && rankByReq !== 'count' && spend !== null;
  const rankPolicy = (basis: 'value' | 'count'): PolicyEntry =>
    anchorPolicy(
      grain,
      basis === 'value'
        ? (moneyAnchorMeasure(grain) as 'valueAwardedSum' | 'valueCeilingSum' | 'recordCount')
        : 'recordCount'
    );

  if (!blockGate.allow) {
    return ok({
      grain,
      dimension,
      rankedBy: requestedRankedBy,
      buckets: [],
      valueWithheldAssociationSum: null,
      meta: envelopeOn(
        gen,
        rankPolicy(requestedRankedBy),
        composeGates([blockGate, ...spendGates]),
        gen.buildId,
        null,
        canonicalScope,
        moneyAllowed,
        scopeNotes(grain, scope, gen)
      ),
    });
  }

  const readR = await deps.analysisRepo.breakdownFor(
    route,
    scope,
    gen,
    dimension,
    topN,
    requestedRankedBy
  );
  if (readR.isErr()) return err(readR.error);
  const { buckets, totals } = readR.value;
  // The repo may downgrade a value ranking to counts when the scope holds no
  // value-bearing row on THIS breakdown's money basis (an all-zero ORDER BY is
  // not a value ranking). It re-ranks before the top-N cut, so the population
  // below IS the count-ranked one — the block follows the read, never the ask.
  const rankedBy = readR.value.rankedBy;
  const rankCaveats = [
    ...(gateSuppressedRank ? ['ranked by record count (money ranking is gate-suppressed)'] : []),
    ...(requestedRankedBy === 'value' && rankedBy === 'count' ? [NO_VALUE_TO_RANK_CAVEAT] : []),
  ];
  const policy = rankPolicy(rankedBy);

  // Reconciliation by construction (design §3.3): the three bucket kinds must sum
  // exactly to the same read's totals. A mismatch is an internal fault. Null money
  // sums count as zero for the arithmetic (they carry no observed value).
  // The port-level bucket money field carries the grain's ANCHOR money.
  const anchorTotal = grain === 'framework' ? totals.valueCeilingSum : totals.valueAwardedSum;
  const sum = (pick: (b: (typeof buckets)[number]) => string | null): Decimal =>
    buckets.reduce((acc, b) => acc.plus(pick(b) ?? '0'), new Decimal(0));
  const rowsOk = sum((b) => b.recordCount).equals(d(totals.rows));
  const withValueOk = sum((b) => b.withValue).equals(d(totals.withValue));
  const moneyOk = !moneyAllowed || sum((b) => b.valueAwardedSum).equals(d(anchorTotal));
  if (!rowsOk || !withValueOk || !moneyOk) {
    return err(
      databaseError(
        `breakdown(${dimension}) reconciliation failed for grain '${grain}': top+other+unknown do not sum to the scope totals (internal error)`
      )
    );
  }

  const basisTotal = rankedBy === 'value' ? d(anchorTotal) : d(totals.rows);
  // D6 kinds on DA supplier buckets: the v3 source always applies D6; ClickHouse when enforced.
  const supplierKinds =
    route.grain === 'direct_acquisition' &&
    dimension === 'supplier' &&
    (deps.supplierDisclosure?.enforced === true || gen.capabilities.directAcquisitionV3 === true);
  // The names of the company buckets, gated by supplier_name_public, read for this answer only, in
  // the publication the buckets came from. Only the v3 grain names suppliers (the ClickHouse D6
  // path refuses DA supplier breakdowns, and its keys are not that publication's).
  // A DA supplier keyed by a person's code (should the serving data ever disclose one): the whole
  // breakdown is refused, naming no code. Relabelling after ranking would still serve per-person
  // totals and rankings (kernel P0 containment).
  if (
    supplierKinds &&
    buckets.some(
      (b) =>
        b.key !== null &&
        b.key !== DA_NATURAL_PERSON_BUCKET &&
        isWithheldOrganizationIdentifier(b.key)
    )
  ) {
    return err(
      databaseError(
        'Direct-acquisition supplier breakdown refused: the serving data discloses a supplier code that is not an organization identifier.'
      )
    );
  }
  const companyCodes =
    supplierKinds && gen.capabilities.directAcquisitionV3 === true
      ? buckets.flatMap((b) =>
          b.kind === 'top' && b.key !== null && b.key !== DA_NATURAL_PERSON_BUCKET ? [b.key] : []
        )
      : [];
  let names: ReadonlyMap<string, SupplierNaming> = new Map();
  if (companyCodes.length > 0 && deps.daSupplierNames !== undefined) {
    const read = await deps.daSupplierNames.namesOf(gen.buildId, companyCodes);
    if (read.isErr()) return err(read.error);
    names = read.value;
  }
  // A ranked supplier whose code the names view may not show: the whole breakdown is refused,
  // naming no code (as for a person's code above), never relabelled after ranking.
  if (companyCodes.some((code) => names.get(code)?.kind === 'hidden')) {
    return err(
      databaseError(
        'Direct-acquisition supplier breakdown refused: the serving data ranks a supplier whose code may not be shown.'
      )
    );
  }
  const outBuckets: AnalysisBreakdownBucket[] = buckets.map((b) => {
    const basisValue = rankedBy === 'value' ? d(b.valueAwardedSum) : d(b.recordCount);
    // Null-law (review F7): a bucket with NO valued rows emits null money —
    // the repo's reconciliation zero is internal, never an observed value.
    const money =
      moneyAllowed && b.valueAwardedSum !== null && b.withValue !== '0'
        ? d(b.valueAwardedSum).toFixed(MONEY_DP)
        : null;
    return {
      key: b.key,
      kind: b.kind,
      recordCount: b.recordCount,
      withValueCount: b.withValue,
      // valueAwardedSum stays awarded-only: on grains whose anchor money is a
      // DIFFERENT basis (frameworks → ceiling) it is null, never relabeled.
      valueAwardedSum: anchorBasis(grain) === 'awarded' ? money : null,
      valueSum: money,
      shareOfScope: basisTotal.greaterThan(0) ? basisValue.div(basisTotal).toFixed(RATIO_DP) : null,
      ...(supplierKinds &&
        b.kind === 'top' && {
          ...bucketNaming(b.key, names),
        }),
    };
  });

  const answerGate = composeGates([blockGate, ...spendGates]);
  const gate: GateDecision = {
    ...answerGate,
    caveats: [...answerGate.caveats, ...rankCaveats],
  };
  // Disclosure mode by scope shape (findings 4a/4b); the withheld population
  // exists only when this breakdown reads supplier money (supplier-scoped
  // request or supplier-keyed dimension — mirrors the repo's election).
  const supplierMoneyRead =
    grain === 'contract' && (supplierScoped(scope) || SUPPLIER_KEYED_DIMS.has(dimension));
  const withheldD =
    moneyAllowed && supplierMoneyRead
      ? withheldDisclosure(scope, totals.valueWithheldAssociationSum, totals.valueAwardedSum)
      : { ron: null, caveats: [] as readonly string[] };
  return ok({
    grain,
    dimension,
    rankedBy,
    buckets: outBuckets,
    valueWithheldAssociationSum: withheldD.ron !== null ? d(withheldD.ron).toFixed(MONEY_DP) : null,
    meta: envelopeOn(
      gen,
      policy,
      gate,
      gen.buildId,
      readsOf(totals),
      canonicalScope,
      moneyAllowed,
      [...withheldD.caveats, ...scopeNotes(grain, scope, gen)]
    ),
  });
};

/**
 * A DA supplier bucket's kind and name (PROC-B51G, naming step 2): the one withheld bucket is
 * `natural_person`; a disclosed supplier takes its naming (`core/supplier-naming.ts`), or is a
 * `company` with no name where no naming was read (the ClickHouse D6 path).
 */
const bucketNaming = (
  key: string | null,
  names: ReadonlyMap<string, SupplierNaming>
): { displayKind: ServedSupplierKind | 'natural_person'; displayName: string | null } => {
  if (key === DA_NATURAL_PERSON_BUCKET) return { displayKind: 'natural_person', displayName: null };
  const naming = key === null ? undefined : names.get(key);
  if (naming === undefined) return { displayKind: 'company', displayName: null };
  // Refused before the buckets are built; never served with its code.
  if (naming.kind === 'hidden') return { displayKind: 'natural_person', displayName: null };
  return { displayKind: naming.kind, displayName: servedSupplierName(naming) };
};

export const analysisBreakdown = async (
  deps: AnalysisDeps,
  input: {
    readonly scope: AnalysisScope;
    readonly dimension: BreakdownDimension;
    readonly topN?: number;
    readonly rankBy?: 'value' | 'count';
    readonly build?: string;
  }
): Promise<Result<readonly AnalysisBreakdownBlock[], ApiError>> => {
  const topNR = normalizeTopN(input.topN, topNMaxFor([input.dimension]));
  if (topNR.isErr()) return err(topNR.error);
  const topN = topNR.value;
  // The generation first: routing needs its live capabilities.
  const gcR = await genWithCoverage(deps.analysisRepo, input.build, input.scope.grain);
  if (gcR.isErr()) return err(gcR.error);
  const routesR = (deps.routeAnalysis ?? routeAnalysis)(
    input.scope,
    'breakdown',
    input.dimension,
    undefined,
    gcR.value.gen.capabilities
  );
  if (routesR.isErr()) return err(routesR.error);
  const canonicalScope = await echoScope(deps, input.scope, gcR.value.gen);

  const blocks: AnalysisBreakdownBlock[] = [];
  for (const route of routesR.value) {
    const blockR = await breakdownBlockFor(
      deps,
      gcR.value.gen,
      gcR.value.cov,
      route,
      input.scope,
      input.dimension,
      topN,
      canonicalScope,
      input.rankBy
    );
    if (blockR.isErr()) return err(blockR.error);
    blocks.push(blockR.value);
  }
  return ok(blocks);
};

// ── concentration ──────────────────────────────────────────────────────────────

export const analysisConcentration = async (
  deps: AnalysisDeps,
  input: {
    readonly scope: AnalysisScope;
    readonly basis?: 'value' | 'count';
    readonly build?: string;
  }
): Promise<Result<readonly AnalysisConcentrationBlock[], ApiError>> => {
  // The generation first: routing needs its live capabilities.
  const gcR = await genWithCoverage(deps.analysisRepo, input.build, input.scope.grain);
  if (gcR.isErr()) return err(gcR.error);
  const requestGen = gcR.value.gen;
  const requestCov = gcR.value.cov;
  const routesR = (deps.routeAnalysis ?? routeAnalysis)(
    input.scope,
    'concentration',
    undefined,
    undefined,
    requestGen.capabilities
  );
  if (routesR.isErr()) return err(routesR.error);
  const canonicalScope = await echoScope(deps, input.scope, requestGen);

  const blocks: AnalysisConcentrationBlock[] = [];
  for (const route of routesR.value) {
    const { grain } = route;
    const { gen, cov } = sourceFor(requestGen, requestCov, grain);
    const spend = decideMoney(gen.quality, cov, grain, anchorBasis(grain));
    const basis: 'value' | 'count' = input.basis ?? 'count';
    const policy = anchorPolicy(grain, basis === 'value' ? 'valueAwardedSum' : 'recordCount');

    const blockGate = shapeGate(gen, cov, grain, input.scope, { shape: 'concentration' });
    const requestedGate = basis === 'value' ? composeGates([blockGate, spend]) : blockGate;
    if (!requestedGate.allow) {
      blocks.push({
        grain,
        basis,
        supplierCount: null,
        top1Share: null,
        top5Share: null,
        hhi: null,
        totalRon: null,
        valueWithheldAssociationSum: null,
        meta: envelopeOn(
          gen,
          policy,
          requestedGate,
          gen.buildId,
          null,
          canonicalScope,
          basis === 'value' && spend.allow,
          scopeNotes(grain, input.scope, gen)
        ),
      });
      continue;
    }

    const readR = await deps.analysisRepo.concentrationFor(route, input.scope, gen, basis);
    if (readR.isErr()) return err(readR.error);
    const {
      supplierCount,
      positiveSupplierCount,
      measureTotal,
      top1Measure,
      top5Measure,
      measureSquaredSum,
      totals,
      unknownSupplierMeasure,
    } = readR.value;

    // supplierCount = distinct KNOWN suppliers in scope; HHI/top shares are
    // computed over the positive-basis subset only. ClickHouse returns exact
    // aggregate scalars; core retains the business calculation and rounding.
    const total = new Decimal(measureTotal);
    const top1 = new Decimal(top1Measure);
    const top5 = new Decimal(top5Measure);
    const hhi = total.greaterThan(0) ? new Decimal(measureSquaredSum).div(total.pow(2)) : null;

    // Concentration always runs on supplier money: HHI/top shares are computed
    // over the ATTRIBUTABLE mass only — the withheld share is disclosed (as a
    // structured amount AND in prose) so nobody reads them as shares of all
    // awarded money, and no surface has to call the remainder "supplier
    // unidentified". The NUMBER follows the spend gate: a count-basis request
    // while spend abstains must not leak gate-suppressed money (review finding
    // 3) — basis=value only reaches here with spend allowed (composed gate).
    // `totals.valueWithheldAssociationSum` is a supplier-money-read field, so
    // it is null on every grain but contract (repo profile contract).
    const withheldD = spend.allow
      ? withheldDisclosure(input.scope, totals.valueWithheldAssociationSum, totals.valueAwardedSum)
      : {
          ron: null,
          caveats:
            totals.valueWithheldAssociationSum !== null &&
            d(totals.valueWithheldAssociationSum).greaterThan(0)
              ? [
                  'per-supplier money in this scope excludes multi-member consortium awards (split unpublished); the amount is not quoted because spend answers abstain for this grain',
                ]
              : [],
        };

    const basisLabel = basis === 'value' ? 'awarded value' : 'record count';
    const semanticsCaveats = [
      ...withheldD.caveats,
      `HHI/top shares are computed over known suppliers with positive ${basisLabel} (${String(positiveSupplierCount)} of ${String(supplierCount)} known suppliers)`,
      ...(unknownSupplierMeasure !== null && d(unknownSupplierMeasure).greaterThan(0)
        ? [
            `records with an unknown supplier are excluded from concentration and hold ${unknownSupplierMeasure} of ${basisLabel} in scope`,
          ]
        : []),
    ];

    blocks.push({
      grain,
      basis,
      supplierCount,
      top1Share: total.greaterThan(0) ? top1.div(total).toFixed(RATIO_DP) : null,
      top5Share: total.greaterThan(0) ? top5.div(total).toFixed(RATIO_DP) : null,
      hhi: hhi !== null ? hhi.toFixed(RATIO_DP) : null,
      // Null (not zero) when no positive-basis supplier was observed (S8).
      totalRon: basis === 'value' && positiveSupplierCount > 0 ? total.toFixed(MONEY_DP) : null,
      valueWithheldAssociationSum:
        withheldD.ron !== null ? d(withheldD.ron).toFixed(MONEY_DP) : null,
      meta: envelopeOn(
        gen,
        policy,
        {
          allow: true,
          degraded: blockGate.degraded,
          caveats: blockGate.caveats,
          ...(blockGate.reason === undefined ? {} : { reason: blockGate.reason }),
        },
        gen.buildId,
        readsOf(totals),
        canonicalScope,
        basis === 'value' && spend.allow,
        [...semanticsCaveats, ...scopeNotes(grain, input.scope, gen)]
      ),
    });
  }
  return ok(blocks);
};

// ── share (a validated derivation over two stats reads, design §3.3) ───────────

export const analysisShare = async (
  deps: AnalysisDeps,
  input: {
    readonly numerator: AnalysisScope;
    readonly denominator: AnalysisScope;
    readonly build?: string;
  }
): Promise<Result<AnalysisShareResult, ApiError>> => {
  const { numerator, denominator } = input;

  if (numerator.grain === undefined || numerator.grain !== denominator.grain) {
    return err(
      invalidInput(
        'share requires the same EXPLICIT grain on both operands (money never mixes across grains)',
        'grain'
      )
    );
  }
  if (numerator.grain === 'modification') {
    return err(
      invalidInput(
        'the modification population is counts-only — no money share is derivable',
        'grain'
      )
    );
  }
  // Periods compare via the NORMALIZED window: year 2024 == from 2024-01 to 2024-12.
  if (!sameWindow(numerator, denominator)) {
    return err(
      invalidInput('share operands must cover an identical period (from/to/year)', 'numerator')
    );
  }
  // ONE generation pins BOTH operands (S1) — a cutover between the two stats
  // reads cannot produce a cross-build ratio — and its live capabilities
  // decide how frameworkRole compares below.
  const gcR = await genWithCoverage(deps.analysisRepo, input.build, numerator.grain);
  if (gcR.isErr()) return err(gcR.error);
  const { gen, cov } = gcR.value;
  // STRICT subset: every denominator constraint set identically on the numerator,
  // AND at least one additional numerator constraint — identical scopes are a
  // tautology (share 1), not a derivation. Row filters (q/value bounds) count
  // as narrowing constraints exactly like dimensions.
  //
  // frameworkRole is the one field whose PRESENCE can widen rather than narrow
  // (`'all'` lifts the purchases-only default), so once the build publishes
  // the column it is compared as a population, not as a field (Codex P1):
  // the numerator's effective role must sit inside the denominator's, and only
  // a genuinely smaller role counts as narrowing. Without a base build (legacy
  // retired, or unreadable) the role keeps that meaning: the request is judged
  // as the role-publishing build would judge it, and its grain then abstains.
  const roleAware =
    (gen.capabilities.frameworkRole || gen.capabilities.analysisBaseUnavailable === true) &&
    numerator.grain === 'contract';
  const { frameworkRole: numRole, ...numerWithoutRole } = numerator;
  const { frameworkRole: denRole, ...denomWithoutRole } = denominator;
  const subsetNum = roleAware ? numerWithoutRole : numerator;
  const subsetDen = roleAware ? denomWithoutRole : denominator;
  const roleWithin = !roleAware || frameworkRolePopulationWithin(numRole, denRole);
  const roleNarrows = roleAware && frameworkRolePopulationNarrows(numRole, denRole);
  const constraintCount = (scope: AnalysisScope): number =>
    scopeDims(scope).length + scopeRowFilters(scope).length;
  if (
    !roleWithin ||
    !isSubsetScope(subsetNum, subsetDen) ||
    constraintCount(subsetNum) + (roleNarrows ? 1 : 0) <= constraintCount(subsetDen)
  ) {
    return err(
      invalidInput(
        'numerator scope must be a STRICT subset of the denominator scope: every denominator constraint set identically on the numerator, plus at least one narrower constraint',
        'numerator'
      )
    );
  }

  // The grain's ANCHOR money drives the ratio (ceiling on frameworks).
  const numeratorSource = sourceFor(gen, cov, numerator.grain);
  const spend = decideMoney(
    numeratorSource.gen.quality,
    numeratorSource.cov,
    numerator.grain,
    anchorBasis(numerator.grain)
  );
  const anchorMoneyOf = (block: AnalysisStatsBlock): string | null =>
    numerator.grain === 'framework' ? block.valueCeilingSum : block.valueAwardedSum;
  const [numR, denR] = await Promise.all([
    statsWithGen(deps, gen, cov, numerator),
    statsWithGen(deps, gen, cov, denominator),
  ]);
  if (numR.isErr()) return err(numR.error);
  if (denR.isErr()) return err(denR.error);
  const numBlock = numR.value.blocks[0];
  const denBlock = denR.value.blocks[0];
  if (numBlock === undefined || denBlock === undefined) {
    return err(invalidInput('share operands did not resolve to a servable grain', 'numerator'));
  }
  if (!spend.allow) {
    return ok({
      share: null,
      answerability: 'abstained',
      reason: spend.reason ?? 'SPEND_COVERAGE_BELOW_GATE',
      numerator: numBlock,
      denominator: denBlock,
      caveats: spend.caveats,
    });
  }
  if (numBlock.meta.counts === null || denBlock.meta.counts === null) {
    const blocked = numBlock.meta.counts === null ? numBlock : denBlock;
    return ok({
      share: null,
      answerability: 'abstained',
      reason: blocked.meta.reason ?? 'MISSING_QUALITY_VERDICT',
      numerator: numBlock,
      denominator: denBlock,
      caveats: [
        `the ${blocked === numBlock ? 'numerator' : 'denominator'} stats block abstained`,
        ...blocked.meta.caveats,
      ],
    });
  }

  const degradedOperand = [numBlock, denBlock].find(
    (block) => block.meta.answerability === 'degraded'
  );
  const caveats: string[] = degradedOperand === undefined ? [] : [...degradedOperand.meta.caveats];
  let share: string | null = null;
  const numMoney = anchorMoneyOf(numBlock);
  const denMoney = anchorMoneyOf(denBlock);
  if (denMoney === null || numMoney === null) {
    caveats.push(
      `${denMoney === null ? 'denominator' : 'numerator'} has no observed anchor-money values in scope — no ratio is derivable`
    );
  } else {
    const den = new Decimal(denMoney);
    if (den.greaterThan(0)) {
      share = new Decimal(numMoney).div(den).toFixed(RATIO_DP);
    } else {
      caveats.push('denominator has zero anchor-money value in scope — no ratio is derivable');
    }
  }
  return ok({
    share,
    answerability: degradedOperand === undefined ? 'served' : 'degraded',
    ...(degradedOperand?.meta.reason == null ? {} : { reason: degradedOperand.meta.reason }),
    numerator: numBlock,
    denominator: denBlock,
    caveats,
  });
};

// ── facets (batched breakdowns, one resolver round trip) ──────────────────────

/**
 * Statement budget (design §7.0): one micro-cached generation pointer read +
 * at most `FACET_DIMENSIONS_MAX` breakdown statements — which is why facets
 * require an EXPLICIT grain (an implicit grain would multiply the reads per
 * grain and blow the ≤4-statement budget).
 */
export const analysisFacets = async (
  deps: AnalysisDeps,
  input: {
    readonly scope: AnalysisScope;
    readonly dimensions: readonly BreakdownDimension[];
    readonly topN?: number;
    readonly rankBy?: 'value' | 'count';
    readonly build?: string;
  }
): Promise<Result<AnalysisFacetsResult, ApiError>> => {
  if (input.scope.grain === undefined) {
    return err(
      invalidInput(
        `facets require an explicit scope.grain — one grain keeps the request at ≤${String(FACET_DIMENSIONS_MAX)} breakdown reads (per-grain facets would multiply them)`,
        'grain'
      )
    );
  }
  const dimensions = [...new Set(input.dimensions)];
  if (dimensions.length === 0 || dimensions.length > FACET_DIMENSIONS_MAX) {
    return err(
      invalidInput(
        `facets take 1–${String(FACET_DIMENSIONS_MAX)} distinct dimensions`,
        'dimensions'
      )
    );
  }

  const topNR = normalizeTopN(input.topN, topNMaxFor(dimensions));
  if (topNR.isErr()) return err(topNR.error);
  const topN = topNR.value;
  // ONE generation for every facet (S1) — resolved before routing, which
  // needs its live capabilities.
  const gcR = await genWithCoverage(deps.analysisRepo, input.build, input.scope.grain);
  if (gcR.isErr()) return err(gcR.error);
  // Route every dimension up front — one bad dimension rejects the whole request
  // with the matrix's named capability, before any read runs.
  const routed: { dimension: BreakdownDimension; routes: readonly AnalysisRoute[] }[] = [];
  for (const dimension of dimensions) {
    const routesR = (deps.routeAnalysis ?? routeAnalysis)(
      input.scope,
      'breakdown',
      dimension,
      undefined,
      gcR.value.gen.capabilities
    );
    if (routesR.isErr()) return err(routesR.error);
    routed.push({ dimension, routes: routesR.value });
  }
  const canonicalScope = await echoScope(deps, input.scope, gcR.value.gen);

  const blocks: AnalysisBreakdownBlock[] = [];
  for (const { dimension, routes } of routed) {
    // A mixed request (SIRUTA + regular dims) validates against the raised
    // ceiling but each NON-SIRUTA dimension still reads at most TOPN_MAX —
    // the extra depth exists only for full-country UAT painting.
    const dimensionTopN = Math.min(topN, topNMaxFor([dimension]));
    for (const route of routes) {
      const blockR = await breakdownBlockFor(
        deps,
        gcR.value.gen,
        gcR.value.cov,
        route,
        input.scope,
        dimension,
        dimensionTopN,
        canonicalScope,
        input.rankBy
      );
      if (blockR.isErr()) return err(blockR.error);
      blocks.push(blockR.value);
    }
  }
  return ok({ blocks });
};

// ── records ────────────────────────────────────────────────────────────────────

/**
 * The grains whose counted rows are purchase records a reader can open: one
 * page per fact row, the same rows `procurementStats` counts. Procedures are
 * lifecycles and the framework/call-off/modification populations have no
 * record page of their own.
 */
export const RECORDS_GRAINS = ['direct_acquisition', 'contract'] as const;
export type RecordsGrain = (typeof RECORDS_GRAINS)[number];
export const RECORDS_PAGE_SIZE_DEFAULT = 25;
export const RECORDS_PAGE_SIZE_MAX = 100;

/**
 * Contract rows are award OBSERVATIONS: a consortium award is published once
 * per member, so it lists once per member — exactly as the count counts it.
 * Its money is attributed once per award group, so only one member row
 * carries it; the others show no value rather than the whole award again.
 */
const CONTRACT_MEMBER_ROWS_NOTE =
  'contract records are award observations: a consortium award lists once per member, as it is counted; its value is attributed once per award, so the other members carry no value';

export interface AnalysisRecordsMeta {
  readonly answerability: 'served' | 'degraded' | 'abstained';
  readonly reason: AnswerabilityReason | null;
  readonly buildId: string;
  readonly canonicalScope: string;
  readonly caveats: readonly string[];
  /** As on AnswerEnvelope: the D6 state of a DA page; null on other grains. */
  readonly disclosureKey: string | null;
}

export interface AnalysisRecordsResult {
  readonly grain: RecordsGrain;
  /** Exactly the stats `recordCount` of the scope; null when the block abstains. */
  readonly total: string | null;
  readonly page: number;
  readonly pageSize: number;
  readonly sort: AnalysisRecordsSort;
  readonly items: readonly AnalysisRecordRow[];
  readonly meta: AnalysisRecordsMeta;
}

const isRecordsGrain = (grain: AnalysisGrain | undefined): grain is RecordsGrain =>
  grain !== undefined && (RECORDS_GRAINS as readonly string[]).includes(grain);

const isRecordsSort = (value: string): value is AnalysisRecordsSort =>
  (ANALYSIS_RECORDS_SORTS as readonly string[]).includes(value);

/** An identifier the platform withholds never leaves the API (kernel P0 containment). */
const servedIdentifier = (cui: string | null): string | null =>
  cui !== null && !isWithheldOrganizationIdentifier(cui) ? cui : null;

/**
 * `procurementRecords` — the rows behind one stats block: the same scope, the
 * same routing, the same gates and the same pinned build, so the list's total
 * IS the figure's `recordCount` and every row on every page belongs to it.
 * Money is the grain's anchor money as the figures sum it, nulled when the
 * spend gate abstains (and a value order is refused then: it would rank by
 * money the answer withholds).
 */
export const analysisRecords = async (
  deps: AnalysisDeps,
  input: {
    readonly scope: AnalysisScope;
    readonly build?: string;
    readonly sort?: string;
    readonly page?: number;
    readonly pageSize?: number;
  }
): Promise<Result<AnalysisRecordsResult, ApiError>> => {
  const { scope } = input;
  const grain = scope.grain;
  if (!isRecordsGrain(grain)) {
    return err(
      invalidInput(
        `records require scope.grain ${RECORDS_GRAINS.join(' or ')} — one grain, one population`,
        'grain'
      )
    );
  }
  const sort = input.sort ?? 'date_desc';
  if (!isRecordsSort(sort)) {
    return err(invalidInput(`sort must be one of ${ANALYSIS_RECORDS_SORTS.join(', ')}`, 'sort'));
  }
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? RECORDS_PAGE_SIZE_DEFAULT;
  if (!Number.isInteger(page) || page < 1) {
    return err(invalidInput('page must be a positive integer', 'page'));
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > RECORDS_PAGE_SIZE_MAX) {
    return err(
      invalidInput(`pageSize must be an integer 1–${String(RECORDS_PAGE_SIZE_MAX)}`, 'pageSize')
    );
  }
  const offset = (page - 1) * pageSize;
  if (offset + pageSize > SEARCH_WINDOW_MAX) {
    return err(
      invalidInput(
        `records pages end at row ${String(SEARCH_WINDOW_MAX)}; narrow the scope or reverse the order`,
        'page'
      )
    );
  }

  const gcR = await genWithCoverage(deps.analysisRepo, input.build, grain);
  if (gcR.isErr()) return err(gcR.error);
  const routesR = (deps.routeAnalysis ?? routeAnalysis)(
    scope,
    'stats',
    undefined,
    undefined,
    gcR.value.gen.capabilities
  );
  const { gen, cov } = sourceFor(gcR.value.gen, gcR.value.cov, grain);
  if (routesR.isErr()) return err(routesR.error);
  const route = routesR.value.find((candidate) => candidate.grain === grain);
  if (route === undefined || routesR.value.length !== 1) {
    return err(databaseError(`records routing did not resolve the single grain ${grain}`));
  }

  const blockGate = shapeGate(gen, cov, grain, scope, { shape: 'records' });
  const spend = anchorMoneyGate(gen, cov, grain);
  const moneyAllowed = spend?.allow ?? false;
  const gate = composeGates([blockGate, ...(spend !== null ? [spend] : [])]);
  const valueOrderRefused = (sort === 'value_desc' || sort === 'value_asc') && !moneyAllowed;
  // An abstaining block (time/geo class, or a grain whose build cannot be read or is
  // retired) lists nothing whatever the order: it abstains below rather than refusing it.
  if (blockGate.allow && valueOrderRefused) {
    return err(
      invalidInput(
        'a value order is unavailable: the spend gate withholds this grain’s money',
        'sort'
      )
    );
  }
  const canonicalScope = await echoScope(deps, scope, gen);
  const caveats = [
    ...gate.caveats,
    ...(grain === 'contract' ? [CONTRACT_MEMBER_ROWS_NOTE] : []),
    ...scopeNotes(grain, scope, gen),
  ];
  const meta = (answerability: AnalysisRecordsMeta['answerability']): AnalysisRecordsMeta => ({
    answerability,
    reason: gate.reason ?? null,
    buildId: gen.buildId,
    canonicalScope,
    caveats,
    disclosureKey: grain === 'direct_acquisition' ? (gen.disclosureKey ?? 'off') : null,
  });

  // The same block gate as the stats block: an abstaining time/geo class
  // lists nothing, exactly as the figures count nothing.
  if (!blockGate.allow) {
    return ok({ grain, total: null, page, pageSize, sort, items: [], meta: meta('abstained') });
  }

  const readR = await deps.analysisRepo.recordsFor(route, scope, gen, {
    sort,
    offset,
    limit: pageSize,
  });
  if (readR.isErr()) return err(readR.error);
  const items = readR.value.rows.map((row) => {
    // D6 backstop: a supplier the reader classed natural_person never carries a code or name.
    const withheld = row.supplierDisplayKind === 'natural_person';
    // A person's code (owner, 24 Nov: "Masked name"): the reader's raw name is never served; the
    // display step may fill the masked one production serves.
    const person =
      !withheld && row.supplierCui !== null && isWithheldOrganizationIdentifier(row.supplierCui);
    return {
      ...row,
      authorityCui: servedIdentifier(row.authorityCui),
      // "Never a CNP": a party name the source wrote with a personal numeric code is withheld.
      authorityName: publicPartyName(row.authorityName),
      supplierCui: withheld ? null : servedIdentifier(row.supplierCui),
      supplierName: withheld || person ? null : publicPartyName(row.supplierName),
      ...(person && { supplierPerson: true as const }),
      valueRon: moneyAllowed ? row.valueRon : null,
    };
  });
  return ok({
    grain,
    total: readR.value.total,
    page,
    pageSize,
    sort,
    items,
    meta: meta(gate.allow && !gate.degraded ? 'served' : 'degraded'),
  });
};
