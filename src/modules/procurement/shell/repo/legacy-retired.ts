/**
 * PROCUREMENT_LEGACY_ENABLED=false: the legacy procurement reads leave the
 * public surface (SEC-GRANTS-PROC-2211, owner-approved 2026-11-22). The API's
 * public-only grant covers none of the legacy relations (`procurement.*`
 * records, `analysis_generations`, `etl.load_runs`, `core.organizations`, the
 * legacy ClickHouse facts), so every legacy read answers ServiceUnavailable
 * WITHOUT a legacy query instead of failing on a permission error. (With the
 * DA v3 reader on, an analysis request still resolves the DA generation from
 * procurement_v3, and a legacy grain's block abstains as unavailable.)
 *
 * Unaffected: the CPV reference reads (`procurement.cpv_divisions` and
 * `cpv_codes`, public labels the grant keeps; owner decision 2026-11-22), the
 * direct-acquisition release 1 and v3 analysis grain, and totals v2.
 */

import { err, type Result } from 'neverthrow';

import { serviceUnavailable, type ApiError } from '@/modules/shared/index.js';

import type { AnalysisRepo, ProcurementRepo } from '../../core/ports.js';
import type { ProcurementContributorRepo } from '../contributor.js';

export const LEGACY_RETIRED_MESSAGE =
  'legacy procurement data is not served by this API; use the direct-acquisition release (procurementDa*) or procurementTotals';

const retired = (): Promise<Result<never, ApiError>> =>
  Promise.resolve(err(serviceUnavailable(LEGACY_RETIRED_MESSAGE)));

/** Every record read retired; the CPV reference reads delegate unchanged. */
export const retireLegacyRecords = (repo: ProcurementRepo): ProcurementRepo => ({
  listProcedures: retired,
  getProcedure: retired,
  getProcedureDetail: retired,
  listContracts: retired,
  getContract: retired,
  getContractDetail: retired,
  getContractModifications: retired,
  listDirectAcquisitions: retired,
  getDirectAcquisition: retired,
  getDirectAcquisitionDetail: retired,
  listModifications: retired,
  listModificationsAboveDelta: retired,
  listCpvDivisions: () => repo.listCpvDivisions(),
  listCpvCodeLabels: (codes) => repo.listCpvCodeLabels(codes),
  resolveCpv: (q, limit) => repo.resolveCpv(q, limit),
  searchProceduresOffset: retired,
  searchContractsOffset: retired,
  searchDirectAcquisitionsOffset: retired,
  searchModificationsOffset: retired,
  modificationsForContracts: retired,
  contractsByIds: retired,
  elicitatiePagesForContracts: retired,
  elicitatiePagesForModifications: retired,
  elicitatiePagesForProcedures: retired,
  elicitatiePagesForDirectAcquisitions: retired,
  supplierRecords: retired,
});

/**
 * The legacy (ClickHouse) analysis backend, retired: every grain it answers is
 * ServiceUnavailable. With the DA v3 reader on, the routing repo still answers
 * the direct_acquisition grain from procurement_v3.
 */
export const makeRetiredAnalysisRepo = (): AnalysisRepo => ({
  activeGeneration: retired,
  basisCoverage: retired,
  statsFor: retired,
  seriesFor: retired,
  distinctSeriesFor: retired,
  breakdownFor: retired,
  concentrationFor: retired,
  recordsFor: retired,
  procedureCanonicalityBuild: retired,
  procedureCanonicality: retired,
  procedureDuplicates: retired,
});

/**
 * Entity-360 presence, retired: an error (never "absent"), so the presence
 * fan-out drops procurement and the profile slice says it is unavailable.
 */
export const retiredPresenceRepo: ProcurementContributorRepo = { presenceCounts: retired };
