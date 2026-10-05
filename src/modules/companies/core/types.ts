/**
 * Companies module — domain view-model types (plan §2).
 *
 * camelCase view models mapped from the live `companies_v2.*` + `core.organizations`
 * schema. All money is a nullable `string` (§14.1 — never float), dates are
 * `'YYYY-MM-DD'` strings, `org_id` is a `string` (bigint, identity only — the
 * cross-source link key is ALWAYS the CUI). `employees` is a `string` (bigint:
 * source garbage outliers overflow int4; the API never coerces it to a JS number).
 *
 * Identity is link-not-merge (plan §2.1): a company is addressed by normalized CUI;
 * this module never reassigns/merges `org_id`s across registries.
 *
 * Dropped by contract (§13-R1): the old `companies.fiscal_status.is_active`
 * complement is not recreated from v2. Only `declaredFiscallyInactive`
 * (= is_inactive) is exposed.
 */

import type {
  CompanyCaenCatalogLabel,
  CompanyNameSource,
  CompanyRegistryBasis,
  CompanyRegistryCuiState,
  CompanyRegistryEnvelope,
  CompanyRegistryEvidence,
  CompanyStatusLabelSource,
} from './registry.js';
import type { BigIntString, Cui, IsoDate, Money, Siruta } from '@/modules/shared/index.js';

export type {
  CompanyCaenCatalogLabel,
  CompanyNameSource,
  CompanyRegistryBasis,
  CompanyRegistryCaenObservation,
  CompanyRegistryCoverage,
  CompanyRegistryCuiProfile,
  CompanyRegistryCuiState,
  CompanyRegistryEnvelope,
  CompanyRegistryEvidence,
  CompanyRegistryIdentifier,
  CompanyRegistryIdentityObservation,
  CompanyRegistryProvenance,
  CompanyRegistryRecheck,
  CompanyRegistryState,
  CompanyRegistryStatusObservation,
  CompanyRegistryValue,
  CompanyStatusLabelSource,
  OnrcCaenSelector,
} from './registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Discovery / resolve
// ─────────────────────────────────────────────────────────────────────────────

/** Filter dimensions the resolve surface can map free text → filter value. */
export type CompanyResolveDim = 'name' | 'regnum' | 'caen' | 'county';
export const COMPANY_RESOLVE_DIMS: readonly CompanyResolveDim[] = [
  'name',
  'regnum',
  'caen',
  'county',
];

/**
 * A name→value discovery hit. `value` is the filter value to feed back (CUI for
 * name/regnum, code for caen, canonical county string for county); `cui` is set
 * when the dimension resolves to a company (name/regnum). Module-local shape that
 * also satisfies the kernel `ResolveHit` contract via `makeCompanyResolve`.
 */
export interface CompanyNameHit {
  readonly dim: CompanyResolveDim;
  readonly value: string;
  readonly label: string;
  readonly cui: Cui | null;
  readonly confidence: number | null;
  /** Where a company label came from (name/regnum hits); null for other dims. */
  readonly labelSource: CompanyNameSource | null;
}

/**
 * A CAEN catalog code. `rev` is the catalog revision (`rev0`..`rev3`);
 * `key` is the exact ONRC selector `<rev>:<code>` the `onrcCaen` filter
 * takes. The label is the current database catalog's, never an edition's.
 */
export interface CaenCodeHit {
  readonly code: string;
  readonly rev: string;
  readonly key: string;
  readonly label: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry / identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A compatibility status: the code of the pinned edition's complete status
 * consensus, and display text from this API's static nomenclature (or the
 * code itself). `labelSource` says which; it is never an ONRC-observed label.
 */
export interface CompanyStatus {
  readonly code: string;
  readonly label: string;
  readonly labelSource: CompanyStatusLabelSource;
}

/** ONRC SIRUTA-matched territory (urban-only matcher; ~36.3% NULL). */
export interface CompanyTerritory {
  readonly sirutaCode: Siruta | null;
  readonly uatName: string | null;
  readonly countyName: string | null;
  readonly matchConfidence: 'safe' | 'unmatched';
}

/**
 * Postal address. `county` is the registry display county, deliberately distinct
 * from `CompanyTerritory.countyName` (SIRUTA-matched).
 */
