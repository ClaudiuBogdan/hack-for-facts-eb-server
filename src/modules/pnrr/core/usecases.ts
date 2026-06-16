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
  PnrrMeasure,
  PnrrPayment,
  PnrrPaymentAggRow,
  PnrrPaymentGroupBy,
  PnrrProgramIndicator,
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

export const getPnrrCommitmentProgress = (
  repo: PnrrRepository,
  commitmentKey: string
): Promise<Result<readonly PnrrCommitmentSnapshot[], ApiError>> =>
  repo.getCommitmentProgress(commitmentKey);

export const listPnrrProgramIndicators = (
  repo: PnrrRepository
): Promise<Result<readonly PnrrProgramIndicator[], ApiError>> => repo.listProgramIndicators();

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
