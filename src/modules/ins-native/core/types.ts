/**
 * INS native module — domain types (pure; no IO).
 *
 * The model follows the panel-approved Chronos `ins` schema
 * (scrapper `prod-db/INS_PRODUCTION_DATABASE_DESIGN.md`): a dataset is a
 * matrix with k classification dimensions (k ≤ 7, each mapped to a physical
 * slot `dim1..dim7`), one time dimension and one unit dimension; a member is a
 * TEMPO nomenclature item (`nomItemId`, source-issued, global); an observation
 * is identified by its value-free coordinate tuple. Territories are nodes of
 * the INS spine (NATIONAL > NUTS1 > NUTS2 > NUTS3 > LAU) bound to members.
 *
 * Wire shapes (the frozen legacy GraphQL types) live in the shell; these types
 * are camelCase and carry only what the usecases need.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Limits (unchanged from the legacy contract, applied in the usecases)
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_DATASET_LIMIT = 20;
export const MAX_DATASET_LIMIT = 200;
export const DEFAULT_OBSERVATION_LIMIT = 50;
export const MAX_OBSERVATION_LIMIT = 1000;
export const DEFAULT_DIMENSION_VALUES_LIMIT = 50;
export const MAX_DIMENSION_VALUES_LIMIT = 1000;
export const DEFAULT_TERRITORY_LIMIT = 20;
export const MAX_TERRITORY_LIMIT = 500;
export const DEFAULT_CONTEXT_LIMIT = 20;
export const MAX_CONTEXT_LIMIT = 500;
/**
 * The UAT dashboard returns the most recent observations of each dataset's
 * default series; this bounds ONE dataset, never the whole response (the
 * legacy 2,000-row global cap decided silently which datasets disappeared).
 */
export const DASHBOARD_ROWS_PER_DATASET = 200;
/** Max datasets in one batched latest-values / dashboard request. */
export const MAX_BATCH_DATASETS = 100;
/** Physical classification slots on the fact table. */
export const MAX_SLOTS = 7;

// ─────────────────────────────────────────────────────────────────────────────
// Enumerations (native vocabularies)
// ─────────────────────────────────────────────────────────────────────────────

export type InsPeriodicity = 'ANNUAL' | 'SEMESTRIAL' | 'QUARTERLY' | 'MONTHLY' | 'RANGE' | 'OTHER';
export const INS_PERIODICITIES: readonly InsPeriodicity[] = [
  'ANNUAL',
  'SEMESTRIAL',
  'QUARTERLY',
  'MONTHLY',
  'RANGE',
  'OTHER',
];

export type InsTerritoryLevel = 'NATIONAL' | 'NUTS1' | 'NUTS2' | 'NUTS3' | 'LAU';
export const INS_TERRITORY_LEVELS: readonly InsTerritoryLevel[] = [
  'NATIONAL',
  'NUTS1',
  'NUTS2',
  'NUTS3',
  'LAU',
];
/** Depth of each level in the spine; a node's ancestors have strictly smaller depth. */
export const TERRITORY_LEVEL_DEPTH: Readonly<Record<InsTerritoryLevel, number>> = {
  NATIONAL: 0,
  NUTS1: 1,
  NUTS2: 2,
  NUTS3: 3,
  LAU: 4,
};

export type InsDimensionRole = 'classification' | 'time' | 'unit';
export type InsMemberRole = 'TOTAL' | 'SUBTOTAL' | 'LEAF' | 'OF_WHICH' | 'UNKNOWN';
export type InsDataStatus = 'AVAILABLE' | 'CATALOG_ONLY';
export type InsPublicationStatus = 'READY' | 'NOT_LOADED' | 'UNCERTIFIED';
export type InsUnitKind = 'monetary' | 'intensity-or-mixed' | 'non-monetary';
export type InsDefaultPolicy = 'TOTAL_MEMBER' | 'SINGLE_UNIT' | 'MANIFEST';

