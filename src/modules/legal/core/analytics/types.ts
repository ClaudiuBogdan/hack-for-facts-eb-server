/**
 * Legislation analytics (design §11 of the scrapper's analytics-page design):
 * the types of the insights layer reads. Counts only, never shares: every
 * answer carries its denominator and the uncertain and unplaced remainders,
 * and the caller divides.
 *
 * The layer is the scrapper's `legal_v2_analytics.insights_layer` (one rule
 * bundle over one analytics release), read through the published pointer
 * `current_insights_layer`. The value lists (Felul groups and kinds, weak
 * placement bases, issuer families, link kinds and notes) come from the
 * layer's own `method.values`, never from this code: a rules change needs no
 * server change.
 */

export const LEGAL_ANALYTICS_VIEWS = [
  'head',
  'summary',
  'breakdown',
  'series',
  'grid',
  'links',
  'acts',
] as const;
export type LegalAnalyticsView = (typeof LEGAL_ANALYTICS_VIEWS)[number];

/**
 * The lenses an act can be counted by. `felul` is the Felul class: the group
 * of a firm placement, `uncertain` for a weak one, `unplaced`; `kind` is the
 * kind of a firm placement, else `uncertain`/`unplaced`.
 */
export const LEGAL_ANALYTICS_LENSES = [
  'felul',
  'kind',
  'issuer',
  'family',
  'type',
  'versions',
  'year',
] as const;
export type LegalAnalyticsLens = (typeof LEGAL_ANALYTICS_LENSES)[number];

/** The acts list's orders: times amended, times named by a court, consolidations, citing acts, year. */
export const LEGAL_ANALYTICS_ORDERS = ['amended', 'court', 'versions', 'cited', 'year'] as const;
export type LegalAnalyticsOrder = (typeof LEGAL_ANALYTICS_ORDERS)[number];

/** `flow`: every act published; `stock`: the layer's `in_stock` acts (firm placements of a stock kind). */
export const LEGAL_ANALYTICS_POPULATIONS = ['flow', 'stock'] as const;
export type LegalAnalyticsPopulation = (typeof LEGAL_ANALYTICS_POPULATIONS)[number];

/** The Felul class of a weak placement. */
export const UNCERTAIN = 'uncertain';
/** The Felul group (and kind) of an act the rules could not place. */
export const UNPLACED = 'unplaced';

/** The raw arguments of any surface (REST query, GraphQL `args`, MCP `args`), before validation. */
export interface LegalAnalyticsArgs {
  readonly population?: string;
  readonly from?: number;
  readonly to?: number;
  readonly type?: readonly string[];
  readonly issuer?: string;
  readonly family?: string;
  readonly felul?: string;
  readonly versions?: number;
  readonly lens?: string;
  readonly by?: string;
  readonly limit?: number;
  readonly top?: number;
  readonly order?: string;
  readonly cursor?: string;
}

/** The validated filter, the same on every view. Absent = no restriction. */
export interface LegalAnalyticsFilter {
  readonly population: LegalAnalyticsPopulation;
  readonly from: number | null;
  readonly to: number | null;
  /** Normalised types, sorted and distinct. */
  readonly types: readonly string[];
  /** An issuer lineage as the layer names it. */
  readonly issuer: string | null;
  readonly family: string | null;
  /** A Felul group, a kind, `uncertain` or `unplaced`. A group or kind matches firm placements only. */
  readonly felul: string | null;
  /** Version band 0-3 (none, 1-2, 3-9, 10 or more consolidated versions). */
  readonly versions: number | null;
}

