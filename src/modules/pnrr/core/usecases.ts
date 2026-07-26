/**
 * PNRR module — usecases (plan §4). Framework-free, over `PnrrRepository`.
 * Thin: GraphQL + MCP call the SAME usecase. `getPnrrEntityProfile` is the single
 * source of truth for the entity rollup — the contributor's `profileSlice`, the
 * GraphQL `Entity.pnrr` resolver, and `PnrrEntity.profile` all go through it
 * (§14.7 contributor parity).
 */

import type { CursorPageRequest, PnrrRepository } from './ports.js';
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

export const listPnrrEntities = (
  repo: PnrrRepository,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<PnrrEntity>, ApiError>> => repo.listEntities(filter, page);

export const getPnrrEntity = (
  repo: PnrrRepository,
  cui: string
): Promise<Result<PnrrEntity | null, ApiError>> => repo.getEntity(cui);

export const getPnrrEntityProfile = (
  repo: PnrrRepository,
  cui: string
): Promise<Result<PnrrEntityProfile | null, ApiError>> => repo.getEntityProfile(cui);

export const listPnrrPayments = (
  repo: PnrrRepository,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<PnrrPayment>, ApiError>> => repo.listPayments(filter, page);

export const aggregatePnrrPayments = (
  repo: PnrrRepository,
  filter: FilterInput,
  by: PnrrPaymentGroupBy
): Promise<Result<readonly PnrrPaymentAggRow[], ApiError>> => repo.aggregatePayments(filter, by);

export const listPnrrCommitments = (
  repo: PnrrRepository,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<PnrrCommitment>, ApiError>> => repo.listCommitments(filter, page);

export const getPnrrCommitment = (
  repo: PnrrRepository,
  key: string
): Promise<Result<PnrrCommitment | null, ApiError>> => repo.getCommitment(key);

export const getPnrrCommitmentProgress = (
  repo: PnrrRepository,
  commitmentKey: string
): Promise<Result<readonly PnrrCommitmentSnapshot[], ApiError>> =>
  repo.getCommitmentProgress(commitmentKey);

export const listPnrrProjects = (
  repo: PnrrRepository,
  filter: FilterInput,
  page: CursorPageRequest,
  releaseId?: string
): Promise<Result<CursorPage<PnrrProject>, ApiError>> => repo.listProjects(filter, page, releaseId);

export const getPnrrProject = (
  repo: PnrrRepository,
  key: string
): Promise<Result<PnrrProject | null, ApiError>> => repo.getProject(key);

export const getPnrrProjectHistory = (
  repo: PnrrRepository,
  key: string
): Promise<Result<readonly PnrrProject[], ApiError>> => repo.getProjectHistory(key);

export const getPnrrProjectFacets = (
  repo: PnrrRepository,
  filter: FilterInput
): Promise<Result<PnrrProjectFacets, ApiError>> => repo.getProjectFacets(filter);

export const listPnrrProgramIndicators = (
  repo: PnrrRepository
): Promise<Result<readonly PnrrProgramIndicator[], ApiError>> => repo.listProgramIndicators();

export const listPnrrFundingCalls = (
  repo: PnrrRepository,
  page: CursorPageRequest,
  releaseId?: string
): Promise<Result<CursorPage<PnrrFundingCall>, ApiError>> => repo.listFundingCalls(page, releaseId);

export const listPnrrFundingApplicationListings = (
  repo: PnrrRepository,
  page: CursorPageRequest,
  releaseId?: string
): Promise<Result<CursorPage<PnrrFundingApplicationListing>, ApiError>> =>
  repo.listFundingApplicationListings(page, releaseId);

export const listPnrrProgramRevisions = (
  repo: PnrrRepository,
  page: CursorPageRequest,
  releaseId?: string
): Promise<Result<CursorPage<PnrrProgramRevision>, ApiError>> =>
  repo.listProgramRevisions(page, releaseId);

export const listPnrrCatalogResources = (
  repo: PnrrRepository,
  page: CursorPageRequest,
  releaseId?: string
): Promise<Result<CursorPage<PnrrCatalogResource>, ApiError>> =>
  repo.listCatalogResources(page, releaseId);

export const listPnrrDocumentReferences = (
  repo: PnrrRepository,
  page: CursorPageRequest,
  releaseId?: string
): Promise<Result<CursorPage<PnrrDocumentReference>, ApiError>> =>
  repo.listDocumentReferences(page, releaseId);

export const getPnrrCurrentRelease = (
  repo: PnrrRepository
): Promise<Result<PnrrRelease, ApiError>> => repo.getCurrentRelease();

export const getPnrrCapabilities = (
  repo: PnrrRepository
): Promise<Result<readonly PnrrCapability[], ApiError>> => repo.getCapabilities();

export const getPnrrOverview = (
  repo: PnrrRepository,
  scope: PnrrAnalysisScope
): Promise<Result<PnrrOverview, ApiError>> => repo.getOverview(scope);

export const getPnrrPlaceProfile = (
  repo: PnrrRepository,
  countySiruta: string,
  scope: PnrrAnalysisScope
): Promise<Result<PnrrPlaceProfile | null, ApiError>> => repo.getPlaceProfile(countySiruta, scope);

export const listPnrrPlaces = (
  repo: PnrrRepository,
  scope: PnrrAnalysisScope
): Promise<Result<readonly PnrrPlaceSummary[], ApiError>> => repo.listPlaces(scope);

export const getPnrrVerification = (
  repo: PnrrRepository,
  scope: PnrrAnalysisScope
): Promise<Result<PnrrVerificationSummary, ApiError>> => repo.getVerification(scope);

export const listPnrrAcquisitions = (
  repo: PnrrRepository,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<PnrrAcquisition>, ApiError>> => repo.listAcquisitions(filter, page);

export const getPnrrAcquisition = (
  repo: PnrrRepository,
  key: string
): Promise<Result<PnrrAcquisitionDetail | null, ApiError>> => repo.getAcquisition(key);

export const listPnrrContractors = (
  repo: PnrrRepository,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<PnrrContractor>, ApiError>> => repo.listContractors(filter, page);

export const rankPnrrContractors = (
  repo: PnrrRepository,
  filter: FilterInput,
  by: PnrrContractorRankBy,
  limit: number
): Promise<Result<readonly PnrrContractorRankRow[], ApiError>> =>
  repo.rankContractors(filter, by, limit);

export const listPnrrComponents = (
  repo: PnrrRepository
): Promise<Result<readonly PnrrComponent[], ApiError>> => repo.listComponents();

export const listPnrrMeasures = (
  repo: PnrrRepository,
  filter: FilterInput
): Promise<Result<readonly PnrrMeasure[], ApiError>> => repo.listMeasures(filter);

export const resolvePnrrFilters = (
  repo: PnrrRepository,
  dim: PnrrResolveDim,
  q: string,
  limit: number
): Promise<Result<readonly PnrrResolveHit[], ApiError>> => repo.resolveDimension(dim, q, limit);
