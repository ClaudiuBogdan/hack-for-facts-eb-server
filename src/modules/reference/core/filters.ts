/**
 * Reference module — filter specs (plan §7). One `CollectionFilterSpec` per
 * browseable collection; the kernel derives TypeBox (REST) + GraphQL input + SQL
 * conditions + the stable `fhash` from these. The module only DECLARES specs.
 *
 * Collection names are chosen so the kernel `toGraphQLInput` deriver emits the
 * plan's input type names: `reference_public_entity` → `ReferencePublicEntityFilter`,
 * `reference_territory` → `ReferenceTerritoryFilter`, `reference_classification` →
 * `ReferenceClassificationFilter`.
 *
 * Column `alias` MUST match the table alias the repo uses (`pe` public_entities,
 * `t` territories, `c` classification_codes). VIRTUAL fields (`countyCode`/`region`
 * on public_entities resolve through a territories join; `isUat` on territories is
 * derived from the native UAT/sector presentation levels) are declared here for surface visibility +
 * fhash, and intercepted by the repo (the kernel composer never compiles them).
 *
 * Index-awareness (§3): `name` is GIN-trgm, `entity_type` partial btree, `category`
 * /`territorial_siruta_code` btree, `county_code` btree on territories, PK `(system,
 * code)` on classification. `tags`/`parentCui`/`region` have NO index → bounded
 * seq-scan over the small dims (15k / 3.2k rows), acceptable.
 *
 * Exclusion semantics (kernel `toConditionBuilders`): `exclude.{a,b}` compiles to
 * `NOT (a OR b)` — a single negated disjunction, NOT per-field AND. Surfaces that
 * expose `exclude` must state this so an agent reads "rows matching none of the
 * excluded predicates".
 */

import type { CollectionFilterSpec } from '@/modules/shared/index.js';

/** 14 live entity_type values (verified against prod 2026-06-16). Open: still a free filter, but enum-validated for safety. */
export const REFERENCE_ENTITY_TYPES = [
  'education',
  'uat',
  'public_entity',
  'health',
  'public_order',
  'culture',
  'sports',
  'social',
  'utilities',
  'research',
  'justice',
  'central_authority',
  'penitentiary',
  'transport',
] as const;

/** 8 development regions (verified live). */
export const REFERENCE_REGIONS = [
  'Sud-Muntenia',
  'Nord-Est',
  'Sud-Vest Oltenia',
  'Nord-Vest',
  'Centru',
  'Sud-Est',
  'Vest',
  'Bucuresti-Ilfov',
] as const;

/** 3 CAEN classification systems (the only systems live). */
export const REFERENCE_CLASSIFICATION_SYSTEM_VALUES = [
  'caen_rev1',
  'caen_rev2',
  'caen_rev3',
] as const;

// ── public_entities ────────────────────────────────────────────────────────────

export const referencePublicEntityFilterSpec: CollectionFilterSpec = {
  collection: 'reference_public_entity',
  fields: [
    {
      name: 'cui',
      type: 'string',
      ops: ['eq', 'in'],
      exclude: true,
      column: { alias: 'pe', column: 'cui' },
      description: 'CUI (PK). eq/in; negatable.',
    },
    {
      name: 'name',
      type: 'string',
      ops: ['contains', 'prefix'],
      column: { alias: 'pe', column: 'name' },
      description: 'Institution name (GIN trigram).',
    },
    // entity_type is an OPEN set (14 live values, but a loader change can add a
    // 15th without a server deploy). Typed as a FREE STRING so a new value never
    // 400s (a closed enum would reject it via the kernel coerceScalar gate); the
    // value list lives in REFERENCE_ENTITY_TYPES for docs/UI facets only.
    {
      name: 'entityType',
      type: 'string',
      ops: ['eq', 'in', 'isNull'],
      exclude: true,
      column: { alias: 'pe', column: 'entity_type' },
      description:
        'Open set: education | uat | public_entity | health | ... (free string, not a closed enum).',
    },
    {
      name: 'category',
      type: 'string',
      ops: ['eq', 'in', 'prefix', 'isNull'],
      exclude: true,
      column: { alias: 'pe', column: 'category' },
      description: '~50-value open set — free string, not a closed enum (§13 Q5).',
    },
    {
      name: 'isUat',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'pe', column: 'is_uat' },
      description: 'Is this a UAT (administrative-territorial unit)?',
    },
    {
      name: 'isTerritorialExecutive',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'pe', column: 'is_territorial_executive' },
      description:
        'An executive authority anchored at a geographic node; independent of creditor hierarchy.',
    },
    {
      name: 'tags',
      type: 'string',
      ops: ['contains'],
      column: {
        alias: 'pe',
        column: 'tags',
        arrayColumn: true,
        arrayKind: 'jsonb',
        // Elements are {tag, ruleId, confidence}, not bare strings.
        jsonbElementKey: 'tag',
      },
      description:
        'jsonb-array CONTAINS-ALL (@>): matches entities carrying every supplied tag (not substring, not any-overlap). No GIN index — bounded seq over 15k rows. Faceted vocabulary, `::`-namespaced, with ancestor roll-up: kind::school matches kind::school::gymnasium too.',
    },
    {
      name: 'sirutaCode',
      type: 'string',
      ops: ['eq', 'in', 'isNull'],
      exclude: true,
      column: { alias: 'pe', column: 'territorial_siruta_code' },
      description: 'Territory link key (indexed). Negatable for all-except queries.',
    },
    {
      name: 'countyCode',
      type: 'string',
      ops: ['eq', 'in'],
      exclude: true,
      column: { alias: 'pe', column: 'county_code_virtual' },
      description: 'VIRTUAL — joins the canonical territory_id, filters t.county_code.',
    },
    {
      name: 'region',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: [...REFERENCE_REGIONS],
      exclude: true,
      column: { alias: 'pe', column: 'region_virtual' },
      description: 'VIRTUAL — joins core.territories, filters t.region.',
    },
    {
      name: 'parentCui',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'pe', column: 'parent_cui_virtual' },
      description: 'VIRTUAL — parent1_cui OR parent2_cui (no index, bounded seq).',
    },
    {
      name: 'hasIssues',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'pe', column: 'has_issues_virtual' },
      description: 'VIRTUAL — jsonb_array_length(issues) > 0 (data-quality probe).',
    },
    {
      name: 'defaultReportType',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'pe', column: 'default_report_type' },
      description: 'The default budget report type.',
    },
  ],
  // Cursor keyset stability: `name`/`entity_type`/`updated_at` are NON-unique, so
  // the repo ALWAYS appends the unique PK `cui` as a tiebreak — the cursor encodes
  // `(sortValue, cui)`. `cui` sorted alone needs no tiebreak (it IS the PK).
  sort: { default: 'name', allowed: ['name', 'cui', 'entity_type', 'updated_at'] },
};

