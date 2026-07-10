/**
 * Legal module — filter specs (plan §7.1). **05 OWNS the shared legal filter
 * families** (`act_type`, `issuer`, `domain`, `year`/range, `status`); 06 reuses
 * the same field shapes for its MO collections. The module only DECLARES the
 * `CollectionFilterSpec`; the kernel derivers compile TypeBox / GraphQL input /
 * SQL conditions + the stable `fhash` (§14.2).
 *
 * Aliases (BINDING — §7.1 join discipline):
 *   `a` = legal.acts, `d` = canonical legal.act_documents, `s` = legal.document_summaries.
 * The acts list FROM is FIXED + unconditional (the kernel composer adds WHERE
 * conditions only, never joins):
 *   legal.acts a
 *     LEFT JOIN legal.act_documents d   ON d.act_id = a.act_id AND d.is_canonical
 *     LEFT JOIN legal.document_summaries s ON s.document_id = d.document_id
 * The canonical predicate is in the JOIN, so a multi-document act contributes
 * exactly one summary row (no double-count) regardless of active filters.
 *
 * VOCABULARY SEPARATION (BINDING): `act_type` (the legal instrument: lege/oug/
 * hotarare/ordin/...) is resolved from `distinct legal.acts.act_type` and is a
 * DIFFERENT vocabulary from `document_category` (the AI label: hotarare-de-guvern/
 * norma-metodologica/...). They are independent filter fields, never cross-validated.
 */

import type { CollectionFilterSpec } from '@/modules/shared/index.js';

/**
 * Enum value sets. These are the FALLBACK literals; the live values are resolved
 * at boot from the DB (`resolveLegalVocab`, see shell/filters/vocab.ts) so a new
 * act_type/domain/category added by the loader surfaces without a code change.
 * Declared here so the spec is self-contained for tests + the GraphQL `enumValues`.
 */

/** `legal.acts.act_type` — the legal instrument (verified live: ~30 values). */
export const ACT_TYPE_VALUES: readonly string[] = [
  'lege',
  'oug',
  'og',
  'hotarare',
  'ordin',
  'decizie',
  'decret',
  'norma',
  'regulament',
  'rectificare',
  'metodologie',
  'comunicat',
  'procedura',
  'acord',
  'circulara',
  'instructiuni',
  'raport',
  'unknown',
];

/** `legal.document_summaries.document_category` — the AI category (13 live values). */
export const CATEGORY_VALUES: readonly string[] = [
  'lege',
  'ordin',
  'hotarare',
  'hotarare-de-guvern',
  'decizie',
  'decret',
  'norma-metodologica',
  'regulament',
  'ordonanta',
  'ordonanta-de-urgenta',
  'tratat',
  'circulara',
  'altele',
];

/** `legal.document_summaries.domains` — the controlled 16-value vocab (GIN array). */
export const DOMAIN_VALUES: readonly string[] = [
  'administratie',
  'fiscal-si-bugetar',
  'justitie',
  'economie-si-comert',
  'munca-si-protectie-sociala',
  'proprietate-si-urbanism',
  'sanatate',
  'aparare-si-securitate',
  'transport',
  'educatie',
  'mediu',
  'agricultura',
  'energie',
  'cultura',
  'telecomunicatii-si-digital',
  'altele',
];

/** `legal.acts.status` — the closed status fold vocab. */
export const STATUS_VALUES: readonly string[] = [
  'in-vigoare',
  'modificat',
  'abrogat',
  'abrogat-partial',
  'suspendat',
  'iesit-din-vigoare',
  'necunoscut',
];

/**
 * The `legal_acts` collection spec — the shared legal families (§9). The four
 * skeleton families 06 reuses are `actType` (act_type), `issuerSlug` (issuer),
 * `domain`, and `year`/`yearFrom`/`yearTo`; `status` is shared too.
 */
export const legalActsSpec: CollectionFilterSpec = {
  collection: 'legal_acts',
  fields: [
    {
      name: 'actType',
      type: 'enum',
      ops: ['in'],
      column: { alias: 'a', column: 'act_type' },
      array: true,
      exclude: true,
      enumValues: ACT_TYPE_VALUES,
      description: 'The legal instrument (lege/oug/hotarare/ordin/...). Distinct from category.',
    },
    {
      name: 'issuerSlug',
      type: 'string',
      ops: ['in'],
      column: { alias: 'a', column: 'issuer_slug' },
      array: true,
      exclude: true,
      description: 'Diacritics-folded issuer slug (guvernul, parlamentul, ...).',
    },
    {
      name: 'status',
      type: 'enum',
      ops: ['in'],
      column: { alias: 'a', column: 'status' },
      array: true,
      exclude: true,
      enumValues: STATUS_VALUES,
    },
    { name: 'year', type: 'int', ops: ['eq'], column: { alias: 'a', column: 'act_year' } },
    { name: 'yearFrom', type: 'int', ops: ['gte'], column: { alias: 'a', column: 'act_year' } },
    { name: 'yearTo', type: 'int', ops: ['lte'], column: { alias: 'a', column: 'act_year' } },
    {
      name: 'domain',
      type: 'enum',
      ops: ['in'],
      column: { alias: 's', column: 'domains', arrayColumn: true, arrayKind: 'text' },
      array: true,
      exclude: true,
      enumValues: DOMAIN_VALUES,
      description: 'AI-derived subject domain (GIN text[] containment on document_summaries).',
    },
    {
      name: 'category',
      type: 'enum',
      ops: ['in'],
      column: { alias: 's', column: 'document_category' },
      array: true,
      exclude: true,
      enumValues: CATEGORY_VALUES,
      description: 'AI document category. A DIFFERENT vocabulary from actType.',
    },
    {
      name: 'penaltiesMentioned',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 's', column: 'penalties_mentioned' },
    },
    {
      // KERNEL `isNull` SEMANTICS (BINDING): the kernel composer compiles
      // `isNull: true` → `fiscal_impact IS NULL` and `isNull: false` → `IS NOT
      // NULL` (derive.ts opSql). So this field is named for the column, not the
      // human "present" concept, to avoid the inversion Codex flagged: a client
      // sets `fiscalImpactNull: { isNull: false }` to get acts WITH a fiscal
      // impact. The GraphQL layer surfaces it as `fiscalImpactNull` (an honest
      // mirror of the kernel op), not a misleading `fiscalImpactPresent`.
      name: 'fiscalImpactNull',
      type: 'bool',
      ops: ['isNull'],
      column: { alias: 's', column: 'fiscal_impact' },
      description:
        'isNull:true ⇒ fiscal_impact IS NULL; isNull:false ⇒ IS NOT NULL (kernel op semantics).',
    },
    {
      name: 'q',
      type: 'string',
      ops: ['contains', 'prefix'],
      column: { alias: 'a', column: 'display_citation' },
      description: 'Trigram/ILIKE on the citation (engine-backed in search; fallback here).',
    },
  ],
  sort: {
    default: 'in_degree',
    allowed: ['in_degree', 'act_year', 'entry_into_force', 'display_citation'],
  },
};

export const LEGAL_FILTER_SPECS = {
  acts: legalActsSpec,
} as const;
