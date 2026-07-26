/**
 * PNRR module — repository port (plan §3).
 *
 * One `PnrrRepository`; every method returns `Result<T, ApiError>` (neverthrow).
 * Reads `pnrr.*` only (kernel hubs come through the kernel repos, never inline).
 * Money columns are cast to text at the SQL boundary so the int8/numeric parser
 * config can't precision-lose. The 741k `commitment_snapshots` table is always
 * reached through an indexed predicate (the lazy batch loaders + the dedicated
 * progress method are the only entry points).
 */

import type {
  PnrrAcquisition,
  PnrrAcquisitionDetail,
  PnrrCommitment,
  PnrrCommitmentSnapshot,
  PnrrComponent,
  PnrrContractor,
  PnrrContractorRankBy,
  PnrrContractorRankRow,
  PnrrEntity,
  PnrrEntityProfile,
  PnrrFundingApplicationListing,
  PnrrFundingCall,
  PnrrCatalogResource,
  PnrrDocumentReference,
  PnrrMeasure,
  PnrrAnalysisScope,
  PnrrCapability,
  PnrrOverview,
  PnrrPlaceProfile,
  PnrrPlaceSummary,
  PnrrProject,
  PnrrProjectFacets,
  PnrrRelease,
  PnrrVerificationSummary,
  PnrrPayment,
  PnrrPaymentAggRow,
  PnrrPaymentGroupBy,
  PnrrProgramIndicator,
  PnrrProgramRevision,
  PnrrResolveDim,
  PnrrResolveHit,
} from './types.js';
import type { ApiError, CursorPage, FilterInput } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/** A first/after cursor page request (the kernel cursor envelope binds the fhash). */
export interface CursorPageRequest {
  readonly first: number;
  readonly after?: string;
  /** Release observed at request start; serving surfaces always provide it. */
  readonly releaseId?: string;
}

export interface PnrrRepository {
  // ── identity spine (headline) ──
  listEntities(
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrEntity>, ApiError>>;
  getEntity(cui: string): Promise<Result<PnrrEntity | null, ApiError>>;
  getEntityProfile(cui: string): Promise<Result<PnrrEntityProfile | null, ApiError>>;

  // ── ledger ──
  listPayments(
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrPayment>, ApiError>>;
  aggregatePayments(
    f: FilterInput,
    by: PnrrPaymentGroupBy
  ): Promise<Result<readonly PnrrPaymentAggRow[], ApiError>>;
  listCommitments(
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrCommitment>, ApiError>>;
  getCommitment(key: string): Promise<Result<PnrrCommitment | null, ApiError>>;
  /** Bounded to snapshots explicitly linked by commitment_key. */
  getCommitmentProgress(
    commitmentKey: string
  ): Promise<Result<readonly PnrrCommitmentSnapshot[], ApiError>>;
  listProgramIndicators(): Promise<Result<readonly PnrrProgramIndicator[], ApiError>>;
  listFundingCalls(
    page: CursorPageRequest,
    releaseId?: string
  ): Promise<Result<CursorPage<PnrrFundingCall>, ApiError>>;
  listFundingApplicationListings(
    page: CursorPageRequest,
    releaseId?: string
  ): Promise<Result<CursorPage<PnrrFundingApplicationListing>, ApiError>>;
  listProgramRevisions(
    page: CursorPageRequest,
    releaseId?: string
  ): Promise<Result<CursorPage<PnrrProgramRevision>, ApiError>>;
  listCatalogResources(
    page: CursorPageRequest,
    releaseId?: string
  ): Promise<Result<CursorPage<PnrrCatalogResource>, ApiError>>;
  listDocumentReferences(
    page: CursorPageRequest,
    releaseId?: string
  ): Promise<Result<CursorPage<PnrrDocumentReference>, ApiError>>;

  // ── source-aware explorer ──
  listProjects(
    f: FilterInput,
    page: CursorPageRequest,
    releaseId?: string
  ): Promise<Result<CursorPage<PnrrProject>, ApiError>>;
  getProject(key: string): Promise<Result<PnrrProject | null, ApiError>>;
  getProjectHistory(key: string): Promise<Result<readonly PnrrProject[], ApiError>>;
  getProjectFacets(f: FilterInput): Promise<Result<PnrrProjectFacets, ApiError>>;
  getCurrentRelease(): Promise<Result<PnrrRelease, ApiError>>;
  getCapabilities(): Promise<Result<readonly PnrrCapability[], ApiError>>;
  getOverview(scope: PnrrAnalysisScope): Promise<Result<PnrrOverview, ApiError>>;
  getPlaceProfile(
    countySiruta: string,
    scope: PnrrAnalysisScope
  ): Promise<Result<PnrrPlaceProfile | null, ApiError>>;
  listPlaces(scope: PnrrAnalysisScope): Promise<Result<readonly PnrrPlaceSummary[], ApiError>>;
  getVerification(scope: PnrrAnalysisScope): Promise<Result<PnrrVerificationSummary, ApiError>>;

  // ── procurement graph ──
  listAcquisitions(
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrAcquisition>, ApiError>>;
  getAcquisition(key: string): Promise<Result<PnrrAcquisitionDetail | null, ApiError>>;
  listContractors(
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrContractor>, ApiError>>;
  rankContractors(
    f: FilterInput,
    by: PnrrContractorRankBy,
    limit: number
  ): Promise<Result<readonly PnrrContractorRankRow[], ApiError>>;

  // ── batched lazy resolvers (GraphQL fan-out; avoid N+1) ──
  contractorsForAcquisitions(
    keys: readonly string[]
  ): Promise<Result<ReadonlyMap<string, readonly PnrrContractor[]>, ApiError>>;

  // ── taxonomy / dimensions (also feeds filter resolve) ──
  listComponents(): Promise<Result<readonly PnrrComponent[], ApiError>>;
  listMeasures(f: FilterInput): Promise<Result<readonly PnrrMeasure[], ApiError>>;
  resolveDimension(
    dim: PnrrResolveDim,
    q: string,
    limit: number
  ): Promise<Result<readonly PnrrResolveHit[], ApiError>>;
}