// ── territories ──────────────────────────────────────────────────────────────

export const referenceTerritoryFilterSpec: CollectionFilterSpec = {
  collection: 'reference_territory',
  fields: [
    {
      name: 'id',
      type: 'int',
      ops: ['eq', 'in'],
      column: { alias: 't', column: 'id' },
      description: 'Surrogate PK (the legacy uat_id contract).',
    },
    {
      name: 'sirutaCode',
      type: 'string',
      ops: ['eq', 'in'],
      exclude: true,
      column: { alias: 't', column: 'siruta_code' },
      description: 'SIRUTA code (indexed). Negatable.',
    },
    {
      name: 'territorialSiruta',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 't', column: 'territorial_siruta_code' },
      description: 'Territorial SIRUTA (unique natural key). Not negatable (PK-grade lookup).',
    },
    {
      name: 'countyCode',
      type: 'string',
      ops: ['eq', 'in'],
      exclude: true,
      column: { alias: 't', column: 'county_code' },
      description: 'County code (indexed).',
    },
    {
      name: 'region',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: [...REFERENCE_REGIONS],
      exclude: true,
      column: { alias: 't', column: 'region' },
      description: '8 development regions (no index, bounded seq over 3.2k rows).',
    },
    {
      name: 'name',
      type: 'string',
      ops: ['contains', 'prefix'],
      column: { alias: 't', column: 'name' },
      description: 'UAT name (GIN trigram).',
    },
    {
      name: 'isUat',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 't', column: 'is_uat_virtual' },
      description: 'UATs and Bucharest sectors in the local-government presentation layer.',
    },
    {
      name: 'isCounty',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 't', column: 'is_county_virtual' },
      description:
        'County geographic nodes, with the Bucharest municipality used only before its county node exists.',
    },
    {
      name: 'population',
      type: 'int',
      ops: ['between'],
      column: { alias: 't', column: 'population' },
      description: 'Population range (from/to).',
    },
  ],
  // Cursor keyset stability: `name`/`population`/`county_code` are NON-unique, so
  // the repo ALWAYS appends the unique PK `id` as a tiebreak — cursor encodes
  // `(sortValue, id)`.
  sort: { default: 'name', allowed: ['name', 'population', 'county_code'] },
};

// ── classification_codes ─────────────────────────────────────────────────────

export const referenceClassificationFilterSpec: CollectionFilterSpec = {
  collection: 'reference_classification',
  fields: [
    {
      name: 'system',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: [...REFERENCE_CLASSIFICATION_SYSTEM_VALUES],
      column: { alias: 'c', column: 'system' },
      description: 'CAEN system (PK leading column).',
    },
    {
      name: 'code',
      type: 'string',
      ops: ['eq', 'in', 'prefix'],
      exclude: true,
      column: { alias: 'c', column: 'code' },
      description: 'CAEN code (PK). Prefix is index-prunable when system is fixed.',
    },
    {
      name: 'label',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'c', column: 'label' },
      description: 'Label substring (bounded seq over ≤1,675 rows).',
    },
    {
      name: 'parentCode',
      type: 'string',
      ops: ['eq', 'isNull'],
      exclude: true,
      column: { alias: 'c', column: 'parent_code' },
      description: 'Parent code (effectively unused in CAEN).',
    },
  ],
  // Cursor keyset stability: `code` alone is non-unique across systems and `label`
  // is non-unique, so the repo orders by the FULL PK `(sortValue, system, code)` —
  // the cursor encodes `(sortValue, system, code)`.
  sort: { default: 'code', allowed: ['code', 'label'] },
};

/** Field names the repo intercepts as VIRTUAL (the kernel composer must skip them). */
export const REFERENCE_PUBLIC_ENTITY_VIRTUAL_FIELDS = [
  'countyCode',
  'region',
  'parentCui',
  'hasIssues',
] as const;
export const REFERENCE_TERRITORY_VIRTUAL_FIELDS = ['isUat', 'isCounty'] as const;

export const REFERENCE_FILTER_SPECS = {
  publicEntity: referencePublicEntityFilterSpec,
  territory: referenceTerritoryFilterSpec,
  classification: referenceClassificationFilterSpec,
} as const;
