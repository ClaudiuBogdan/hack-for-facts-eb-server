/**
 * Primarii-transparency module — usecases (plan §4). Framework-free functions over
 * the repo port + the kernel `IdentityRepo` (for per-entity territory enrichment and
 * the `siruta` resolve dim). All return `Result<T, ApiError>`.
 *
 * GRAIN GATE (§4): the usecases NEVER compute a spend total. `amount_ron` flows only
 * through `listSalaryClaims` as a disclosure claim; no usecase sums it.
 *
 * Territory ENRICHMENT (per-entity `territory` field) works via the kernel
 * `territoryForCui` point lookup. Territory FILTERS (region/siruta/population) are
 * capability-gated in the repo (no kernel set-predicate builder).
 */

import { err, ok, type Result } from 'neverthrow';

import type { PrimariiRepository, CountedCursorPage, CursorPageRequest } from './ports.js';
import type {
  PrimariiCategoryCoverage,
  PrimariiDocument,
  PrimariiEntityProfile,
  PrimariiEntityStatus,
  PrimariiLoadIssue,
  PrimariiResolveDim,
  PrimariiSalaryClaim,
  PrimariiSnapshot,
  PrimariiStatGroupBy,
  PrimariiStatusBucket,
} from './types.js';
import type {
  ApiError,
  Cui,
  FilterInput,
  IdentityRepo,
  ResolveHit,
  Territory,
} from '@/modules/shared/index.js';

export interface PrimariiDeps {
  readonly repo: PrimariiRepository;
  readonly identityRepo: IdentityRepo; // kernel — territoryForCui + name search
}

export const listTransparencyEntities = (
  deps: PrimariiDeps,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CountedCursorPage<PrimariiEntityStatus>, ApiError>> =>
  deps.repo.listEntities(filter, page);

export const getEntityTransparencyProfile = (
  deps: PrimariiDeps,
  cui: Cui
): Promise<Result<PrimariiEntityProfile | null, ApiError>> => deps.repo.getEntityProfile(cui);

export const listEntityDocuments = (
  deps: PrimariiDeps,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CountedCursorPage<PrimariiDocument>, ApiError>> =>
  deps.repo.listDocuments(filter, page);

export const listEntitySnapshots = (
  deps: PrimariiDeps,
  cui: Cui,
  page: CursorPageRequest
): Promise<Result<CountedCursorPage<PrimariiSnapshot>, ApiError>> =>
  deps.repo.listSnapshots(cui, page);

export const listSalaryClaims = (
  deps: PrimariiDeps,
  cui: Cui,
  page: CursorPageRequest
): Promise<Result<CountedCursorPage<PrimariiSalaryClaim>, ApiError>> =>
  deps.repo.listSalaryClaims(cui, page);

export const getTransparencyStats = (
  deps: PrimariiDeps,
  groupBy: PrimariiStatGroupBy,
  filter: FilterInput
): Promise<Result<readonly PrimariiStatusBucket[], ApiError>> =>
  deps.repo.aggregateStatus(groupBy, filter);

export const getCategoryCoverage = (
  deps: PrimariiDeps,
  filter: FilterInput
): Promise<Result<readonly PrimariiCategoryCoverage[], ApiError>> =>
  deps.repo.aggregateCategoryCoverage(filter);

export const listLoadIssues = (
  deps: PrimariiDeps,
  filter: { cui?: string; severity?: string; issueCode?: string },
  limit: number
): Promise<Result<readonly PrimariiLoadIssue[], ApiError>> =>
  deps.repo.listLoadIssues(filter, limit);

/** Per-entity territory via the kernel cui→territory resolver (DataLoader-friendly). */
export const territoryForEntity = (
  deps: PrimariiDeps,
  cui: Cui
): Promise<Result<Territory | null, ApiError>> => deps.identityRepo.territoryForCui(cui);

/**
 * Discovery: name→value. entity/county/status are repo-backed; `siruta` delegates to
 * the kernel identity name search. NOTE: this schema has NO SIRUTA column, so the
 * `siruta` dim does NOT return a SIRUTA code — it returns the matching UAT's **CUI**
 * (`kind:'entity'`), which is the usable key for this module (the SIRUTA-keyed
 * geographic FILTERS are capability-gated anyway). The client feeds the CUI to a
 * territory lookup if it needs the canonical SIRUTA. The repo never joins core.*.
 */
export const resolveFilters = async (
  deps: PrimariiDeps,
  dim: PrimariiResolveDim,
  q: string,
  limit: number
): Promise<Result<readonly ResolveHit[], ApiError>> => {
  if (dim === 'siruta') {
    const res = await deps.identityRepo.searchByName(q, limit);
    if (res.isErr()) return err(res.error);
    const hits: ResolveHit[] = [];
    for (const m of res.value) {
      if (m.cui === null) continue;
      hits.push({
        kind: 'entity',
        value: m.cui,
        label: m.name,
        ...(m.countyName !== null && { hint: m.countyName }),
      });
    }
    return ok(hits);
  }
  return deps.repo.resolve(dim, q, limit);
};
