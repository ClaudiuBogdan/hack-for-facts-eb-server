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

import type { BigIntString, Cui, IsoDate, Money, Siruta } from '@/modules/shared/index.js';

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
}

export interface CaenCodeHit {
  readonly code: string;
  readonly rev: string;
  readonly label: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry / identity
// ─────────────────────────────────────────────────────────────────────────────

export interface CompanyStatus {
  readonly code: string;
  readonly label: string;
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
  readonly registeredName: string | null;
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

export interface CompanyFinancialYear {
  readonly year: number;
  /** Publisher: 'anaf' (FY2019+) or 'mfp' (FY2008–2018 bulk backfill). Seam CHECK-enforced at 2019. */
  readonly sourceSystem: string;
  readonly turnover: Money | null;
  readonly netProfit: Money | null;
  readonly netLoss: Money | null;
  /** bigint as string — source outliers (max 5,009,387,154) overflow int4; never a JS number. */
  readonly employees: BigIntString | null;
  readonly summary: CompanyFinancialSummary;
  /** Nullable in v2 profiles; canonical statement lines live in companies_v2.financial_indicators. */
  readonly lines: Record<string, unknown> | null;
}

/** latest vs (latest-1) deltas (research feature 2). Nulls when <2 years. */
export interface CompanyFinancialTrajectory {
  readonly fromYear: number | null;
  readonly toYear: number | null;
  readonly turnoverDelta: Money | null;
  readonly netResultDelta: Money | null;
  readonly employeesDelta: BigIntString | null;
}

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
 * The flags PLUS the corpus-wide assessment coverage. A warn-only surface
 * communicates through absence — "no flag" must only ever mean "checked,
 * clean", never "never checked". The lane last ran 2026-06-30, BEFORE the
 * FY2008–2018 MFP backfill (2026-08-18), so 7.4M statement-years exist that
 * were never assessed. Coverage is the MEASURED SET of flagged years
 * (public-class only), not a min/max range — measured 2026-08-25 the set is
 * {2019, 2021..2025}: FY2020 has ZERO flags, so a range would have asserted
 * it clean. Still a LOWER BOUND (anomalies-only table): a scanned-and-fully-
 * clean year reads as not-assessed (conservative), and assessedAt is the
 * newest flag's creation date, not a true lane watermark.
 */
export interface CompanyFinancialQualityAssessment {
  /** Ascending distinct years with corpus-wide flags. Interior gaps are REAL (FY2020 has none today). */
  readonly assessedYears: readonly number[];
  readonly assessedAt: string | null;
  readonly flags: readonly CompanyFinancialQualityFlag[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration diff (two most recent loaded ONRC captures)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Closed set — the GraphQL enum mirrors it; adding a field is a contract change.
 * `status` is deliberately NOT here: registration_history.raw_status is 100% NULL
 * (8,378,866/8,378,866 measured 2026-08-25) and no complete per-capture status set
 * exists anywhere in prod — a status diff could never fire and would read as
 * "nothing ever changed". Status history is unavailable, stated rather than faked.
 */
export type CompanyRegistrationField = 'legalName' | 'legalForm' | 'county' | 'locality';

export interface CompanyRegistrationChange {
  readonly field: CompanyRegistrationField;
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * `not_comparable` is load-bearing (the FY2020 lesson): it is served when fewer
 * than two captures are loaded corpus-wide OR the company has no public row in
 * either capture — never collapsed into `unchanged` (asserts a comparison that
 * did not happen) or null (reads as lookup failure).
 */
export type CompanyRegistrationDiffStatus =
  'changed' | 'unchanged' | 'appeared' | 'disappeared' | 'not_comparable' | 'ambiguous';

/** One capture-side registration row (public rows only; restricted reads as absent). */
export interface CompanyRegistrationCaptureRow {
  readonly legalName: string;
  readonly normalizedLegalName: string;
  readonly legalForm: string | null;
  readonly county: string | null;
  readonly locality: string | null;
}

export interface CompanyRegistrationDiffData {
  readonly fromCaptureDate: string | null;
  readonly toCaptureDate: string | null;
  readonly captureCount: number;
  readonly earlier: CompanyRegistrationCaptureRow | null;
  readonly later: CompanyRegistrationCaptureRow | null;
  /**
   * True when the capture holds MORE THAN ONE public row for the CUI. The
   * table's grain is (source_snapshot_id, source_row_number) — NOT cui — and
   * ~95k CUIs carry 2–8 rows per snapshot BY DESIGN (ONRC re-registration
   * history; 190,304 (cui, capture) pairs, 47,996 with differing names). A
   * single-row diff is undefined there: an arbitrary pick manufactured a
   * false rename on the first live repro (CUI 10009384). Either flag →
   * status 'ambiguous'.
   */
  readonly earlierMultiple: boolean;
  readonly laterMultiple: boolean;
}

export interface CompanyRegistrationDiff {
  readonly fromCaptureDate: string | null;
  readonly toCaptureDate: string | null;
  readonly status: CompanyRegistrationDiffStatus;
  readonly changes: readonly CompanyRegistrationChange[];
}

// ─────────────────────────────────────────────────────────────────────────────
// CAEN, representatives, EU branches
// ─────────────────────────────────────────────────────────────────────────────

export interface CompanyCaenActivity {
  readonly code: string;
  readonly rev: string;
  readonly source: string;
  readonly label: string | null;
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

/** The full company profile (REST/GraphQL `company(cui)` + MCP snapshot source). */
export interface CompanyProfile {
  readonly cui: Cui;
  readonly orgId: BigIntString;
  readonly name: string;
  readonly legalForm: string | null;
  readonly codInmatriculare: string | null;
  readonly registrationDate: IsoDate | null;
  readonly registrationDatePresent: boolean;
  readonly headlineStatus: CompanyStatus | null;
  readonly statusFlags: readonly CompanyStatusFlag[];
  readonly territory: CompanyTerritory | null;
  readonly address: CompanyAddress;
  readonly fiscal: CompanyFiscal | null;
  readonly caenActivities: readonly CompanyCaenActivity[];
  readonly representatives: readonly CompanyRepresentative[];
  readonly financials: readonly CompanyFinancialYear[];
  readonly euBranches: readonly CompanyEuBranch[];
  /** Injected by the usecase from the kernel FlowsRepo (payee), never the repo. */
  readonly publicMoney: CompanyPublicMoney | null;
  readonly asOf: CompanyAsOf;
}

/** A row in the filterable company list (lean; no fan-out). */
export interface CompanyListRow {
  readonly cui: Cui;
  readonly orgId: BigIntString;
  readonly name: string;
  readonly legalForm: string | null;
  readonly headlineStatus: CompanyStatus | null;
  readonly county: string | null;
  readonly vatPayer: boolean | null;
  readonly declaredFiscallyInactive: boolean | null;
  readonly registrationDate: IsoDate | null;
  readonly registrationDatePresent: boolean;
}

export type CompanyGroupBy = 'county' | 'status' | 'caenDivision';

export interface CompanyGroupCount {
  readonly key: string;
  readonly label: string | null;
  readonly count: number;
}

/** Count-ranked aggregate (value-ranked is NOT offered — §13-R3). */
export interface CompanyCountyProfile {
  readonly groupBy: CompanyGroupBy;
  readonly groups: readonly CompanyGroupCount[];
  readonly denominator: number;
  readonly coverage: CompanyCoverage;
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
  /** Every company on the CUI spine (= the STATUS leg's denominator). NOT the whole ONRC registry: ~86k registry entries have no CUI and are structurally absent (issue 49). */
  readonly totalCompanies: number;
  /** Companies in ONRC lifecycle status `1048` (funcțiune). */
  readonly activeCompanies: number;
  /** Full status breakdown, count-desc. Labels fall back to the nomenclature. */
  readonly statusMix: readonly CompanyGroupCount[];
  /**
   * Top 10 counties among ACTIVE companies, count-desc. The `(none)` bucket
   * (companies with no registry county — 39% of active) is excluded: it is not a
   * county. Its mass is disclosed via `coverage`.
   */
  readonly topCounties: readonly CompanyGroupCount[];
  /**
   * CAEN division (2-digit) breakdown among ACTIVE companies, count-desc. Every
   * `key` is exactly 2 digits: the empty-code bucket (239,950 source rows carry an
   * empty `caen_code`) is excluded — an empty string is not a division.
   */
  readonly caenDivisions: readonly CompanyGroupCount[];
  /** Territory coverage of the ACTIVE population (from the county leg). */
  readonly coverage: CompanyCoverage;
  /** ISO-8601 instant the underlying legs were computed. Shell-stamped. */
  readonly computedAt: string;
}

/** The contributor's compact entity slice (Entity.company + entity-360). */
export interface CompanyEntitySlice {
  readonly cui: Cui;
  readonly name: string;
  readonly legalForm: string | null;
  readonly headlineStatus: CompanyStatus | null;
  readonly vatPayer: boolean | null;
  readonly declaredFiscallyInactive: boolean | null;
  readonly registrationDate: IsoDate | null;
  readonly registrationDatePresent: boolean;
  readonly territory: CompanyTerritory | null;
  readonly latestFinancial: CompanyFinancialYear | null;
  readonly asOf: CompanyAsOf;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sort
// ─────────────────────────────────────────────────────────────────────────────

/** Allowed sort keys. Value sorts (turnover/employees) are NOT offered (§13-R3). */
export type CompanySort = 'name' | 'registrationDate' | 'cui';
export const COMPANY_SORTS: readonly CompanySort[] = ['name', 'registrationDate', 'cui'];

/** Coverage note surfaced on territory-grain answers. */
export const COMPANY_TERRITORY_COVERAGE_NOTE =
  'Territory uses v2 registry resolution: ONRC rows carry safe UAT/SIRUTA matches where available; ANAF-only additions mostly add county/sector coverage, not UAT-level SIRUTA resolution.';
