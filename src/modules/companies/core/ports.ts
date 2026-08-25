/**
 * Companies module — repository port (plan §3).
 *
 * One `CompaniesRepository`; every method returns `Result<T, ApiError>`
 * (neverthrow). Reads `companies_v2.*` + the kernel read schemas it is allowed
 * (`core.organizations`,
 * `core.classification_codes`). It does NOT query `flows.money_flows` — the
 * public-money slice comes from the kernel `FlowsRepo` (contract §4.3/§14.6),
 * injected by the usecase, never the repo.
 *
 * Identity is link-not-merge (§2.1): per-CUI seeks are addressed by normalized
 * CUI against the partial-unique `organizations_cui_uq`; the module never resolves
 * or reassigns `org_id` across registries. Reverse regnum lookup uses v2
 * `registration_identifiers` and one-to-many → returns a LIST.
 *
 * Money/bigint columns are cast `::text` at the SQL boundary (precision-safe
 * strings; `employees` never coerced to a JS number).
 */

import type {
  CaenCodeHit,
  CompanyCoverage,
  CompanyEntitySlice,
  CompanyFinancialQualityFlag,
  CompanyFinancialYear,
  CompanyGroupBy,
  CompanyGroupCount,
  CompanyListRow,
  CompanyNameHit,
  CompanyProfile,
  CompanySort,
} from './types.js';
import type { ApiError, FilterInput, MeiliClient, OffsetParams } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/** The data half of a profile (no public-money — the usecase injects that). */
export type CompanyProfileData = Omit<CompanyProfile, 'publicMoney'>;

export interface CompanyListResult {
  readonly rows: readonly CompanyListRow[];
  /** Bounded count (cap 10,000); `estimated` when the cap was hit (§14.4). */
  readonly total: number;
  readonly estimated: boolean;
}

export interface CompaniesRepository {
  // ── detail (per-CUI, index-backed by PK / cui indexes) ──
  /** Parallel fan-out, each `WHERE cui = $1`; presence decided first by the cheap org seek. */
  getProfileData(cui: string): Promise<Result<CompanyProfileData | null, ApiError>>;
  getFinancials(cui: string): Promise<Result<readonly CompanyFinancialYear[], ApiError>>;
  /** Warn-only quality flags over all statement years (224,657 rows total, all public-class). */
  getFinancialQualityFlags(
    cui: string
  ): Promise<Result<readonly CompanyFinancialQualityFlag[], ApiError>>;

  // ── list / filter (the filterable collection §7) ──
  /**
   * `q` (name) is NOT handled here — the usecase resolves names to a CUI set via
   * `resolveByName` (Meili-primary), ANDs them into `filter.cui.in`, then calls
   * this. So the other filters + offset pagination apply on the name path too.
   */
  listCompanies(
    filter: FilterInput,
    sort: CompanySort,
    page: OffsetParams
  ): Promise<Result<CompanyListResult, ApiError>>;

  // ── resolution / discovery (§7.4) ──
  /**
   * PRIMARY = kernel Meili (company/organizations index). Postgres has no trigram
   * index on the name → an `ILIKE '%q%'` is a 3.99M-row seq scan, FORBIDDEN as the
   * default. The degraded pg fallback (kind='company'-scoped, TS diacritic fold,
   * hard-capped) runs only when Meili is unavailable, and sets `degraded`.
   */
  resolveByName(
    q: string,
    limit: number,
    meili: MeiliClient | null
  ): Promise<Result<{ hits: readonly CompanyNameHit[]; degraded: boolean }, ApiError>>;
  /** registration_identifiers(scheme,value)→CUI, validated against organizations(kind='company'). Returns a LIST. */
  findByRegistrationNumber(cod: string): Promise<Result<readonly CompanyNameHit[], ApiError>>;
  resolveCaen(label: string, limit: number): Promise<Result<readonly CaenCodeHit[], ApiError>>;
  resolveCounty(q: string): Promise<Result<readonly string[], ApiError>>;

  // ── aggregates (count-ranked; value-ranked NOT offered §13-R3) ──
  /** GROUP BY → groups; `groupBy=county` requires a selective predicate. */
  countBy(
    groupBy: CompanyGroupBy,
    filter: FilterInput
  ): Promise<
    Result<
      { groups: readonly CompanyGroupCount[]; denominator: number; coverage: CompanyCoverage },
      ApiError
    >
  >;

  // ── contributor support (§4) ──
  profileSlice(cui: string): Promise<Result<CompanyEntitySlice | null, ApiError>>;
  /** Compact presence + counts for entity-360 badges. */
  presenceCounts(cui: string): Promise<Result<CompanyPresenceCounts | null, ApiError>>;
  /** Batched slices for the GraphQL `Entity.company` DataLoader (keyed by CUI). */
  profileSlicesForCuis(
    cuis: readonly string[]
  ): Promise<Result<ReadonlyMap<string, CompanyEntitySlice>, ApiError>>;
}

export interface CompanyPresenceCounts {
  readonly cui: string;
  readonly name: string | null;
  readonly headlineStatus: string | null;
  readonly financials: number;
  readonly caenActivities: number;
  readonly representatives: number;
  readonly onrcAsOf: string | null;
  readonly anafAsOf: string | null;
}
