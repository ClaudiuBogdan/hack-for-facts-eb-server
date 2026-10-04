/**
 * Judicial module — filter specs (plan 08 §7). The module only DECLARES the
 * `CollectionFilterSpec`s; the kernel derivers compile GraphQL input / SQL
 * conditions + the stable `fhash` (§14.2). No DSL is invented.
 *
 * Aliases (BINDING): `c` = justice.cases, `co` = justice.courts.
 *
 * VIRTUAL FIELDS (kernel §14.2): `courtLevel` and `year`/`yearFrom`/`yearTo` are
 * declared VIRTUAL — the repo intercepts them and compiles the physical predicate
 * itself (a bounded join to `justice.courts.court_level` for level; a finite
 * session-calendar-year interval over `source_opened_at` for the year, since there
 * is no native year column). `toConditionBuilders` skips them so no broken SQL is
 * emitted (#60b). All other fields map directly to a `justice.cases` column.
 *
 * A3: the repo validates the virtual values itself (the kernel never does):
 * court levels against the taxonomy, years as nonzero 32-bit integers whose
 * operators intersect. Null at an optional field/operator/endpoint is absent.
 */

import {
  JUDICIAL_COURT_LEVELS,
  JUDICIAL_DECISION_LINK_STATUSES,
  JUDICIAL_DECISION_PRIVACY_CLASSES,
  JUDICIAL_DECISION_SUBJECT_KINDS,
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
      description:
        'Court level (judecatorie/tribunal/curte_de_apel/...). Resolved via a bounded courts join. An unknown level is an input error.',
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
      // repo intersects the operators and compiles ONE interval: isfinite(...)
      // plus native January boundaries for ordinary AD years, otherwise native
      // extract(year ...) comparisons (BC, expanded and domain-edge years).
      name: 'year',
      type: 'int',
      ops: ['eq', 'gte', 'lte', 'between'],
      column: { alias: 'c', column: 'source_opened_at' },
      virtual: true,
      description:
        'Session calendar year of sourceOpenedAt, a SOURCE-DEPENDENT date (see JudicialCase.sourceOpenedAtBasis: Portal Just header data, the ICCJ archive case-date field, otherwise unknown) - not a universal filing date. A range over several sources combines their different clocks. Operands are nonzero 32-bit integers (1 BC is -1); eq, gte, lte and between all apply together (their intersection: eq 2024 with gte 2020 means only 2024), and a contradictory range matches nothing. Null or infinite dates never match a year filter.',
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
      description:
        'isNull:true ⇒ object IS NULL; isNull:false ⇒ IS NOT NULL (kernel op semantics).',
    },
  ],
  sort: {
    default: 'modifiedAt',
    allowed: ['modifiedAt', 'openedAt'],
  },
};