/**
 * How a default series was resolved. `REPRESENTATIVE_FALLBACK` (an arbitrary
 * row) no longer exists (decision D2): a dataset without a complete default
 * pin answers NO_DATA.
 */
export type InsLatestMatchStrategy = 'PREFERRED_CLASSIFICATION' | 'TOTAL_FALLBACK' | 'NO_DATA';

// ─────────────────────────────────────────────────────────────────────────────
// Catalog views
// ─────────────────────────────────────────────────────────────────────────────

export interface InsTerritoryNode {
  readonly territoryId: number;
  /** Public identity: SIRUTA for LAU, county letter for NUTS3, NUTS code above, `RO`. */
  readonly code: string;
  readonly sirutaCode: string | null;
  readonly level: InsTerritoryLevel;
  readonly nameRo: string;
  readonly parentId: number | null;
  readonly parentCode: string | null;
  readonly parentNameRo: string | null;
  /** `core.territories.id` where the node exists there; null before L2 for NUTS nodes. */
  readonly coreTerritoryId: number | null;
}

export interface InsContext {
  readonly code: string;
  readonly parentCode: string | null;
  readonly level: number;
  readonly nameRo: string;
  readonly nameEn: string | null;
  readonly path: string;
  readonly ordinal: number | null;
  readonly datasetCount: number;
}

export interface InsDatasetView {
  readonly code: string;
  readonly nameRo: string;
  readonly nameEn: string | null;
  readonly definitionRo: string | null;
  readonly definitionEn: string | null;
  readonly methodologyRo: string | null;
  readonly dataSourcesRo: string | null;
  /** The periodicities OBSERVED in the served facts (catalog claim when nothing is loaded). */
  readonly periodicities: readonly InsPeriodicity[];
  /** Observed [first year, last year] of the served facts; null when nothing is loaded. */
  readonly yearRange: readonly [number, number] | null;
  /** TEMPO's claimed year range, kept apart from the observed one. */
  readonly sourceYearRange: readonly [number, number] | null;
  readonly dimensionCount: number;
  readonly classificationDimCount: number;
  readonly timeDimIndex: number;
  readonly unitDimIndex: number;
  readonly hasLau: boolean;
  readonly hasCounty: boolean;
  readonly hasRegion: boolean;
  readonly hasNational: boolean;
  readonly dataStatus: InsDataStatus;
  /** Never-loaded data keeps empty semantics; uncertified publications are unavailable. */
  readonly publicationStatus: InsPublicationStatus;
  readonly observationCount: number | null;
  /** When the served facts were last (re)computed — the coverage row's timestamp. */
  readonly computedAt: string | null;
  /** TEMPO's own last-update date for the matrix. */
  readonly sourceLastUpdate: string | null;
  readonly contextCode: string | null;
  readonly contextNameRo: string | null;
  readonly contextNameEn: string | null;
  readonly contextPath: string | null;
  /** Certified source custody; transforms can create another revision over the same source. */
  readonly custodySha256: string | null;
  readonly revisionId: string | null;
  readonly transformContractSha256: string | null;
  readonly publishedAt: string | null;
  readonly sourceUrl: string;
}

export interface InsDimensionView {
  readonly datasetCode: string;
  readonly dimIndex: number;
  /** 1..7 for classification dimensions (the physical `dimN_member_id` slot), null otherwise. */
  readonly slotIndex: number | null;
  readonly role: InsDimensionRole;
  readonly labelRo: string;
  readonly labelEn: string | null;
  readonly optionCount: number;
  readonly parentDimIndex: number | null;
  /** True when the dimension has territory bindings (member_territory rows). */
  readonly isTerritorial: boolean;
}

