/**
 * Companies module — repository port (plan §3).
 *
 * One `CompaniesRepository`; every method returns `Result<T, ApiError>`
 * (neverthrow). Reads `companies_v2.*` + the kernel read schemas it is allowed
 * (`core.organizations`, `core.territories`, `core.classification_codes`,
 * `companies_analytics.privacy_state`). It does NOT query `flows.money_flows` —
 * the public-money slice comes from the kernel `FlowsRepo` (contract
 * §4.3/§14.6), injected by the usecase, never the repo.
 *
 * ONRC registry reads (scrapper migration 20261003T172000) go through the
 * public `onrc_published_*` views only, bound to the `editionId` of the
 * registry scope the caller pinned (`captureRegistryScope`); never the base
 * tables, never the `onrc_current_*` views, never a legacy registry
 * projection. A scope that is not `published` makes every ONRC-bearing
 * method answer without touching the views (registry fields absent, ONRC
 * filters/groupings refused). `confirmRegistryScope` is the fresh recheck
 * the usecases run before returning.
 *
 * Identity is link-not-merge (§2.1): per-CUI seeks are addressed by normalized
 * CUI against the partial-unique `organizations_cui_uq`; the module never resolves
 * or reassigns `org_id` across registries. Reverse identifier lookup returns a LIST.
 *
 * Money/bigint columns are cast `::text` at the SQL boundary (precision-safe
 * strings; `employees` never coerced to a JS number).
 */

import type { CompanyRegistryEnvelope, CompanyRegistryScopePort } from './registry.js';
import type {
  CaenCodeHit,
  CompanyCoverage,
  CompanyEntitySlice,
  CompanyFinancialQualityAssessment,
  CompanyFinancialYear,
  CompanyRegistrationDiffData,
  CompanyGroupBy,
  CompanyGroupCount,
  CompanyListRow,
  CompanyNameHit,
  CompanyProfile,
  CompanyRegistryEdition,
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

export interface CompanyCountByResult {
  readonly groups: readonly CompanyGroupCount[];
  /** The filtered population (distinct CUIs). */
  readonly denominator: number;
  readonly coverage: CompanyCoverage;
}

export interface CompaniesRepository extends CompanyRegistryScopePort {
  // ── detail (per-CUI, index-backed by PK / cui indexes) ──
  /**
   * Presence by the cheap public `company` organization seek; ONRC evidence
   * of the pinned edition (or the envelope state), ANAF fiscal and financial
   * statements read independently.
   */
  getProfileData(
    cui: string,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<CompanyProfileData | null, ApiError>>;
  getFinancials(cui: string): Promise<Result<readonly CompanyFinancialYear[], ApiError>>;
  /** Warn-only quality flags + measured corpus-wide assessment coverage (all public-class). */
  getFinancialQualityAssessment(
    cui: string
  ): Promise<Result<CompanyFinancialQualityAssessment, ApiError>>;
  /**
   * The CUI's public identity observations in the pinned edition and in the
   * newest accessible published edition with an earlier source date.
   */
  getRegistrationDiffData(
    cui: string,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<CompanyRegistrationDiffData, ApiError>>;

  // ── list / filter (the filterable collection §7) ──
  /**
   * `q` (name) is NOT handled here — the usecase resolves names to a CUI set via
   * `resolveByName` (Meili-primary), ANDs them into `filter.cui.in`, then calls
   * this. Rows and the bounded total share one WHERE and one pinned edition.
   */
  listCompanies(
    filter: FilterInput,
    sort: CompanySort,
    page: OffsetParams,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<CompanyListResult, ApiError>>;
  /** Exact (uncapped) population count for the cached hub; same predicates as the list. */
  countCompanies(
    filter: FilterInput,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<number, ApiError>>;

  // ── resolution / discovery (§7.4) ──
  /**
   * PRIMARY = kernel Meili (company/organizations index). Postgres has no trigram
   * index on the name → an `ILIKE '%q%'` is a 3.99M-row seq scan, FORBIDDEN as the
   * default. The pg fallback (kind='company'-scoped, TS diacritic fold,
   * hard-capped) answers when Meili gave no usable company candidate; it sets
   * `degraded` when Meili was unavailable OR its palette generation was not
   * witnessed current for `scope` (generation-control read before and after
   * the fetch, built for this published scope). Candidates are rehydrated
   * from the public spine (and the pinned edition's qualified name); search
   * text is never presence evidence.
   */
  resolveByName(
    q: string,
    limit: number,
    meili: MeiliClient | null,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<{ hits: readonly CompanyNameHit[]; degraded: boolean }, ApiError>>;
  /** The edition's normalized identifier key → public resolved CUI (spine-validated). Returns a LIST. */
  findByRegistrationNumber(
    cod: string,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<readonly CompanyNameHit[], ApiError>>;
  resolveCaen(label: string, limit: number): Promise<Result<readonly CaenCodeHit[], ApiError>>;
  /** Canonical county names from public county territories (the territory hub). */
  resolveCounty(q: string): Promise<Result<readonly string[], ApiError>>;

  // ── aggregates (count-ranked; value-ranked NOT offered §13-R3) ──
  /** GROUP BY → groups; `groupBy=county` requires a selective predicate. */
  countBy(
    groupBy: CompanyGroupBy,
    filter: FilterInput,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<CompanyCountByResult, ApiError>>;

  // ── contributor support (§4) ──
  /** Compact presence + counts for entity-360 badges. */
  presenceCounts(
    cui: string,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<CompanyPresenceCounts | null, ApiError>>;
  /** Slices for entity-360 and the GraphQL `Entity.company` field (keyed by CUI). */
  profileSlicesForCuis(
    cuis: readonly string[],
    scope: CompanyRegistryEnvelope
  ): Promise<Result<ReadonlyMap<string, CompanyEntitySlice>, ApiError>>;

  // ── registry metadata ──
  /** Published, accessible editions (empty unless the scope is published). */
  publishedEditions(
    scope: CompanyRegistryEnvelope
  ): Promise<Result<readonly CompanyRegistryEdition[], ApiError>>;
}

export interface CompanyPresenceCounts {
  readonly cui: string;
  readonly name: string;
  readonly nameSource: 'onrc_edition' | 'core_organization';
  readonly registryCuiState: CompanyEntitySlice['registryCuiState'];
  /** Compatibility label of the edition's status consensus; null without one. */
  readonly headlineStatus: string | null;
  readonly financials: number;
  /** The same activities the profile lists (ONRC (revision, code) + ANAF main). */
  readonly caenActivities: number;
  readonly representatives: number;
  readonly onrcAsOf: string | null;
  readonly anafAsOf: string | null;
}