/** The `judicial_courts` collection spec (small court reference; cheap full scan). */
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
      name: 'countyCode',
      type: 'string',
      ops: ['in'],
      column: { alias: 'co', column: 'county_code' },
      array: true,
      description:
        'County abbreviation(s) exactly as stored on the court (courts.county_code, e.g. B, TM). Not a SIRUTA code.',
    },
    {
      // DEPRECATED, MISNAMED alias kept for compatibility: the same column and
      // values as countyCode. Supplying both ANDs the two predicates.
      name: 'countySiruta',
      type: 'string',
      ops: ['in'],
      column: { alias: 'co', column: 'county_code' },
      array: true,
      description:
        'DEPRECATED misnamed alias of countyCode: filters the same county abbreviation (courts.county_code, e.g. B, TM), NOT a SIRUTA code. When both countyCode and countySiruta are supplied, both predicates apply (AND).',
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

// ── stored decisions (API-04) ────────────────────────────────────────────────
//
// Aliases (BINDING): `d` = justice.decisions, `l` = justice.decision_subject_links.
// VIRTUAL: `decisionYear` (compiled by the repo with explicit integer operands,
// so an out-of-smallint operand can never be inferred as a smallint parameter)
// and the link `decisionId` (a canonical signed int8 compared ::bigint). All
// other fields are exact-text or enum kernel predicates.

/**
 * The `judicial_decisions` collection. BOUNDING RULE (enforced in the repo):
 * `sourceSystem.eq` or `issuingBody.eq` must be present (an explicitly supplied
 * empty string is an equality predicate); year, presence or attribute filters
 * alone never authorize a decision-table scan. Sort: decisionId DESC only.
 */
export const judicialDecisionsSpec: CollectionFilterSpec = {
  collection: 'judicial_decisions',
  fields: [
    {
      name: 'sourceSystem',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'd', column: 'source_system' },
      description:
        'Exact stored source system (an empty string is an exact value). Bounds the list (decisions_source_ref_uq leads with it).',
    },
    {
      name: 'issuingBody',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'd', column: 'issuing_body' },
      description:
        'Exact stored issuing-body key (see judicialIssuingBodies). Bounds the list (decisions_issuing_body_idx).',
    },
    {
      name: 'decisionNo',
      type: 'string',
      ops: ['eq', 'isNull'],
      column: { alias: 'd', column: 'decision_no' },
      description: 'Exact stored decision number text (not an identity on its own).',
    },
    {
      name: 'decisionKind',
      type: 'string',
      ops: ['eq', 'isNull'],
      column: { alias: 'd', column: 'decision_kind' },
      description: 'Exact stored decision kind text.',
    },
    {
      name: 'decisionYear',
      type: 'int',
      ops: ['eq', 'gte', 'lte', 'between', 'isNull'],
      column: { alias: 'd', column: 'decision_year' },
      virtual: true,
      description:
        'The stored decision_year: an independent nullable smallint (it can be 0, negative, or differ from the year of decisionDate). Operands are 32-bit integers including 0; eq, gte, lte and between all apply together (their intersection), and isNull applies alongside them.',
    },
    {
      name: 'decisionDate',
      type: 'date',
      ops: ['isNull'],
      column: { alias: 'd', column: 'decision_date' },
      description: 'Presence of the stored decision date only (no date-range filter).',
    },
    {
      name: 'outcomeNormalized',
      type: 'string',
      ops: ['eq', 'isNull'],
      column: { alias: 'd', column: 'outcome_normalized' },
      description: 'Exact stored outcome attribute text (an attribute, never an identity).',
    },
    {
      name: 'ecli',
      type: 'string',
      ops: ['eq', 'isNull'],
      column: { alias: 'd', column: 'ecli' },
      description: 'Exact stored ECLI text (not a unique lookup key).',
    },
    {
      name: 'applicationNo',
      type: 'string',
      ops: ['eq', 'isNull'],
      column: { alias: 'd', column: 'application_no' },
      description: 'Exact stored application number text (not a unique lookup key).',
    },
    {
      name: 'privacyClass',
      type: 'enum',
      ops: ['eq'],
      column: { alias: 'd', column: 'privacy_class' },
      enumValues: JUDICIAL_DECISION_PRIVACY_CLASSES,
      description:
        'The stored privacy class label (public or restricted); both are served as stored.',
    },
  ],
  sort: { default: 'decisionId', allowed: ['decisionId'] },
};

/**
 * The `judicial_decision_subject_links` collection, at LINK grain. ANCHOR RULE
 * (enforced in the repo): EXACTLY ONE of `decisionId.eq`, or the complete
 * `subjectKind.eq` + `subjectRef.eq` pair. `validationStatus` only narrows an
 * anchored read. Sort: linkId DESC only.
 */
export const judicialDecisionSubjectLinksSpec: CollectionFilterSpec = {
  collection: 'judicial_decision_subject_links',
  fields: [
    {
      name: 'decisionId',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'l', column: 'decision_id' },
      virtual: true,
      description:
        'The decision anchor: a canonical signed int8 decimal string (decision_subject_links_decision_idx).',
    },
    {
      name: 'subjectKind',
      type: 'enum',
      ops: ['eq'],
      column: { alias: 'l', column: 'subject_kind' },
      enumValues: JUDICIAL_DECISION_SUBJECT_KINDS,
      description:
        'With subjectRef, the subject anchor (decision_subject_links_subject_idx). Exact kind.',
    },
    {
      name: 'subjectRef',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'l', column: 'subject_ref' },
      description:
        'With subjectKind, the subject anchor: exact stored text (no CUI normalization, no identity resolution).',
    },
    {
      name: 'validationStatus',
      type: 'enum',
      ops: ['in'],
      column: { alias: 'l', column: 'validation_status' },
      array: true,
      enumValues: JUDICIAL_DECISION_LINK_STATUSES,
      description:
        'Recorded status label(s) narrowing an anchored read; never an anchor and never a verification.',
    },
  ],
  sort: { default: 'linkId', allowed: ['linkId'] },
};

export const JUDICIAL_FILTER_SPECS = {
  cases: judicialCasesSpec,
  courts: judicialCourtsSpec,
  decisions: judicialDecisionsSpec,
  decisionSubjectLinks: judicialDecisionSubjectLinksSpec,
} as const;

export type { JudicialCourtLevel };
