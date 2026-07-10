/**
 * Primarii-transparency module — filter specs (plan §7). One `CollectionFilterSpec`
 * per browseable collection; the kernel derives the GraphQL input + SQL conditions
 * + the stable `fhash` from these. The module only DECLARES specs.
 *
 * Collection names are chosen so the kernel `toGraphQLInput` deriver emits the
 * plan's input type names: `primarii_entity` → `PrimariiEntityFilter`,
 * `primarii_document` → `PrimariiDocumentFilter`.
 *
 * Column `alias` MUST match the table alias the repo uses (`ces` →
 * `current_entity_status`, `d` → `documents`). VIRTUAL fields are declared here for
 * surface visibility + fhash and intercepted by the repo (the kernel composer never
 * compiles them):
 *  - TERRITORY (`region`/`siruta`/`isUat`/population) resolve through the kernel
 *    cui→territory hub (`IdentityRepo.territoryForCui` join). Capability-gated when
 *    that resolver is unavailable (§4.2/§13.0): the repo returns InvalidInput
 *    "geographic resolution unavailable" rather than silently dropping the predicate.
 *  - `publishesCategory` (+`categoryState`) semijoins `entity_category_statuses`
 *    scoped to the CURRENT snapshot (`AND ecs.snapshot_id = ces.snapshot_id`).
 *  - `missingCategory` filters `current_entity_status.missing_required_categories`
 *    (text[] `&&` array-overlap) — the AUTHORITATIVE source of truth for "missing".
 *  - `hasIssues` is `issue_count > 0`.
 *
 * Index-awareness (§3): `cui` PK, `county` btree (`county_idx`), `(data_quality_status,
 * result_status)` btree (`quality_idx`). The rest (`entity_type`/`confidence`/
 * `evidence_coverage`/`issue_count`/`missing_required_categories`) have NO index →
 * bounded seq-scan over the 3,187-row registry, acceptable (stated honestly).
 *
 * Exclusion semantics (kernel `toConditionBuilders`): `exclude.{a,b}` compiles to
 * `NOT (a OR b)` — a single negated disjunction, NOT per-field AND.
 */

import {
  PRIMARII_CATEGORY,
  PRIMARII_CATEGORY_STATE,
  PRIMARII_DATA_QUALITY,
  PRIMARII_ENTITY_TYPE,
  PRIMARII_RESULT_STATUS,
} from './types.js';

import type { CollectionFilterSpec } from '@/modules/shared/index.js';

// ── primarii_entity (the registry — the high-value surface) ──────────────────────

