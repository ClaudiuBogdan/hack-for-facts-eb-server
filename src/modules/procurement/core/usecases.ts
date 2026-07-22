/**
 * Procurement module — usecases (plan §4). Framework-free, over the ports,
 * `Result`-returning. GraphQL + MCP call the SAME usecase → tri-surface parity.
 *
 * The six-shape analysis surface (stats/series/breakdown/concentration/share/
 * facets), including generation quality enforcement, lives in
 * `analysis-usecases.ts` over the scraper-built rollup package.
 *
 * Base-table search/detail usecases are thin pass-throughs (no gate — the gate is an
 * AGGREGATE concept; base lists are bounded by indexed predicates + cursor instead).
 */

import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  type ApiError,
  type CursorPage,
  type FilterInput,
} from '@/modules/shared/index.js';

import type { CursorPageRequest, ProcurementRepo } from './ports.js';
import type {
  ContractDetail,
  CpvCodeLabel,
  CpvDivision,
  CpvMatch,
  DirectAcquisitionDetail,
  ProcedureDetail,
  ProcurementContract,
  ProcurementDirectAcquisition,
  ProcurementModification,
  ProcurementProcedure,
  SupplierRecordConnection,
} from './types.js';

// ── base-table search / detail (no gate; index-bounded + cursor) ───────────────

export const searchProcedures = (
  repo: ProcurementRepo,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<ProcurementProcedure>, ApiError>> => repo.listProcedures(filter, page);

export const getProcedureDetail = (
  repo: ProcurementRepo,
  id: string
): Promise<Result<ProcedureDetail | null, ApiError>> => repo.getProcedureDetail(id);

export const searchContracts = (
  repo: ProcurementRepo,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<ProcurementContract>, ApiError>> => repo.listContracts(filter, page);

export const getContractDetail = (
  repo: ProcurementRepo,
  id: string
): Promise<Result<ContractDetail | null, ApiError>> => repo.getContractDetail(id);

export const searchDirectAcquisitions = (
  repo: ProcurementRepo,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<ProcurementDirectAcquisition>, ApiError>> =>
  repo.listDirectAcquisitions(filter, page);

export const getDirectAcquisitionDetail = (
  repo: ProcurementRepo,
  id: string
): Promise<Result<ProcurementDirectAcquisition | null, ApiError>> => repo.getDirectAcquisition(id);

export const listModifications = (
  repo: ProcurementRepo,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<ProcurementModification>, ApiError>> =>
  repo.listModifications(filter, page);

export const listModificationsAboveDelta = (
  repo: ProcurementRepo,
  pct: number,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<ProcurementModification>, ApiError>> =>
  repo.listModificationsAboveDelta(pct, filter, page);

export const listCpvDivisions = (
  repo: ProcurementRepo
): Promise<Result<readonly CpvDivision[], ApiError>> => repo.listCpvDivisions();

/** Batch label lookup capped to one leaderboard page worth of codes. */
export const CPV_CODES_LOOKUP_MAX = 200;

export const listCpvCodeLabels = async (
  repo: ProcurementRepo,
  codes: readonly string[]
): Promise<Result<readonly CpvCodeLabel[], ApiError>> => {
  const distinct = [...new Set(codes.map((c) => c.trim()).filter((c) => c !== ''))];
  if (distinct.length === 0) return ok([]);
  if (distinct.length > CPV_CODES_LOOKUP_MAX) {
    return err(
      invalidInput(`codes accepts at most ${String(CPV_CODES_LOOKUP_MAX)} distinct codes`, 'codes')
    );
  }
  return repo.listCpvCodeLabels(distinct);
};

export const resolveCpv = (
  repo: ProcurementRepo,
  q: string,
  limit: number
): Promise<Result<readonly CpvMatch[], ApiError>> => repo.resolveCpv(q, limit);

// ── detail bundles + supplier records ─────────────────────────────────────────

export const getDirectAcquisitionBundle = (
  repo: ProcurementRepo,
  id: string
): Promise<Result<DirectAcquisitionDetail | null, ApiError>> => repo.getDirectAcquisitionDetail(id);

export const getSupplierRecords = (
  repo: ProcurementRepo,
  supplierCui: string,
  first: number,
  after: string | undefined
): Promise<Result<SupplierRecordConnection, ApiError>> =>
  repo.supplierRecords(supplierCui, first, after);
