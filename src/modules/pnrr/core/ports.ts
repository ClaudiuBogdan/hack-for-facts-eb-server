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

/** A first/after cursor page request (the kernel cursor envelope binds the fhash). */
export interface CursorPageRequest {
  readonly first: number;
  readonly after?: string;
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
  /** Bounded to the commitment's (beneficiary_cui, contract_number) so unlinked snapshots stay reachable. */
  getCommitmentProgress(
    commitmentKey: string
  ): Promise<Result<readonly PnrrCommitmentSnapshot[], ApiError>>;
  listProgramIndicators(): Promise<Result<readonly PnrrProgramIndicator[], ApiError>>;

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
