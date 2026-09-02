/**
 * INS native module — `ProdDatabase` augmentation (module-augmentation pattern).
 *
 * Types the live Chronos `ins.*` schema (scrapper migrations
 * `20260811T140000__ins_prod_schema` … `20260903T100000__ins_serving_catalogs`)
 * onto the single kernel Kysely instance. Table keys are the schema-qualified
 * live names. Only the columns the module READS are typed — provenance
 * (`response_id`, custody pointers) and load bookkeeping are omitted so the
 * repo cannot select them by accident.
 *
 * Scalars (foundation §14.1, pool.ts): `bigint` → `string` (int8 parser),
 * `numeric` → `string` (value precision preserved), `date` → `'YYYY-MM-DD'`,
 * `timestamptz` → the wire string. `int`/`smallint` stay numbers.
 *
 * The fact table is read through its PARTITIONED PARENT `ins.observations`;
 * every query carries `dataset_code = $1` so the planner prunes to one leaf.
 */

import type { ColumnType } from 'kysely';

type ReadOnly<T> = ColumnType<T, never, never>;

/** `ins.datasets` — one row per TEMPO matrix (the serving catalog root). */
export interface InsDatasetsTable {
  dataset_code: string;
  generation_id: string; // bigint
  matrix_name_ro: string;
  matrix_name_en: string | null;
  name_lang: string;
  context_code: string | null;
  context_path: string | null;
  dimension_count: number;
  classification_dim_count: number;
  time_dim_index: number;
  unit_dim_index: number;
  periodicities: string[];
  unit_option_count: number;
  ultima_actualizare_date: string | null; // date
  load_status: string;
  rows_loaded: string; // bigint
  source_url: string;
  territory_dim_index: number | null;
  territory_resolution: string | null;
  pivot_custody_sha256: string | null;
  is_complete: ReadOnly<boolean>;
}

/** `ins.dataset_dimensions` — the k+2 dimensions of a matrix, in source order. */
export interface InsDatasetDimensionsTable {
  dataset_code: string;
  dim_index: number;
  slot_index: number | null; // 1..7 for classification dims; the dimN_member_id column
  semantic_role: string; // classification | time | unit
  dim_code: string | null;
  label_ro: string;
  label_en: string | null;
  option_count: number;
  parent_dim_index: number | null;
}

/** `ins.dataset_dimension_members` — the members of one dimension. */
export interface InsDatasetDimensionMembersTable {
  dataset_code: string;
  dim_index: number;
  nom_item_id: number;
  ordinal: number | null;
  member_role: string; // TOTAL | SUBTOTAL | LEAF | OF_WHICH | UNKNOWN
  label_override: string | null;
  parent_nom_item_id: number | null;
}

/** `ins.nomenclature_items` — the global TEMPO nomenclature (labels per nomItemId). */
export interface InsNomenclatureItemsTable {
  nom_item_id: number;
  label_ro: string;
  label_en: string | null;
  label_normalised: string;
  indent_width: number;
}

/** `ins.periods` — the time identity spine (one row per periodicity × bounds). */
export interface InsPeriodsTable {
  period_id: number;
  periodicity: string; // ANNUAL | SEMESTRIAL | QUARTERLY | MONTHLY | RANGE | OTHER
  period_start: string; // date
  period_end: string; // date
  label_ro: string;
}

/** `ins.measures` — the unit member's meaning per dataset. */
export interface InsMeasuresTable {
  dataset_code: string;
  unit_nom_item_id: number;
  unit_label_ro: string;
  scale_factor: string; // numeric
  base_unit: string | null;
  unit_kind: string; // monetary | intensity-or-mixed | non-monetary
}

/** `ins.currency_regimes` — the currency regime per (dataset, unit). */
export interface InsCurrencyRegimesTable {
  dataset_code: string;
  unit_nom_item_id: number;
  regime: string;
  confidence: string;
}