export const primariiEntityFilterSpec: CollectionFilterSpec = {
  collection: 'primarii_entity',
  fields: [
    {
      name: 'cui',
      type: 'string',
      ops: ['eq', 'in'],
      exclude: true,
      column: { alias: 'ces', column: 'cui' },
      description: 'UAT CUI (PK). eq/in; negatable.',
    },
    {
      name: 'dataQualityStatus',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: [...PRIMARII_DATA_QUALITY],
      exclude: true,
      column: { alias: 'ces', column: 'data_quality_status' },
      description:
        'Headline data-quality verdict (quality_idx). Live: medium 2559 · high 265 · review_needed 169 · low 116 · missing 78.',
    },
    {
      name: 'resultStatus',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: [...PRIMARII_RESULT_STATUS],
      exclude: true,
      column: { alias: 'ces', column: 'result_status' },
      description:
        'Research result status (quality_idx 2nd col). Live: partial 2723 · complete 265 · blocked 113 · missing_result 78 · not_found 5 · error 3.',
    },
    {
      name: 'entityType',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: [...PRIMARII_ENTITY_TYPE],
      exclude: true,
      column: { alias: 'ces', column: 'entity_type' },
      description:
        'Closed 5-value set (no index — cheap scan): admin_commune_hall | admin_town_hall | admin_municipality | admin_sector_hall | primarie.',
    },
    {
      name: 'county',
      type: 'string',
      ops: ['eq', 'in'],
      exclude: true,
      column: { alias: 'ces', column: 'county' },
      description:
        'Denormalized county text (county_idx) — BEST-EFFORT (43 distinct names, diacritics/spelling not canonical). Canonical geography routes through region/siruta (hub).',
    },
    // ── territory (hub-gated, virtual) — resolved via kernel cui→territory ──────
    {
      name: 'region',
      type: 'string',
      ops: ['eq', 'in'],
      exclude: true,
      virtual: true,
      column: { alias: 'ces', column: 'region_virtual' },
      description:
        'VIRTUAL/GATED — core.territories.region via the kernel cui→territory resolver. Capability-gated: InvalidInput when the resolver is unavailable (§13.0).',
    },
    {
      name: 'siruta',
      type: 'string',
      ops: ['eq', 'in'],
      virtual: true,
      column: { alias: 'ces', column: 'siruta_virtual' },
      description:
        'VIRTUAL/GATED — core.territories siruta_code / territorial_siruta_code via the kernel cui→territory resolver. Capability-gated (§13.0).',
    },
    {
      name: 'isUat',
      type: 'bool',
      ops: ['eq'],
      virtual: true,
      column: { alias: 'ces', column: 'is_uat_virtual' },
      description:
        'VIRTUAL/GATED — core.public_entities.is_uat via the kernel cui→public-entity resolver. Capability-gated (§13.0).',
    },
    {
      name: 'population',
      type: 'int',
      ops: ['between'],
      virtual: true,
      column: { alias: 'ces', column: 'population_virtual' },
      description:
        'VIRTUAL/GATED — core.territories.population range via the kernel cui→territory resolver. Capability-gated (§13.0).',
    },
    // ── quality / coverage probes (cheap scans over 3,187 rows) ────────────────
    // One field per physical column with mixed ops (gte for the range filter,
    // isNull for the presence probe) — the kernel composes both against the same
    // column (no need for a separate min* field name).
    {
      name: 'confidence',
      type: 'number',
      ops: ['gte', 'isNull'],
      column: { alias: 'ces', column: 'confidence' },
      description:
        'Confidence (0..1; no index — cheap scan). gte = lower bound; isNull = presence probe (78 entities lack it).',
    },
    {
      name: 'evidenceCoverage',
      type: 'number',
      ops: ['gte', 'isNull'],
      column: { alias: 'ces', column: 'evidence_coverage' },
      description:
        'Evidence coverage (0..1; no index — cheap scan). gte = lower bound; isNull = presence probe.',
    },
    {
      name: 'hasIssues',
      type: 'bool',
      ops: ['eq'],
      virtual: true,
      column: { alias: 'ces', column: 'has_issues_virtual' },
      description: 'VIRTUAL — issue_count > 0 (true) / = 0 (false). No index — cheap scan.',
    },
    // missingCategory is a REAL text[] column: the kernel `arrayColumn:'text'` + `in`
    // op compiles to `&&` (array-overlap), exactly the AUTHORITATIVE "required-but-
    // absent" semantics — so it is NOT virtual (the composer handles it).
    {
      name: 'missingCategory',
      type: 'enum',
      ops: ['in'],
      enumValues: [...PRIMARII_CATEGORY],
      column: {
        alias: 'ces',
        column: 'missing_required_categories',
        arrayColumn: true,
        arrayKind: 'text',
      },
      description:
        'text[] array-overlap (&&) on missing_required_categories — AUTHORITATIVE source of truth for "required-but-absent" categories. No index — cheap scan.',
    },
    {
      name: 'publishesCategory',
      type: 'enum',
      ops: ['in'],
      enumValues: [...PRIMARII_CATEGORY],
      virtual: true,
      column: { alias: 'ces', column: 'publishes_category_virtual' },
      description:
        'VIRTUAL — semijoin entity_category_statuses for evidence state, scoped to the CURRENT snapshot. Pair with categoryState (default: found).',
    },
    {
      name: 'categoryState',
      type: 'enum',
      ops: ['eq'],
      enumValues: [...PRIMARII_CATEGORY_STATE],
      virtual: true,
      column: { alias: 'ces', column: 'category_state_virtual' },
      description:
        'VIRTUAL — the per-category evidence state publishesCategory matches (found | not_found | unknown | blocked). Default: found.',
    },
  ],
  // Cursor keyset stability: every sort key except `cui` is NON-unique, so the repo
  // ALWAYS appends the unique PK `cui` as the tiebreak — the cursor encodes
  // `(sortValue, cui)`. Default `data_quality` surfaces best-known first.
  sort: {
    default: 'data_quality',
    allowed: [
      'data_quality',
      'confidence',
      'evidence_coverage',
      'issue_count',
      'entity_name',
      'updated_at',
    ],
  },
};

// ── primarii_document ──────────────────────────────────────────────────────────

export const primariiDocumentFilterSpec: CollectionFilterSpec = {
  collection: 'primarii_document',
  fields: [
    {
      name: 'cui',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'd', column: 'cui' },
      description:
        'UAT CUI (cui_category_idx leading col → index seek). One of cui/category REQUIRED.',
    },
    {
      name: 'category',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: ['organigrama', 'numar_angajati', 'salarii', 'other'],
      column: { alias: 'd', column: 'category' },
      description:
        'Document category (cui_category_idx 2nd col). Category-alone is a small scan of 7,233 rows (leading col is cui), acceptable. One of cui/category REQUIRED.',
    },
    {
      name: 'documentType',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'd', column: 'document_type' },
      description: 'Document type (no index — scan).',
    },
    {
      name: 'hasContent',
      type: 'bool',
      ops: ['eq', 'isNull'],
      virtual: true,
      column: { alias: 'd', column: 'has_content_virtual' },
      description:
        'VIRTUAL — content_sha256 IS [NOT] NULL ("evidence actually stored"). No index — scan.',
    },
  ],
  // `cui`/`category` are non-unique, so the repo orders by `(sortValue, document_pk)`
  // — the cursor encodes `(sortValue, document_pk)`. No date sort (published_date/
  // effective_date are unparsed TEXT — declared non-sortable, non-rangeable).
  sort: { default: 'cui', allowed: ['cui', 'category'] },
};

/**
 * Field names the entity repo intercepts as VIRTUAL (kernel composer must skip
 * them). `missingCategory` is NOT here — it is a real text[] column the kernel
 * composes via `arrayColumn:'text'` → `&&` overlap.
 */
export const PRIMARII_ENTITY_VIRTUAL_FIELDS = [
  'region',
  'siruta',
  'isUat',
  'population',
  'hasIssues',
  'publishesCategory',
  'categoryState',
] as const;

/** Territory-dependent virtual fields — capability-gated on the kernel cui→territory resolver. */
export const PRIMARII_TERRITORY_VIRTUAL_FIELDS = [
  'region',
  'siruta',
  'isUat',
  'population',
] as const;

/** Field names the document repo intercepts as VIRTUAL. */
export const PRIMARII_DOCUMENT_VIRTUAL_FIELDS = ['hasContent'] as const;

export const PRIMARII_FILTER_SPECS = {
  entity: primariiEntityFilterSpec,
  document: primariiDocumentFilterSpec,
} as const;