export interface CompanyAddress {
  readonly display: string;
  readonly county: string | null;
  readonly locality: string | null;
}

export interface CompanyStatusFlag {
  readonly code: string;
  readonly label: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fiscal (ANAF)
// ─────────────────────────────────────────────────────────────────────────────

export interface CompanyFiscal {
  readonly vatPayer: boolean | null;
  /**
   * = `is_inactive` (ANAF declared-fiscally-inactive-list flag). The ONLY
   * fiscal-inactivity boolean exposed. NOT an operating/lifecycle state; its
   * complement `is_active` is intentionally dropped (§13-R1).
   */
  readonly declaredFiscallyInactive: boolean | null;
  readonly mainCaenCode: string | null;
  readonly mainCaenRev: string | null;
  readonly registeredName: string | null;
  /** ANAF's state date for this answer (`status_date`); never the retrieval time. Null = unknown. */
  readonly asOf: IsoDate | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Financials (ANAF bilanț)
// ─────────────────────────────────────────────────────────────────────────────

/** The 20 typed financial metrics (numeric → string; precision-safe). */
export interface CompanyFinancialSummary {
  readonly turnover: Money | null;
  readonly netProfit: Money | null;
  readonly netLoss: Money | null;
  readonly totalRevenue: Money | null;
  readonly totalExpenses: Money | null;
  readonly grossProfit: Money | null;
  readonly grossLoss: Money | null;
  readonly receivables: Money | null;
  readonly currentAssets: Money | null;
  readonly fixedAssets: Money | null;
  readonly cashAndBank: Money | null;
  readonly prepaidExpenses: Money | null;
  readonly deferredIncome: Money | null;
  readonly subscribedCapital: Money | null;
  readonly inventories: Money | null;
  readonly debts: Money | null;
  readonly provisions: Money | null;
  readonly totalEquity: Money | null;
  readonly patrimonyRegie: Money | null;
}

/**
 * The qualification evaluator's metric names (sql-v1, scraper migration
 * 20261003T170000): the 20 source metrics in `companies_v2.financials` order,
 * then the derived `net_result`. The order is the order of every status list.
 */
export const COMPANY_FINANCIAL_METRICS = [
  'turnover',
  'net_profit',
  'net_loss',
  'employees',
  'total_revenue',
  'total_expenses',
  'gross_profit',
  'gross_loss',
  'receivables',
  'current_assets',
  'fixed_assets',
  'cash_and_bank',
  'prepaid_expenses',
  'deferred_income',
  'subscribed_capital',
  'inventories',
  'debts',
  'provisions',
  'total_equity',
  'patrimony_regie',
  'net_result',
] as const;
export type CompanyFinancialMetric = (typeof COMPANY_FINANCIAL_METRICS)[number];

/**
 * Per-metric evaluator status (the same seven values the analytics release
 * publishes). `reported` = admitted by the named extraction/mapping policy, NOT
 * an economic certification of the figure: only `reported` values may enter a
 * derived figure or comparison; every other status keeps the original visible
 * and outside comparisons.
 */
export const COMPANY_METRIC_STATUSES = [
  'reported',
  'missing',
  'not_admitted',
  'held_profile',
  'held_observation',
  'held_quality',
  'held_component',
] as const;
export type CompanyMetricStatus = (typeof COMPANY_METRIC_STATUSES)[number];

/** The evaluator this API understands; any other version is not assessed. */
export const COMPANY_QUALIFICATION_EVALUATOR = 'sql-v1';

export interface CompanyMetricQualification {
  readonly metric: CompanyFinancialMetric;
  readonly status: CompanyMetricStatus;
}

/**
 * Why a statement carries no qualification. `qualification_unavailable`: this
 * runtime cannot read the evaluator (not migrated or not granted);
 * `no_active_policy`: nothing is published, or the publication has no row for
 * the statement; `qualification_malformed`: the evaluator row broke the
 * contract (unknown status, incomplete list, unknown evaluator). The others
 * are the evaluator's own reasons (policy_missing, policy_unsupported,
 * evaluator_unsupported_policy_feature, policy_unreadable,
 * policy_unqualified, unrepresentable_reported_value,
 * net_result_out_of_range). An open string: a new reason is still
 * "not assessed", never "reported".
 */
export type CompanyQualificationReason = string;

/**
 * The qualification of one statement under the ACTIVE published admission
 * policy. The original source strings on the year are never changed by it.
 * Dates here are policy dates, never source freshness.
 */
export interface CompanyStatementQualification {
  readonly assessment: 'assessed' | 'not_assessed';
  /** Null exactly when assessed. */
  readonly reason: CompanyQualificationReason | null;
  /** The analytics release whose published policy evaluated the statement. */
  readonly releaseId: string | null;
  readonly policyVersion: string | null;
  readonly policySha256: string | null;
  /** The POLICY's approval date ('YYYY-MM-DD'); never a source or freshness date. */
  readonly policyApprovedOn: IsoDate | null;
  readonly evaluatorVersion: string | null;
  /** All 21 metrics in `COMPANY_FINANCIAL_METRICS` order when assessed; empty otherwise. */
  readonly metrics: readonly CompanyMetricQualification[];
  readonly netResultStatus: CompanyMetricStatus | null;
  /**
   * The evaluator's net result (profit − loss, an absent side as 0 only when
   * admitted), exact; set only when `netResultStatus` is `reported`. Never the
   * stored generated `financials.net_result`, which coalesces both sides.
   */
  readonly netResult: Money | null;
  /** The reviewed reason of an observation hold naming this statement. */
  readonly holdReason: string | null;
  /** How the statement no longer matches the reviewed hold; the hold stays in force. */
  readonly holdDrift: readonly string[];
}

/**
 * Where the statement was published. ANAF: the bilanț web-service URL stored
 * with the statement. MFP: the exact data.gov.ro resource the statement was
 * read from (`financial_source_resources`). Null when not recorded: never
 * guessed, never another publisher's URL.
 */
export interface CompanyStatementSource {
  readonly sourceSystem: string;
  readonly url: string | null;
  readonly urlKind: 'anaf_statement' | 'mfp_resource' | null;
  readonly statementProfileHash: string | null;
  readonly metricRuleVersion: string;
}

export interface CompanyFinancialYear {
  readonly year: number;
  /** Publisher: 'anaf' (FY2019+) or 'mfp' (FY2008–2018 bulk backfill). Seam CHECK-enforced at 2019. */
  readonly sourceSystem: string;
  /** The exact ORIGINAL source value; qualified or not (see `qualification`). */
  readonly turnover: Money | null;
  readonly netProfit: Money | null;
  readonly netLoss: Money | null;
  /** bigint as string — source outliers (max 5,009,387,154) overflow int4; never a JS number. */
  readonly employees: BigIntString | null;
  readonly summary: CompanyFinancialSummary;
  /** Nullable in v2 profiles; canonical statement lines live in companies_v2.financial_indicators. */
  readonly lines: Record<string, unknown> | null;
  readonly source: CompanyStatementSource;
  readonly qualification: CompanyStatementQualification;
}

/**
 * Why a trajectory delta is null: fewer_than_two_statements, not_assessed
 * (either year), policy_incompatible (different policy digest, evaluator or
 * release), latest_not_reported / prior_not_reported (that year's metric is
 * not `reported`), not_exact (a value that is not a plain number).
 */
export type CompanyTrajectoryReason = string;

/**
 * latest vs (latest-1) deltas (research feature 2). Nulls when <2 years.
 * A delta uses only REPORTED values of the same metric in both years, under
 * the same policy digest, evaluator and release; one held metric does not
 * remove the others. Exact decimal arithmetic at the inputs' own scale (two
 * places minimum): no stored digit is truncated or rounded.
 */
export interface CompanyFinancialTrajectory {
  readonly fromYear: number | null;
  readonly toYear: number | null;
  readonly turnoverDelta: Money | null;
  readonly netResultDelta: Money | null;
  readonly employeesDelta: BigIntString | null;
  readonly turnoverDeltaReason: CompanyTrajectoryReason | null;
  readonly netResultDeltaReason: CompanyTrajectoryReason | null;
  readonly employeesDeltaReason: CompanyTrajectoryReason | null;
}

/**
 * Statements recorded under a CUI, as attributed source observations (CD-08):
 * the namespace is the CUI, not company membership — it may have no core
 * organization or be a public non-company one. Withheld under a known
 * non-public organization.
 */
export interface CompanyFinancials {
  readonly years: readonly CompanyFinancialYear[];
  readonly latest: CompanyFinancialYear | null;
  readonly trajectory: CompanyFinancialTrajectory | null;
}

/**
 * A warn-only data-quality flag on one (cui, year) statement. Advisory: it
 * qualifies a figure ("this was flagged"), it never suppresses one. Severity
 * domain today: 'info' | 'review' | 'warning' — kept a string (not an enum) so
 * a new upstream class degrades to an unknown label instead of a serialization
 * error on an advisory surface. numericValue/thresholdValue are exact decimal
 * strings in the metric's own unit (RON, headcount, ratio) — not Money.
 */
export interface CompanyFinancialQualityFlag {
  readonly year: number;
  readonly flagCode: string;
  readonly metricName: string;
  readonly severity: string;
  /** Exact decimal string in the METRIC'S OWN UNIT (RON, headcount, or ratio) — NOT always money. */
  readonly numericValue: string | null;
  /** Same unit rules as numericValue (employees_outlier threshold is a headcount). */
  readonly thresholdValue: string | null;
}

/**
 * Dated advisory flags PLUS corpus-wide context. The flags are legacy
 * anomaly observations: the table stores anomalies only, keeps no assessment
 * receipt per statement and is not tied to the statement revision it saw
 * (newest flags 2026-08-25, financials rebuilt 2026-09-27). So a missing flag
 * is NOT an assessment — a CUI-year without a flag is "unassessed", never
 * "checked, clean", in an assessed year or not. `assessedYears` is the
 * MEASURED SET of years holding at least one public flag corpus-wide
 * (FY2020 has none; FY2008–2018 predates the lane), context only.
 * `assessedAt` is the newest flag's creation date: not a last-assessment
 * watermark (a derive re-run refreshes existing flags and keeps their
 * `created_at`), and it does not establish whether the current statement
 * revision was assessed.
 */
export interface CompanyFinancialQualityAssessment {
  /** Ascending distinct years holding at least one flag corpus-wide. Context, not a per-statement receipt. */
  readonly assessedYears: readonly number[];
  readonly assessedAt: string | null;
  readonly flags: readonly CompanyFinancialQualityFlag[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration diff (two published, accessible ONRC editions)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Closed set — the GraphQL enum mirrors it; adding a field is a contract change.
 * `county`/`locality` compare the edition's derived geography (county code,
 * UAT SIRUTA code) and report canonical territory names. Status is not
 * diffed: an observed status set is evidence on the profile, not a change.
 */
export type CompanyRegistrationField = 'legalName' | 'legalForm' | 'county' | 'locality';

export interface CompanyRegistrationChange {
  readonly field: CompanyRegistrationField;
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * Observation-set comparison of two published editions, never a legal
 * rename, registration or deletion. `appeared`/`disappeared`: the CUI has a
 * qualified public profile in only one of the two editions (privacy or
 * qualification changes do this too). `not_comparable` carries a `reason`:
 * no published edition, no earlier dated published edition (the first
 * edition), the CUI has no profile in either, or its distinct values exceed
 * the comparison bound (incomplete sets are never compared). `ambiguous`: a
 * field holds several public values on at least one side and the sets differ.
 */
export type CompanyRegistrationDiffStatus =
  'changed' | 'unchanged' | 'appeared' | 'disappeared' | 'not_comparable' | 'ambiguous';

/** A value of one field on one edition side: compared by `key`, reported as `display`. */
export interface CompanyRegistrationValue {
  readonly key: string;
  readonly display: string;
}

/** One edition side of a CUI: its public identity observations' distinct values per field. */
export interface CompanyRegistrationEditionSide {
  readonly editionId: BigIntString;
  readonly sourcePublishedAt: IsoDate | null;
  /** True when the CUI has a qualified public profile in this edition. */
  readonly inEdition: boolean;
  readonly values: Readonly<Record<CompanyRegistrationField, readonly CompanyRegistrationValue[]>>;
  /**
   * True when `values` are the side's complete distinct value sets. False
   * when the read passed its bound: `values` is then empty and the sides are
   * never compared (an unread value is never a missing one).
   */
  readonly valuesComplete: boolean;
}

export interface CompanyRegistrationDiffData {
  readonly registry: CompanyRegistryEnvelope;
  /** The pinned edition. Null when the registry is not published. */
  readonly later: CompanyRegistrationEditionSide | null;
  /** The newest accessible published edition with an earlier source date; null when none. */
  readonly earlier: CompanyRegistrationEditionSide | null;
}

export interface CompanyRegistrationDiff {
  readonly fromEditionId: BigIntString | null;
  readonly toEditionId: BigIntString | null;
  /** Source publication dates of the two editions (never retrieval times). */
  readonly fromCaptureDate: string | null;
  readonly toCaptureDate: string | null;
  readonly status: CompanyRegistrationDiffStatus;
  /**
   * Set when `not_comparable`: registry_<state> | first_edition | not_in_edition |
   * not_in_either_edition | evidence_bound_exceeded.
   */
  readonly reason: string | null;
  readonly changes: readonly CompanyRegistrationChange[];
}

// ─────────────────────────────────────────────────────────────────────────────
// CAEN, representatives, EU branches
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One activity: an ONRC (revision, code) the pinned edition publicly
 * observes, or the ANAF declared main activity (its own revision, often
 * unknown). The label is the current database catalog's for the row's OWN
 * known revision (`labelSource`), never an edition-frozen label and never
 * borrowed across revisions or sources.
 */
export interface CompanyCaenActivity {
  readonly code: string;
  readonly rev: string | null;
  readonly source: string;
  readonly label: string | null;
  readonly labelSource: CompanyCaenCatalogLabel['source'] | null;
}

/** Public field kept for compatibility; v2 person rows are restricted until API-gated. */
export interface CompanyRepresentative {
  readonly name: string;
  readonly role: string;
}

export interface CompanyEuBranch {
  readonly branchName: string | null;
  readonly country: string | null;
  readonly euid: string | null;
  readonly fiscalCode: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// As-of watermarks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Source observation dates, never write or fetch times. `onrc` = source
 * publication date of the pinned ONRC edition (null unless published);
 * `anaf` = ANAF's state date (`status_date`). Null = unknown, never coalesced
 * from a retrieval or rebuild time.
 */
export interface CompanyAsOf {
  readonly onrc: IsoDate | null;
  readonly anaf: IsoDate | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public money (kernel FlowsRepo — payee/`in` direction only, grain-gated §14.6)
// ─────────────────────────────────────────────────────────────────────────────

/** Per-(year, flowType) bucket. `year` is null only when the source flow has no flow_year. */
export interface CompanyPublicMoneyYear {
  readonly year: number | null;
  readonly flowType: string;
  readonly totalRon: Money;
  readonly count: number;
}

/** Per-flowType bucket (year-agnostic rollup). */
export interface CompanyPublicMoneyFlowType {
  readonly flowType: string;
  readonly totalRon: Money;
  readonly count: number;
}

export interface CompanyPublicMoneyPayer {
  readonly cui: Cui | null;
  readonly name: string | null;
  readonly totalRon: Money;
  readonly count: number;
}

/** Public money RECEIVED (company = payee). The only flow answer companies gives. */
export interface CompanyPublicMoney {
  readonly totalRon: Money;
  readonly flowCount: number;
  /** Per-(year, flowType) breakdown — `year` is populated (was always null; audit H4). */
  readonly byYear: readonly CompanyPublicMoneyYear[];
  /** Per-flowType rollup (the year-agnostic view the old `byYear` actually held). */
  readonly byFlowType: readonly CompanyPublicMoneyFlowType[];
  readonly topPayers: readonly CompanyPublicMoneyPayer[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile (the full per-CUI assembly) + list row + aggregates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The full company profile (GraphQL `company(cui)` + MCP snapshot source).
 * The directory spine (public `company` core organization) decides presence;
 * ONRC values are the pinned edition's qualified scalars (null when the basis
 * admits none: conflict, absence, unresolved or no published edition), with
 * the full evidence under `registry`. Fiscal (ANAF) and financial sections
 * are independent of the registry state.
 */
export interface CompanyProfile {
  readonly cui: Cui;
  readonly orgId: BigIntString;
  readonly name: string;
  readonly nameSource: CompanyNameSource;
  readonly legalForm: string | null;
  /** The single public resolved identifier key; null with none or several (see registry.identifiers). */
  readonly codInmatriculare: string | null;
  /** The edition's qualified RECORDED date (civil date); never a founding date or age. */
  readonly registrationDate: IsoDate | null;
  readonly registrationDatePresent: boolean;
  /** The edition's complete status consensus; null on conflict, partial or unresolved evidence. */
  readonly headlineStatus: CompanyStatus | null;
  /** Distinct parsed public status codes the pinned edition observes (observed labels only). */
  readonly statusFlags: readonly CompanyStatusFlag[];
  readonly territory: CompanyTerritory | null;
  readonly address: CompanyAddress;
  readonly fiscal: CompanyFiscal | null;
  readonly caenActivities: readonly CompanyCaenActivity[];
  readonly representatives: readonly CompanyRepresentative[];
  readonly financials: readonly CompanyFinancialYear[];
  /** Not part of the ONRC edition contract: empty, never served from the legacy projection. */
  readonly euBranches: readonly CompanyEuBranch[];
  readonly registry: CompanyRegistryEvidence;
  /** Injected by the usecase from the kernel FlowsRepo (payee), never the repo. */
  readonly publicMoney: CompanyPublicMoney | null;
  readonly asOf: CompanyAsOf;
}

/**
 * The eager snapshot (MCP `get_company_snapshot`): the full profile and its
 * registration diff, every part read under ONE pinned scope and rechecked
 * once after all of them. `registrationDiff` is advisory: null only when the
 * comparison read itself failed. A scope, access or capability move refuses
 * or re-pins the whole snapshot, never just this field.
 */
export interface CompanySnapshot extends CompanyProfile {
  readonly registrationDiff: CompanyRegistrationDiff | null;
}

/** A row in the filterable company list (lean; no fan-out). */
export interface CompanyListRow {
  readonly cui: Cui;
  readonly orgId: BigIntString;
  readonly name: string;
  readonly nameSource: CompanyNameSource;
  readonly legalForm: string | null;
  readonly headlineStatus: CompanyStatus | null;
  /** Canonical county name of the edition's complete county consensus. */
  readonly county: string | null;
  readonly vatPayer: boolean | null;
  readonly declaredFiscallyInactive: boolean | null;
  /** The edition's qualified recorded date; never a founding date. */
  readonly registrationDate: IsoDate | null;
  readonly registrationDatePresent: boolean;
  readonly registryCuiState: CompanyRegistryCuiState;
  /** Any public original 1048 on any resolved identifier; null unless in the pinned edition. */
  readonly hasActiveObservation: boolean | null;
  readonly statusBasis: CompanyRegistryBasis | null;
  readonly countyBasis: CompanyRegistryBasis | null;
  readonly recordedDateBasis: CompanyRegistryBasis | null;
}

export type CompanyGroupBy = 'county' | 'status' | 'caenDivision';

/**
 * One facet bucket. County/status: each CUI of the filtered population counts
 * once, under its edition consensus value or, when there is none, an explicit
 * basis bucket (`basis` set, key `(<basis>)`; `not_in_edition` for a spine
 * without a profile). CAEN division: key `<revision|unknown>:<2 digits>`,
 * distinct CUIs per bucket, buckets overlap.
 */
export interface CompanyGroupCount {
  readonly key: string;
  readonly label: string | null;
  readonly count: number;
  readonly basis: string | null;
}

/** Count-ranked aggregate (value-ranked is NOT offered — §13-R3). */
export interface CompanyCountyProfile {
  readonly groupBy: CompanyGroupBy;
  readonly groups: readonly CompanyGroupCount[];
  /** The filtered population (distinct CUIs), never a sum of overlapping buckets. */
  readonly denominator: number;
  readonly coverage: CompanyCoverage;
  readonly registry: CompanyRegistryEnvelope;
}

/** Coverage disclosure for aggregates/territory answers (catalog Coverage Gate). */
export interface CompanyCoverage {
  readonly territoryMatched: number | null;
  readonly territoryUnmatched: number | null;
  readonly note: string;
}

/**
 * The /companies hub landing aggregate: three heavy `countBy` legs composed into
 * one answer. ~30s to compute end-to-end (status ≈4.5s, county ≈1.9s, caenDivision
 * ≈23.6s — measured on prod 2026-07-09), so it is ONLY ever served from the
 * module's stale-while-revalidate cache, never computed on a request path.
 *
 * `computedAt` is stamped by the shell (no clock in core).
 */
export interface CompanyHubStats {
  /** Every company on the CUI directory spine (= the STATUS leg's denominator). NOT the whole ONRC registry. */
  readonly totalCompanies: number;
  /**
   * Spine companies with ANY public original status 1048 observation on a
   * resolved identifier of the pinned edition, counted separately from the
   * status mix: a CUI with a conflicting code counts here and sits in the
   * `(multiple_values)` status bucket.
   */
  readonly activeCompanies: number;
  /** Status consensus breakdown (one bucket per CUI, explicit basis buckets), count-desc. */
  readonly statusMix: readonly CompanyGroupCount[];
  /** Top 10 county consensus buckets among ACTIVE companies; basis buckets excluded (see coverage). */
  readonly topCounties: readonly CompanyGroupCount[];
  /**
   * (revision, CAEN division) buckets among ACTIVE companies, count-desc, from
   * observations on the identifier carrying the active observation. Distinct
   * CUIs per bucket; buckets overlap and do not sum to a population.
   */
  readonly caenDivisions: readonly CompanyGroupCount[];
  /** Territory coverage of the ACTIVE population (from the county leg). */
  readonly coverage: CompanyCoverage;
  /** The scope the legs were computed under; the cache serves it only while it is current. */
  readonly registry: CompanyRegistryEnvelope;
  /** ISO-8601 instant the underlying legs were computed. Shell-stamped. */
  readonly computedAt: string;
}

/** The contributor's compact entity slice (Entity.company + entity-360). */
export interface CompanyEntitySlice {
  readonly cui: Cui;
  readonly name: string;
  readonly nameSource: CompanyNameSource;
  readonly legalForm: string | null;
  readonly headlineStatus: CompanyStatus | null;
  readonly vatPayer: boolean | null;
  readonly declaredFiscallyInactive: boolean | null;
  /** The edition's qualified recorded date; never a founding date. */
  readonly registrationDate: IsoDate | null;
  readonly registrationDatePresent: boolean;
  readonly territory: CompanyTerritory | null;
  readonly latestFinancial: CompanyFinancialYear | null;
  readonly registryCuiState: CompanyRegistryCuiState;
  readonly registry: CompanyRegistryEnvelope;
  readonly asOf: CompanyAsOf;
}

/** A published, accessible edition a client may pin or compare against. */
export interface CompanyRegistryEdition {
  readonly editionId: BigIntString;
  readonly sourceSnapshotId: string;
  readonly sourcePublishedAt: IsoDate | null;
  readonly interpretationVersion: string;
  readonly dimensionPolicyVersion: string;
  /** True for the edition the current scope pins. */
  readonly current: boolean;
}

/**
 * The compact registry read for client pinning. Read fresh (never cached):
 * metadata only, never an access authorization for cached data.
 */
export interface CompanyRegistryCapabilities {
  readonly registry: CompanyRegistryEnvelope;
  /** The opaque scope key cursors and page bindings carry. */
  readonly scopeKey: string;
  readonly editions: readonly CompanyRegistryEdition[];
  /** Filter fields evaluated against the pinned edition (refused when not published). */
  readonly registryFilterFields: readonly string[];
  readonly caenRevisions: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Sort
// ─────────────────────────────────────────────────────────────────────────────

/** Allowed sort keys. Value sorts (turnover/employees) are NOT offered (§13-R3). */
export type CompanySort = 'name' | 'registrationDate' | 'cui';
export const COMPANY_SORTS: readonly CompanySort[] = ['name', 'registrationDate', 'cui'];

/** Coverage note surfaced on territory-grain answers. */
export const COMPANY_TERRITORY_COVERAGE_NOTE =
  'Territory is the pinned ONRC edition’s derived geography: a county/UAT value only when every public identity observation that may contribute it agrees (complete consensus); matched = companies with a UAT consensus value. Multiple, partial, missing and unresolved geography stay explicit, never coerced into a county; a spine without an edition profile is not_in_edition.';