/** `ins.member_territory` — a territorial member bound to a spine node (v2: with the public code). */
export interface InsMemberTerritoryTable {
  dataset_code: string;
  dim_index: number;
  nom_item_id: number;
  territory_id: string | null; // bigint
  territory_level: string | null;
  siruta_code: string | null;
  territory_code: string | null;
  binding_flags: string[];
  method: string;
  resolution: string; // RESOLVED | TOTAL_MEMBER | NO_PREFIX | PREFIX_NOT_IN_SPINE | NAME_NOT_IN_SPINE
}

/** `ins.territory_nodes` — the INS spine mirror (NATIONAL > NUTS1 > NUTS2 > NUTS3 > LAU). */
export interface InsTerritoryNodesTable {
  territory_id: string; // bigint
  code: string;
  siruta_code: string | null;
  level: string;
  name_ro: string;
  name_search: string;
  parent_id: string | null; // bigint
  ordinal: number | null;
  core_territory_id: number | null;
}

/** `ins.contexts` — the TEMPO theme tree. */
export interface InsContextsTable {
  context_code: string;
  parent_code: string | null;
  level: number;
  name_ro: string;
  name_en: string | null;
  name_search: string;
  path: string;
  ordinal: number | null;
}

/** `ins.dataset_coverage` — observed coverage + published text per served dataset. */
export interface InsDatasetCoverageTable {
  dataset_code: string;
  custody_sha256: string;
  observation_count: string; // bigint
  first_period_start: string | null; // date
  last_period_end: string | null; // date
  periodicities_observed: string[];
  has_lau: boolean;
  has_county: boolean;
  has_region: boolean;
  has_national: boolean;
  definition_ro: string | null;
  definition_en: string | null;
  methodology_ro: string | null;
  methodology_en: string | null;
  data_sources_ro: string | null;
  source_year_start: number | null;
  source_year_end: number | null;
  source_last_update: string | null; // date
  name_search: string;
  computed_at: string; // timestamptz
}

/** `ins.default_series` — the loader-owned default pin per (dataset, non-time dimension). */
export interface InsDefaultSeriesTable {
  dataset_code: string;
  dim_index: number;
  nom_item_id: number;
  policy: string; // TOTAL_MEMBER | SINGLE_UNIT | MANIFEST
  manifest_version: string;
}

/** `ins.observations` — the fact, read through the partitioned parent. */
export interface InsObservationsTable {
  dataset_code: string;
  dim1_member_id: number | null;
  dim2_member_id: number | null;
  dim3_member_id: number | null;
  dim4_member_id: number | null;
  dim5_member_id: number | null;
  dim6_member_id: number | null;
  dim7_member_id: number | null;
  time_nom_item_id: number;
  unit_nom_item_id: number;
  period_id: number;
  period_start: string; // date
  period_end: string; // date
  territory_siruta_code: string | null;
  currency_code: string | null;
  value: string | null; // numeric
  value_status: string | null; // 'c' | ':'
}

declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    /* eslint-disable @typescript-eslint/naming-convention -- Kysely table keys are the schema-qualified live names (foundation §3) */
    'ins.datasets': InsDatasetsTable;
    'ins.dataset_dimensions': InsDatasetDimensionsTable;
    'ins.dataset_dimension_members': InsDatasetDimensionMembersTable;
    'ins.nomenclature_items': InsNomenclatureItemsTable;
    'ins.periods': InsPeriodsTable;
    'ins.measures': InsMeasuresTable;
    'ins.currency_regimes': InsCurrencyRegimesTable;
    'ins.member_territory': InsMemberTerritoryTable;
    'ins.territory_nodes': InsTerritoryNodesTable;
    'ins.contexts': InsContextsTable;
    'ins.dataset_coverage': InsDatasetCoverageTable;
    'ins.default_series': InsDefaultSeriesTable;
    'ins.observations': InsObservationsTable;
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
