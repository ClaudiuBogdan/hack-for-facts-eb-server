/**
 * Judicial module — the FLAT transport-argument mapping (API-04, foundation
 * §7.3). One rule table per collection maps each flat REST query parameter /
 * MCP argument to its spec field and operator, so both adapters build the SAME
 * kernel operator object (and therefore the same cursor identity hash) that the
 * GraphQL filter input expresses directly. No DSL: lists are flat lists
 * (repeated REST parameters), ranges are `xFrom`/`xTo`, separate operators are
 * `xGte`/`xLte`, presence is `xIsNull`.
 *
 * Values pass through AS RECEIVED (MCP: the original typed values; REST: the
 * values after the route's strict lexical decode). Type, enum, range and bound
 * validation stays with the repo normalizers — this module never coerces,
 * trims, splits or drops a value.
 */

import {
  JUDICIAL_COURT_LEVELS,
  JUDICIAL_DECISION_LINK_STATUSES,
  JUDICIAL_DECISION_PRIVACY_CLASSES,
  JUDICIAL_DECISION_SUBJECT_KINDS,
} from '../../core/types.js';

import type { FilterInput } from '@/modules/shared/index.js';

/** The lexical kind of a flat argument (REST decodes text into it; MCP types it). */
export type FlatKind = 'string' | 'stringList' | 'int' | 'bool';

/** Where a flat argument lands in the operator object. */
export type FlatTarget = 'eq' | 'in' | 'gte' | 'lte' | 'contains' | 'isNull' | 'from' | 'to';

export interface FlatRule {
  /** The flat parameter / argument name. */
  readonly key: string;
  /** The spec field it filters. */
  readonly field: string;
  /** The operator (`from`/`to` are the endpoints of `between`). */
  readonly target: FlatTarget;
  readonly kind: FlatKind;
  /** Optional closed vocabulary (MCP schemas only; the repo validates it anyway). */
  readonly enumValues?: readonly string[];
  readonly description: string;
}

const rule = (
  key: string,
  field: string,
  target: FlatTarget,
  kind: FlatKind,
  description: string,
  enumValues?: readonly string[]
): FlatRule => ({
  key,
  field,
  target,
  kind,
  description,
  ...(enumValues !== undefined && { enumValues }),
});

/** judicialCourts: the courts spec. */
export const COURT_FLAT_RULES: readonly FlatRule[] = [
  rule('level', 'level', 'in', 'stringList', 'Court level(s).', JUDICIAL_COURT_LEVELS),
  rule('countyCode', 'countyCode', 'in', 'stringList', 'County abbreviation(s) as stored.'),
  rule(
    'countySiruta',
    'countySiruta',
    'in',
    'stringList',
    'DEPRECATED misnamed alias of countyCode (the same county abbreviation; both apply).'
  ),
  rule('specialization', 'specialization', 'eq', 'string', 'Exact specialization.'),
  rule(
    'specializationContains',
    'specialization',
    'contains',
    'string',
    'Specialization substring.'
  ),
  rule('q', 'q', 'contains', 'string', 'Court locality substring.'),
];

/** judicialCases / the caseload aggregate: the cases spec. */
export const CASE_FLAT_RULES: readonly FlatRule[] = [
  rule('institutionCode', 'institutionCode', 'in', 'stringList', 'Court institution code(s).'),
  rule('courtLevel', 'courtLevel', 'in', 'stringList', 'Court level(s).', JUDICIAL_COURT_LEVELS),
  rule('category', 'category', 'in', 'stringList', 'Raw case category code(s).'),
  rule('stage', 'stage', 'in', 'stringList', 'Raw procedural stage code(s).'),
  rule(
    'year',
    'year',
    'eq',
    'int',
    'Session calendar year of the source-dependent sourceOpenedAt (nonzero 32-bit integer).'
  ),
  rule('yearFrom', 'year', 'from', 'int', 'Year range lower bound (between.from).'),
  rule('yearTo', 'year', 'to', 'int', 'Year range upper bound (between.to).'),
  rule('yearGte', 'year', 'gte', 'int', 'Year lower bound as the separate gte operator.'),
  rule('yearLte', 'year', 'lte', 'int', 'Year upper bound as the separate lte operator.'),
  rule('modifiedFrom', 'modified', 'from', 'string', 'Source-modified range lower bound.'),
  rule('modifiedTo', 'modified', 'to', 'string', 'Source-modified range upper bound.'),
  rule('modifiedGte', 'modified', 'gte', 'string', 'Source-modified lower bound (gte).'),
  rule('modifiedLte', 'modified', 'lte', 'string', 'Source-modified upper bound (lte).'),
  rule('q', 'q', 'contains', 'string', 'Case object substring (never party names).'),
  rule(
    'objectIsNull',
    'hasObject',
    'isNull',
    'bool',
    'true: the case object is null; false: present.'
  ),
];

