/**
 * Assembling a direct-acquisition detail bundle.
 *
 * The bundle has a REQUIRED half and an OPTIONAL half, and conflating them is
 * how a whole page dies over a section:
 *
 *  - required — the acquisition row itself (+ its dedup siblings). A failure
 *    here IS a failure of the answer and stays an error; a missing row stays a
 *    404 and must never be dressed up as a transient problem.
 *  - optional — `procurement.da_details`. It exists for ONE source family, is
 *    still being backfilled inside that family, and can be unavailable on its
 *    own (statement timeout, a projection mid-rollout). Every one of those is a
 *    fact about the detail section, not about the acquisition — so each resolves
 *    to a typed availability state and the valid base record is still served.
 *
 * Absence of a detail is NEVER absence of a purchase. That is why this returns a
 * state instead of an empty section: the caller has to say which kind of absence
 * it is.
 */

import type {
  DaDetailAvailability,
  DaDetailBody,
  DirectAcquisitionDetail,
  DuplicateRef,
  ProcurementDirectAcquisition,
} from '../../core/types.js';

/**
 * The only direct-acquisition family with a detail feed behind it.
 *
 * `seap_da` / `seap_dan` were loaded from the official bulk XLSX exports, which
 * publish the summary row and nothing else — there is no item-detail source in
 * existence for them and there never will be. A `da_details` lookup for one of
 * those rows is therefore a query whose answer is known in advance (no row), so
 * we don't run it: it is wasted work on a per-request path, and its own failure
 * modes would otherwise degrade a record whose availability is already certain.
 */
const DA_DETAIL_FEED_SOURCES: ReadonlySet<string> = new Set(['elicitatie_da']);

/** Does a detail feed exist for this source family at all? (Permanent fact.) */
export const daDetailFeedExists = (sourceSystem: string): boolean =>
  DA_DETAIL_FEED_SOURCES.has(sourceSystem);

/** Just the levels this path uses; the kernel `Logger` satisfies it structurally. */
export interface DaDetailBundleLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error?(obj: Record<string, unknown>, msg: string): void;
}

export interface DaDetailBundleInput {
  /** Already loaded — this function never fails, so the base record is safe. */
  readonly da: ProcurementDirectAcquisition;
  readonly duplicates: readonly DuplicateRef[];
  /**
   * Reads the OPTIONAL detail body for this DA. Resolves `null` when no row
   * exists; REJECTS when the lookup itself failed. The two are different
   * answers and are reported as different states.
   */
  readonly loadDetailBody: (daId: string) => Promise<DaDetailBody | null>;
  readonly logger?: DaDetailBundleLogger;
}

/**
 * A degraded optional lookup must be visible in the logs even though the request
 * succeeded — a silent `temporarily_unavailable` looks exactly like a healthy
 * gap from the outside.
 */
const logDetailLookupFailure = (
  logger: DaDetailBundleLogger | undefined,
  da: ProcurementDirectAcquisition,
  error: unknown
): void => {
  if (logger === undefined) return;
  const payload = {
    daId: da.daId,
    sourceSystem: da.sourceSystem,
    err: error instanceof Error ? { name: error.name, message: error.message } : String(error),
  };
  const message =
    'da-detail lookup FAILED; serving the base direct acquisition with detailAvailability=temporarily_unavailable';
  if (logger.error !== undefined) logger.error(payload, message);
  else logger.warn(payload, message);
};

/**
 * Compose the bundle, resolving the optional detail half into one of the four
 * availability states. Never fails: the required half is already in hand.
 */
export const assembleDirectAcquisitionDetail = async ({
  da,
  duplicates,
  loadDetailBody,
  logger,
}: DaDetailBundleInput): Promise<DirectAcquisitionDetail> => {
  const bundle = (
    detail: DaDetailBody | null,
    detailAvailability: DaDetailAvailability
  ): DirectAcquisitionDetail => ({ detail, detailAvailability, directAcquisition: da, duplicates });

  // Permanent, and knowable without touching the database.
  if (!daDetailFeedExists(da.sourceSystem)) return bundle(null, 'not_available_for_source');

  try {
    const body = await loadDetailBody(da.daId);
    // A feed exists and this row is not in it yet — the backfill gap, NOT a
    // failure, and not a claim that the source published nothing.
    return body === null ? bundle(null, 'not_captured') : bundle(body, 'available');
  } catch (error) {
    logDetailLookupFailure(logger, da, error);
    return bundle(null, 'temporarily_unavailable');
  }
};