export interface InsUnitView {
  readonly nomItemId: number;
  readonly labelRo: string;
  readonly labelEn: string | null;
  readonly baseUnit: string | null;
  readonly scaleFactor: string;
  readonly unitKind: InsUnitKind;
  /** The currency regime literal when the unit is monetary and known (RON/EUR/USD/ROL…). */
  readonly currencyRegime: string | null;
}

export interface InsMemberView {
  readonly datasetCode: string;
  readonly dimIndex: number;
  /** The dimension's labels, carried so a row's hydration needs no second read. */
  readonly dimLabelRo: string;
  readonly dimLabelEn: string | null;
  readonly nomItemId: number;
  readonly ordinal: number | null;
  readonly labelRo: string;
  readonly labelEn: string | null;
  readonly memberRole: InsMemberRole;
  readonly parentNomItemId: number | null;
  /** The bound spine node for territorial members; null when unbound or a TOTAL member. */
  readonly territory: InsTerritoryNode | null;
  readonly territoryResolution: string | null;
}

/** A member's identity inside a dataset (what a public pin resolves to). */
export interface InsMemberRef {
  readonly dimIndex: number;
  readonly slotIndex: number;
  readonly nomItemId: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Facts
// ─────────────────────────────────────────────────────────────────────────────

/** The value-free identity of one observation (design §5). */
export interface InsCoordinate {
  readonly datasetCode: string;
  /** Slots 1..7 as an array index 0..6; null beyond k. */
  readonly slots: readonly (number | null)[];
  readonly timeNomItemId: number;
  readonly unitNomItemId: number;
}

export interface InsPeriodView {
  readonly periodId: number;
  readonly periodicity: InsPeriodicity;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly labelRo: string;
}

/** The full ordered source identity, separate from any interpreted territory. */
export type InsGeoPairs = readonly (readonly [dimIndex: number, nomItemId: number])[];

/** Required internal scope: raw source access is never inferred from omission. */
export type InsGeoScope =
  | {
      readonly kind: 'modern';
      readonly territoryIds?: readonly number[];
      readonly levels?: readonly InsTerritoryLevel[];
    }
  | { readonly kind: 'explicitSource'; readonly pairs: readonly InsGeoPairs[] }
  | { readonly kind: 'nonGeographic' };

export type InsTerritorySelection =
  readonly InsTerritoryNode[] | { readonly levels: readonly InsTerritoryLevel[] } | null;

export interface InsGeographicDimension {
  readonly dimIndex: number;
  readonly slotIndex: number;
}

export interface InsGeographicRule {
  readonly ruleId: string;
  readonly appliesFrom: string;
  readonly appliesTo: string;
  readonly flag: string;
  readonly kind: 'coverage';
  readonly evidenceUrl: string;
  readonly rationale: string;
}

export interface InsObservationGeography {
  readonly pairs: InsGeoPairs;
  readonly resolution: 'EXACT' | 'CONTEXTUAL' | 'UNRESOLVED';
  readonly flags: readonly string[];
  /** Published interpretation, retained even when this observation is qualified. */
  readonly resolvedTerritory: InsTerritoryNode | null;
  readonly contextTerritory: InsTerritoryNode | null;
  /** Only rules overlapping this cell's inclusive period. */
  readonly applicableRules: readonly InsGeographicRule[];
  readonly qualified: boolean;
}

export interface InsObservationView {
  readonly coordinate: InsCoordinate;
  readonly period: InsPeriodView;
  readonly value: string | null;
  /** `c` confidential, `:` not available; null when a value is present. */
  readonly valueStatus: string | null;
  readonly currencyCode: string | null;
  /** The classification members of the row, one per classification dimension in dimIndex order. */
  readonly members: readonly InsMemberView[];
  readonly geography: InsObservationGeography | null;
  /** Effective modern territory: only an unqualified EXACT source coordinate. */
  readonly territory: InsTerritoryNode | null;
  readonly unit: InsUnitView;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters and query inputs
// ─────────────────────────────────────────────────────────────────────────────

export interface InsDatasetFilter {
  readonly search?: string;
  readonly codes?: readonly string[];
  readonly contextCode?: string;
  readonly rootContextCode?: string;
  readonly periodicities?: readonly InsPeriodicity[];
  /**
   * Legacy switch semantics, kept: undefined = loaded datasets only; any value
   * (including []) = the full catalog, narrowed to the listed statuses when
   * non-empty.
   */
  readonly dataStatus?: readonly InsDataStatus[];
  readonly hasUatData?: boolean;
  readonly hasCountyData?: boolean;
}

export interface InsContextFilter {
  readonly search?: string;
  readonly level?: number;
  readonly parentCode?: string;
  readonly rootContextCode?: string;
}

export interface InsTerritoryFilter {
  readonly search?: string;
  readonly levels?: readonly InsTerritoryLevel[];
  readonly parentCode?: string;
  readonly sirutaCodes?: readonly string[];
}

/** A period constraint on facts; bounds are inclusive ISO dates. */
export interface InsPeriodFilter {
  readonly periodicity?: 'ANNUAL' | 'QUARTERLY' | 'MONTHLY';
  readonly start?: string;
  readonly end?: string;
  /** Explicit period tokens (`2023`, `2023-Q1`, `2023-03`), OR-ed. */
  readonly tokens?: readonly string[];
}

export interface InsObservationFilter {
  readonly territoryCodes?: readonly string[];
  readonly sirutaCodes?: readonly string[];
  readonly territoryLevels?: readonly InsTerritoryLevel[];
  /** Unit member codes (`nomItemId` strings). */
  readonly unitCodes?: readonly string[];
  /** Member codes (`nomItemId` strings, or the `TOTAL` alias). */
  readonly classificationValueCodes?: readonly string[];
  /** Dimension codes (`D<dimIndex>`). */
  readonly classificationTypeCodes?: readonly string[];
  readonly period?: InsPeriodFilter;
  readonly hasValue?: boolean;
}

export interface InsEntitySelector {
  readonly sirutaCode?: string;
  readonly territoryCode?: string;
  readonly territoryLevel?: InsTerritoryLevel;
}

export interface InsPage<T> {
  readonly nodes: readonly T[];
  /** Exact when known; null when the page was read with limit+1 and is full (D7). */
  readonly totalCount: number | null;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolved series (what the usecases hand the repository)
// ─────────────────────────────────────────────────────────────────────────────

/** One AND-group of explicit member-id lists (OR within each slot). */
export type SlotPins = ReadonlyMap<number, readonly number[]>;

/** Physical classification groups intersect a complete geographic scope. */
export interface InsFactQuery {
  readonly datasetCode: string;
  readonly geoScope: InsGeoScope;
  readonly pinGroups: readonly SlotPins[];
  readonly unitNomItemIds?: readonly number[];
  readonly periodicities?: readonly InsPeriodicity[];
  readonly periodStart?: string;
  readonly periodEnd?: string;
  /** Explicit periods (`dates` selection): rows overlapping ANY range; OR-ed, exact. */
  readonly periodRanges?: readonly { readonly start: string; readonly end: string }[];
  readonly periodIds?: readonly number[];
  readonly hasValue?: boolean;
  readonly limit: number;
  readonly offset: number;
}

/** A fully pinned series (every classification slot and the unit pinned to one member). */
export interface InsSeriesSpec {
  readonly key: string;
  readonly datasetCode: string;
  readonly slots: readonly (number | null)[];
  readonly unitNomItemId: number;
}

export interface InsLatestValue {
  readonly dataset: InsDatasetView;
  readonly observation: InsObservationView | null;
  readonly matchStrategy: InsLatestMatchStrategy;
}

export interface InsDashboardGroup {
  readonly dataset: InsDatasetView;
  readonly observations: readonly InsObservationView[];
  /** True when the dataset holds more rows for this series than were returned. */
  readonly truncated: boolean;
}