const decisionText = (name: string, column: string): readonly FlatRule[] => [
  rule(name, name, 'eq', 'string', `Exact stored ${column} text.`),
  rule(`${name}IsNull`, name, 'isNull', 'bool', `true: ${column} is null; false: present.`),
];

/** judicialDecisions: the decisions spec. */
export const DECISION_FLAT_RULES: readonly FlatRule[] = [
  rule('sourceSystem', 'sourceSystem', 'eq', 'string', 'Exact stored source system (a bound).'),
  rule('issuingBody', 'issuingBody', 'eq', 'string', 'Exact stored issuing-body key (a bound).'),
  ...decisionText('decisionNo', 'decision_no'),
  ...decisionText('decisionKind', 'decision_kind'),
  rule(
    'decisionYear',
    'decisionYear',
    'eq',
    'int',
    'Stored decision_year (32-bit integer, 0 allowed).'
  ),
  rule('decisionYearFrom', 'decisionYear', 'from', 'int', 'decision_year range lower bound.'),
  rule('decisionYearTo', 'decisionYear', 'to', 'int', 'decision_year range upper bound.'),
  rule('decisionYearGte', 'decisionYear', 'gte', 'int', 'decision_year lower bound (gte).'),
  rule('decisionYearLte', 'decisionYear', 'lte', 'int', 'decision_year upper bound (lte).'),
  rule(
    'decisionYearIsNull',
    'decisionYear',
    'isNull',
    'bool',
    'true: decision_year is null; false: present.'
  ),
  rule(
    'decisionDateIsNull',
    'decisionDate',
    'isNull',
    'bool',
    'true: decision_date is null; false: present (presence only).'
  ),
  ...decisionText('outcomeNormalized', 'outcome_normalized'),
  ...decisionText('ecli', 'ecli'),
  ...decisionText('applicationNo', 'application_no'),
  rule(
    'privacyClass',
    'privacyClass',
    'eq',
    'string',
    'Stored privacy class label.',
    JUDICIAL_DECISION_PRIVACY_CLASSES
  ),
];

/** judicialDecisionSubjectLinks: the link spec (exactly one anchor; the repo enforces it). */
export const DECISION_LINK_FLAT_RULES: readonly FlatRule[] = [
  rule('decisionId', 'decisionId', 'eq', 'string', 'Decision anchor (canonical signed int8).'),
  rule(
    'subjectKind',
    'subjectKind',
    'eq',
    'string',
    'Subject anchor kind (with subjectRef).',
    JUDICIAL_DECISION_SUBJECT_KINDS
  ),
  rule('subjectRef', 'subjectRef', 'eq', 'string', 'Subject anchor exact text (with subjectKind).'),
  rule(
    'validationStatus',
    'validationStatus',
    'in',
    'stringList',
    'Recorded status label(s) narrowing an anchored read.',
    JUDICIAL_DECISION_LINK_STATUSES
  ),
];

const present = (value: unknown): boolean => value !== undefined && value !== null;

/**
 * Build the kernel operator object from flat arguments: null and omitted are
 * absent; every present value goes, unchanged, to its operator (`xFrom`/`xTo`
 * into one `between`). Keys outside the rule table are ignored here — the
 * adapters reject them before calling.
 */
export const flatToFilter = (
  rules: readonly FlatRule[],
  flat: Readonly<Record<string, unknown>>
): FilterInput => {
  const out: Record<string, Record<string, unknown>> = {};
  for (const r of rules) {
    const value = flat[r.key];
    if (!present(value)) continue;
    const ff = (out[r.field] ??= {});
    if (r.target === 'from' || r.target === 'to') {
      const between = (ff['between'] ??= {}) as Record<string, unknown>;
      between[r.target] = value;
    } else {
      ff[r.target] = value;
    }
  }
  return out as FilterInput;
};
