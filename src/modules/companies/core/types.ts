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
