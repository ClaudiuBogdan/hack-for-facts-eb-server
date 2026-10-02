/**
 * Procurement analysis — source-reported amounts and source catalogue
 * recency (R8).
 *
 * Each loader stage records what the raw capture's catalogues held when it
 * ran: the SEAP export catalogue (latest listed year per file family) and the
 * e-licitatie listing windows. That is catalogue recency, never loaded
 * coverage: a listed file may not have been loaded, and a latest completed
 * listing window is an edge, not continuous coverage. A grain reads only the
 * receipt of the stage that loads it; without one, its note says unknown.
 * These notes travel in the envelope's existing `caveats`.
 */

import type { AnalysisGrain } from './constants.js';

/** One e-licitatie listing route, as the loader recorded it. */
export type ListingRouteCapture =
  | { readonly status: 'unknown' }
  | {
      readonly status: 'recency_only';
      readonly latestSucceededWindowEnd: string;
      readonly latestCompletedAt: string | null;
      readonly unfinishedWindowsBefore: number;
    };

/** The catalogue block of one loader stage run. */
export interface SourceCaptureSummary {
  readonly seap: Readonly<Record<string, { readonly latestYear: number | null }>>;
  readonly elicitatie: Readonly<Record<string, ListingRouteCapture>>;
}

/** Receipts keyed by the loaded table (the stage's load-run target). */
export type SourceCaptureReceipts = Readonly<Record<string, SourceCaptureSummary>>;

export const SOURCE_REPORTED_NOTE =
  'procurement amounts are source-reported and may include source errors; they are not verified payments';

const CATALOGUE_PREFIX = 'source catalogue, not loaded coverage';

interface GrainSources {
  /** The load-run target whose receipt describes this grain's load. */
  readonly receipt: string | null;
  readonly seapFamilies: readonly string[];
  readonly seapLabel: string;
  readonly listing: readonly [route: string, label: string] | null;
}

const CA_NOTICES = ['elicitatie_ca_notice_list', 'award notices'] as const;

const GRAIN_SOURCES: Readonly<Record<AnalysisGrain, GrainSources>> = {
  direct_acquisition: {
    receipt: 'procurement.direct_acquisitions',
    seapFamilies: ['direct_acquisition', 'direct_award_notification'],
    seapLabel: 'direct acquisition',
    listing: ['elicitatie_direct_acquisition_page', 'direct acquisitions'],
  },
  procedure: {
    receipt: 'procurement.procedures',
    seapFamilies: ['initiation', 'award_no_init', 'sad'],
    seapLabel: 'notice',
    listing: CA_NOTICES,
  },
  contract: {
    receipt: 'procurement.contracts',
    seapFamilies: ['contract'],
    seapLabel: 'contract',
    listing: CA_NOTICES,
  },
  framework: {
    receipt: 'procurement.contracts',
    seapFamilies: ['contract'],
    seapLabel: 'contract',
    listing: CA_NOTICES,
  },
  calloff: {
    receipt: 'procurement.contracts',
    seapFamilies: ['contract', 'subsequent_contract'],
    seapLabel: 'contract and subsequent-contract',
    listing: CA_NOTICES,
  },
  // The modifications stage records no catalogue receipt.
  modification: { receipt: null, seapFamilies: [], seapLabel: '', listing: null },
};

const listingNote = (label: string, route: ListingRouteCapture | undefined): string =>
  route?.status === 'recency_only'
    ? `${CATALOGUE_PREFIX}: latest completed e-licitatie ${label} listing window ends ${route.latestSucceededWindowEnd.slice(0, 10)}; ${String(route.unfinishedWindowsBefore)} earlier windows unfinished`
    : `${CATALOGUE_PREFIX}: e-licitatie ${label} listing unknown`;

const seapNote = (sources: GrainSources, capture: SourceCaptureSummary): string => {
  const years = sources.seapFamilies
    .map((family) => capture.seap[family]?.latestYear ?? null)
    .filter((year): year is number => year !== null);
  return years.length === 0
    ? `${CATALOGUE_PREFIX}: SEAP ${sources.seapLabel} exports unknown`
    : `${CATALOGUE_PREFIX}: SEAP ${sources.seapLabel} export files listed up to year ${String(Math.max(...years))}`;
};

/**
 * The source notes for one grain. `undefined` means the repository does not
 * read receipts (no note); `null`, or no receipt for this grain's stage, is
 * stated as unknown.
 */
export const sourceNotes = (
  grain: AnalysisGrain,
  receipts: SourceCaptureReceipts | null | undefined
): readonly string[] => {
  if (receipts === undefined) return [];
  const money = grain === 'modification' ? [] : [SOURCE_REPORTED_NOTE];
  const sources = GRAIN_SOURCES[grain];
  const capture =
    receipts === null || sources.receipt === null ? undefined : receipts[sources.receipt];
  if (capture === undefined) return [...money, `${CATALOGUE_PREFIX}: unknown for this build`];
  const listing =
    sources.listing === null
      ? []
      : [listingNote(sources.listing[1], capture.elicitatie[sources.listing[0]])];
  return [...money, ...listing, seapNote(sources, capture)];
};
