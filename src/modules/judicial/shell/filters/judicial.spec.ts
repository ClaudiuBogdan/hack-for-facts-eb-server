/**
 * Judicial module — filter specs (plan 08 §7). The module only DECLARES the
 * `CollectionFilterSpec`s; the kernel derivers compile GraphQL input / SQL
 * conditions + the stable `fhash` (§14.2). No DSL is invented.
 *
 * Aliases (BINDING): `c` = justice.cases, `co` = justice.courts.
 *
 * VIRTUAL FIELDS (kernel §14.2): `courtLevel` and `year`/`yearFrom`/`yearTo` are
 * declared VIRTUAL — the repo intercepts them and compiles the physical predicate
 * itself (a bounded join to `justice.courts.court_level` for level; a
 * `date_part('year', source_opened_at)` predicate for the year range, since there
 * is no native year column). `toConditionBuilders` skips them so no broken SQL is
 * emitted (#60b). All other fields map directly to a `justice.cases` column.
 */

import {
  JUDICIAL_COURT_LEVELS,
  type JudicialCourtLevel,
} from '../../core/types.js';

import type { CollectionFilterSpec } from '@/modules/shared/index.js';

export const COURT_LEVEL_VALUES: readonly string[] = JUDICIAL_COURT_LEVELS;

/**
 * The `judicial_cases` collection spec. Drives the case list + the JD-2 aggregate.
 *
 * BOUNDING RULE (enforced in the repo, not here): at least one of `institutionCode`,
 * `courtLevel`, a `year*` range, or a `modified*` range must be present, else
 * `InvalidInput` ("judicial case list requires a court or period bound"). This is
 * the §3 "no implicit unbounded scans" rule for a 6.16M-row table.
 */
export const judicialCasesSpec: CollectionFilterSpec = {
  collection: 'judicial_cases',
  fields: [
    {
      name: 'institutionCode',
      type: 'string',
      ops: ['in'],
      column: { alias: 'c', column: 'institution_code' },
      array: true,
      description: 'Court institution code(s). Driving index cases_institution_idx.',
    },
    {
      // VIRTUAL: a bounded join to justice.courts.court_level (no court_level column
      // on justice.cases). The repo resolves the matching institution_codes.
      name: 'courtLevel',
      type: 'enum',
      ops: ['in'],
      column: { alias: 'co', column: 'court_level' },
      array: true,
      enumValues: COURT_LEVEL_VALUES,
      virtual: true,
      description: 'Court level (judecatorie/tribunal/curte_de_apel/...). Resolved via a bounded courts join.',
    },
    {
      name: 'category',
      type: 'string',
      ops: ['in'],
      column: { alias: 'c', column: 'category' },
      array: true,
      description: 'Raw case category code(s).',
    },
    {
      name: 'stage',
      type: 'string',
      ops: ['in'],
      column: { alias: 'c', column: 'stage' },
      array: true,
      description: 'Raw procedural stage code(s).',
    },
    {
      // VIRTUAL: year derived from source_opened_at (no native year column). The
      // repo compiles `source_opened_at >= make_date(from,1,1)` / `< make_date(to+1,...)`.
      name: 'year',
      type: 'int',
      ops: ['eq', 'gte', 'lte', 'between'],
      column: { alias: 'c', column: 'source_opened_at' },
      virtual: true,
      description: 'Case opened year (derived from source_opened_at).',
    },
    {
      name: 'modified',
      type: 'date',
      ops: ['between', 'gte', 'lte'],
      column: { alias: 'c', column: 'latest_source_modified_at' },
      description: 'Last source-modified date range. Driving index cases_modified_idx.',
    },
    {
      name: 'q',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'c', column: 'object' },
      description: 'Trigram/ILIKE on the case object (procedural subject). NEVER party names.',
    },
    {
      name: 'hasObject',
      type: 'bool',
      ops: ['isNull'],
      column: { alias: 'c', column: 'object' },
      description: 'isNull:true ⇒ object IS NULL; isNull:false ⇒ IS NOT NULL (kernel op semantics).',
    },
  ],
  sort: {
    default: 'modifiedAt',
    allowed: ['modifiedAt', 'openedAt'],
  },
};

/** The `judicial_courts` collection spec (246-row reference; cheap full scan). */
export const judicialCourtsSpec: CollectionFilterSpec = {
  collection: 'judicial_courts',
  fields: [
    {
      name: 'level',
      type: 'enum',
      ops: ['in'],
      column: { alias: 'co', column: 'court_level' },
      array: true,
      enumValues: COURT_LEVEL_VALUES,
    },
    {
      name: 'countySiruta',
      type: 'string',
      ops: ['in'],
      column: { alias: 'co', column: 'county_code' },
      array: true,
      description: 'County code (soft link to the territory hub).',
    },
    {
      name: 'specialization',
      type: 'string',
      ops: ['eq', 'contains'],
      column: { alias: 'co', column: 'specialization' },
    },
    {
      name: 'q',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'co', column: 'locality' },
      description: 'Court locality / code trigram (name autocomplete).',
    },
  ],
  sort: { default: 'ordinal', allowed: ['ordinal'] },
};

/** The set of fields that satisfy the §7.1 bounding rule for the case list. */
export const JUDICIAL_CASE_BOUNDING_FIELDS = [
  'institutionCode',
  'courtLevel',
  'year',
  'modified',
] as const;

export const JUDICIAL_FILTER_SPECS = {
  cases: judicialCasesSpec,
  courts: judicialCourtsSpec,
} as const;

export type { JudicialCourtLevel };