/** What every validated request carries: its cache key and canonical arguments (defaults dropped). */
interface LegalAnalyticsRequestBase {
  readonly key: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** A validated request: the view, its filter and its own arguments. */
export type LegalAnalyticsRequest = LegalAnalyticsRequestBase &
  (
    | { readonly view: 'head' }
    | { readonly view: 'summary'; readonly filter: LegalAnalyticsFilter }
    | {
        readonly view: 'breakdown';
        readonly filter: LegalAnalyticsFilter;
        readonly lens: LegalAnalyticsLens;
        readonly limit: number;
      }
    | {
        readonly view: 'series';
        readonly filter: LegalAnalyticsFilter;
        readonly lens: LegalAnalyticsLens;
        readonly top: number;
      }
    | {
        readonly view: 'grid';
        readonly filter: LegalAnalyticsFilter;
        readonly lens: LegalAnalyticsLens;
        readonly by: LegalAnalyticsLens;
      }
    | { readonly view: 'links'; readonly filter: LegalAnalyticsFilter }
    | {
        readonly view: 'acts';
        readonly filter: LegalAnalyticsFilter;
        readonly order: LegalAnalyticsOrder;
        readonly limit: number;
        readonly after: LegalAnalyticsActsCursor | null;
      }
  );

/** The keyset position of the acts list: the sort value and the act id of the last row served. */
export interface LegalAnalyticsActsCursor {
  readonly value: number;
  readonly actId: string;
}

/** The layer's value lists (`insights_layer.method.values`), as the bundle's manifest wrote them. */
export interface LegalAnalyticsValues {
  readonly felulGroups: readonly string[];
  /** kind -> group */
  readonly felulKinds: Readonly<Record<string, string>>;
  readonly stockKinds: readonly string[];
  readonly weakBases: readonly string[];
  readonly issuerFamilies: readonly string[];
  readonly linkKinds: readonly string[];
  readonly linkNotes: readonly string[];
}

/** The published layer a read pinned. Ids are strings (bigint). Times are ISO 8601 UTC. */
export interface LegalAnalyticsLayer {
  readonly layerId: string;
  readonly releaseId: string;
  readonly builtAt: string;
  readonly publishedAt: string;
  /** The analytics release's build and publication: the date the corpus counts were taken. */
  readonly releaseBuiltAt: string;
  readonly releasePublishedAt: string;
}

export interface LegalAnalyticsCount {
  /** The lens value; null for an act without one (no issuer, unknown year). */
  readonly key: string | null;
  readonly acts: number;
}

export interface LegalAnalyticsHead {
  readonly layer: LegalAnalyticsLayer;
  /** Rule versions (`felul`, `issuers`, `links`, `stock`). */
  readonly rules: Readonly<Record<string, string>>;
  readonly values: LegalAnalyticsValues;
  readonly totals: {
    readonly acts: number;
    readonly actsWithText: number;
    readonly inStock: number;
    readonly uncertain: number;
    readonly unplaced: number;
  };
  /** Normalised types, most acts first. */
  readonly types: readonly LegalAnalyticsCount[];
  /**
   * Issuer lineages with their family, most acts first (the filter sheet's list). The head view serves the first
   * HEAD_ISSUERS; every lineage of `issuerCount` is a valid `issuer` filter and appears in a breakdown by issuer.
   */
  readonly issuerCount: number;
  readonly issuers: readonly {
    readonly lineage: string;
    readonly family: string;
    readonly acts: number;
  }[];
  readonly years: { readonly min: number | null; readonly max: number | null };
}

/** The denominators every answer carries, over the request's filter. */
export interface LegalAnalyticsDenominators {
  /** Acts in the selection. */
  readonly total: number;
  /** Acts of the population before the other filters (flow: every act; stock: the stock). */
  readonly population: number;
  /** Weak placements in the selection: in no group's count. */
  readonly uncertain: number;
  /** Acts the rules could not place, in the selection. */
  readonly unplaced: number;
}

export interface LegalAnalyticsSummary extends LegalAnalyticsDenominators {
  readonly withText: number;
  /** Acts with at least one consolidated version. */
  readonly withVersions: number;
  /** Firm placements per Felul group, plus `uncertain` and `unplaced`. */
  readonly felul: readonly LegalAnalyticsCount[];
}

export interface LegalAnalyticsBreakdown extends LegalAnalyticsDenominators {
  readonly lens: LegalAnalyticsLens;
  readonly rows: readonly LegalAnalyticsCount[];
  /** Acts under the values past `limit`. */
  readonly rest: number;
  readonly truncated: boolean;
}

export interface LegalAnalyticsSeries extends LegalAnalyticsDenominators {
  readonly lens: LegalAnalyticsLens;
  /** The top values, then null for every other value together. */
  readonly keys: readonly (string | null)[];
  /** Per year (ascending), the acts under each key, in `keys` order, then the rest. */
  readonly years: readonly { readonly year: number; readonly acts: readonly number[] }[];
  readonly restKey: true;
  readonly unknownYear: number;
}

export interface LegalAnalyticsGrid extends LegalAnalyticsDenominators {
  readonly lens: LegalAnalyticsLens;
  readonly by: LegalAnalyticsLens;
  readonly rows: readonly LegalAnalyticsCount[];
  readonly cols: readonly LegalAnalyticsCount[];
  /** cells[row][col]; the last column is every other `by` value. */
  readonly cells: readonly (readonly number[])[];
}

/** An act a link names, as the privacy gate lets it be shown. */
export interface LegalAnalyticsActRef {
  readonly actId: string;
  readonly citation: string;
  readonly title: string | null;
}

export interface LegalAnalyticsLinks extends LegalAnalyticsDenominators {
  /** Links from acts of the selection, by kind and note (`resolved`, `code`, `outside_corpus`, …). */
  readonly byKind: readonly {
    readonly kind: string;
    readonly note: string;
    readonly links: number;
  }[];
  /** Amending acts by their type band and their target's type band, or the note when there is no target. */
  readonly amends: readonly {
    readonly sourceBand: string;
    readonly target: string;
    readonly links: number;
  }[];
  /** Per link kind, the 30 targets named most often by acts of the selection. */
  readonly topTargets: readonly {
    readonly kind: string;
    readonly target: LegalAnalyticsActRef;
    readonly links: number;
  }[];
  /** Per link kind with a resolved target: days from the target's first publication to the source's (quartiles, whole days). */
  readonly days: readonly {
    readonly kind: string;
    readonly links: number;
    readonly p25: number | null;
    readonly median: number | null;
    readonly p75: number | null;
  }[];
}

export interface LegalAnalyticsActRow extends LegalAnalyticsActRef {
  readonly year: number | null;
  readonly type: string;
  readonly issuer: string | null;
  readonly family: string;
  /** The Felul class (group, `uncertain` or `unplaced`) and, for a weak placement, the rules' guess. */
  readonly felul: string;
  readonly kind: string;
  readonly guess: { readonly group: string; readonly kind: string } | null;
  readonly amended: number;
  readonly court: number;
  readonly versions: number;
  readonly cited: number;
  readonly hasText: boolean;
}

export interface LegalAnalyticsActs extends LegalAnalyticsDenominators {
  readonly order: LegalAnalyticsOrder;
  readonly rows: readonly LegalAnalyticsActRow[];
  /** Rows of the page the privacy gate hid (an act restricted after the layer was built). */
  readonly hidden: number;
  readonly next: string | null;
}

export type LegalAnalyticsData =
  | LegalAnalyticsHead
  | LegalAnalyticsSummary
  | LegalAnalyticsBreakdown
  | LegalAnalyticsSeries
  | LegalAnalyticsGrid
  | LegalAnalyticsLinks
  | LegalAnalyticsActs;

/** One answer: the view, the layer it was read from, the canonical arguments and the data. */
export interface LegalAnalyticsAnswer {
  readonly view: LegalAnalyticsView;
  readonly layer: LegalAnalyticsLayer;
  /** The canonical arguments (defaults dropped), the cache key's argument part. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly data: LegalAnalyticsData;
  /** `<layer id>:<request key>`: the cache key, the REST validator's input. Not served. */
  readonly cacheKey: string;
}
