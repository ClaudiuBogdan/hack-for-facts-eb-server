/**
 * Judicial module — repository ports (plan 08 §4). All methods return
 * `Promise<Result<T, ApiError>>` (neverthrow); the shell adapts them to Kysely.
 * Core stays pure and depends only on the kernel + these ports.
 *
 * SCALE: 6.16M cases / 16.82M parties → **cursor pagination only** for case
 * lists and the company-litigation case list (foundation §14.4); every list
 * method is bounded by an indexed predicate.
 *
 * PRIVACY: the party-returning ports (`JudicialPartyRepo`) SELECT no name column —
 * the row type literally has no name. The ONLY reader of `display_name` is
 * `PartyDictionaryRepo` (§3.1). The two are joined in the usecase layer.
 */

import type {
  JudicialAppeal,
  JudicialAsOf,
  JudicialCase,
  JudicialCaseAggregate,
  JudicialCaseCitation,
  JudicialCaseLink,
  JudicialCompanyLitigation,
  JudicialCourt,
  JudicialHearing,
  JudicialLegalRef,
  JudicialLineageEdge,
  JudicialParty,
  PublishableName,
} from './types.js';
import type { ApiError, CursorPage, CursorPageRequest, FilterInput } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

// ── Courts (246-row reference) ─────────────────────────────────────────────────

export interface CourtListOptions {
  readonly filter: FilterInput;
}

export interface JudicialCourtRepo {
  // tables: justice.courts (PK institution_code). Cheap; full scan acceptable.
  list(opts: CourtListOptions): Promise<Result<readonly JudicialCourt[], ApiError>>;
  getByCode(code: string): Promise<Result<JudicialCourt | null, ApiError>>;
  listChildren(code: string): Promise<Result<readonly JudicialCourt[], ApiError>>; // parent_institution_code
  /** court-name / locality / code trigram resolve (the `court` resolve dim). */
  resolveCourt(q: string, limit: number): Promise<Result<readonly JudicialCourt[], ApiError>>;
  /** distinct `category` / `category_name` values (the `category` resolve dim). */
  resolveCategory(q: string, limit: number): Promise<Result<readonly { value: string; label: string | null }[], ApiError>>;
}

// ── Cases ───────────────────────────────────────────────────────────────────────

export interface CaseListOptions {
  readonly filter: FilterInput;
  readonly sort: 'modifiedAt' | 'openedAt';
  readonly dir: 'asc' | 'desc';
  readonly page: CursorPageRequest;
}

export interface CaseAggregateOptions {
  readonly groupBy: 'court' | 'category' | 'year' | 'courtLevel';
  readonly filter: FilterInput;
}

export interface JudicialCaseRepo {
  getById(caseId: string): Promise<Result<JudicialCase | null, ApiError>>;
  getByNaturalKey(
    institutionCode: string,
    caseNumber: string
  ): Promise<Result<JudicialCase | null, ApiError>>;
  /**
   * CURSOR list. Driving index: cases_institution_idx (institution filter) OR
   * cases_modified_idx (recency feed). Sort tuple = (sortExpr, case_id). The repo
   * REJECTS an unbounded request (no court / period bound) → InvalidInput (§7.1).
   */
  listCursor(opts: CaseListOptions): Promise<Result<CursorPage<JudicialCase>, ApiError>>;
  /** JD-2: cases by institution × category × year × courtLevel. Bounded; aggregate timeout. */
  aggregate(opts: CaseAggregateOptions): Promise<Result<JudicialCaseAggregate, ApiError>>;
  /** Domain freshness watermark — interim `max(cases.last_seen_at)` (§10). */
  getAsOf(): Promise<Result<JudicialAsOf, ApiError>>;
}

// ── Hearings & appeals (children; always bounded by case_id) ───────────────────

export interface JudicialHearingRepo {
  // tables: justice.case_hearings (PK (case_id,hearing_index)). NEVER selects
  // solution_summary/solution (they are not on the table row type — §2.1).
  listForCase(caseId: string): Promise<Result<readonly JudicialHearing[], ApiError>>;
}

export interface JudicialAppealRepo {
  listForCase(caseId: string): Promise<Result<readonly JudicialAppeal[], ApiError>>;
}

// ── Parties (NAME-FREE) ─────────────────────────────────────────────────────────

export interface JudicialPartyRepo {
  // tables: justice.case_parties (PK (case_id,party_index)). SELECTs no name column.
  listForCase(caseId: string): Promise<Result<readonly JudicialParty[], ApiError>>;
}

// ── Party dictionary — the GATED name surface (§3) ─────────────────────────────

/**
 * The SOLE reader of `justice.party_name_keys.display_name`. Every method reads
 * `display_name` INSIDE the repo and returns it only wrapped as `PublishableName`,
 * and only for name-keys that trace to a publishable case_party row (classifier
 * rule in `PUBLISHABLE_RULES` + recognized classifier version). `display_name`
 * never escapes as a raw string.
 */
export interface PartyDictionaryRepo {
  getPublishableName(nameKeyId: string): Promise<Result<PublishableName | null, ApiError>>;
  /** DataLoader batch — order/arity preserved; non-publishable keys absent from the map. */
  getPublishableNames(
    nameKeyIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, PublishableName>, ApiError>>;
  /** Name → name_key resolution for filters (company/public dictionary ONLY). */
  resolveCompanyName(q: string, limit: number): Promise<Result<readonly PublishableName[], ApiError>>;
}

// ── Company-litigation links (GATED; published-only; empty until gate #9) ──────

/** Optional JD-1 narrowing filters (plan §7.3). All empty in v1 (no published rows). */
export interface CompanyLitigationFilter {
  readonly courtLevels?: readonly string[];
  readonly yearFrom?: number;
  readonly yearTo?: number;
  readonly categories?: readonly string[];
}

export interface JudicialCompanyLinkRepo {
  // tables: justice.party_company_candidates (status='published' ONLY) + case_parties + cases.
  // Returns COUNTS + case ids + publishable company name (from the gated dictionary,
  // NEVER candidate_company_name); NEVER person rows.
  summaryForCui(
    cui: string,
    filter?: CompanyLitigationFilter
  ): Promise<Result<JudicialCompanyLitigation, ApiError>>; // JD-1
  listCasesForCui(
    cui: string,
    page: CursorPageRequest,
    filter?: CompanyLitigationFilter
  ): Promise<Result<CursorPage<JudicialCaseLink>, ApiError>>;
}

// ── Legal references (safe; empty until gate #11) ──────────────────────────────

export interface JudicialLegalRefRepo {
  // tables: justice.case_legal_references. EXCLUDES source_field='solution_summary'
  // rows (S2); SELECTs act_type/number/year + a normalized citation token only,
  // never the raw source span.
  listForCase(caseId: string): Promise<Result<readonly JudicialLegalRef[], ApiError>>; // JD-3
  casesCitingAct(
    targetActId: string,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<JudicialCaseCitation>, ApiError>>;
}

// ── Lineage candidates (candidate-only; empty until gate #10) ──────────────────

export interface JudicialLineageRepo {
  lineageForCase(caseId: string): Promise<Result<readonly JudicialLineageEdge[], ApiError>>; // JD-4
}
