/**
 * Shared Kernel — Meilisearch ARRAY filter builder for the `entities` index
 * (search module plan, item 3).
 *
 * SECURITY: this builds Meili's structured ARRAY filter form, NOT a hand-built
 * filter string — there is no string concatenation of user input and therefore
 * no escaping/injection surface. Values are placed as array tokens; Meili
 * parameterizes them. The outer array is an implicit AND of inner clauses; a
 * clause is `[field, op, value]`, and `IN` carries an array value.
 *
 * Every filter ALWAYS pins `["visibility","=","public"]` so the public gate can
 * never be dropped. Inputs are allowlist-validated: `docTypes` are kept only when
 * ∈ `SEARCH_ENTITY_DOC_TYPES` (unknowns dropped); `year` must be an integer;
 * `county` must be a non-empty string. An absent/invalid optional clause is
 * simply omitted (never emitted as a broken predicate).
 *
 * NOTE: Meili string equality is CASE-SENSITIVE — `county` must already be a
 * canonical county name (`'Cluj'` ≠ `'cluj'`); this builder does not normalize
 * case (callers map county codes → canonical names upstream).
 */

import { SEARCH_ENTITY_DOC_TYPES, type SearchEntityDocType } from '../types.js';

/** A single Meili filter clause: `[field, operator, value]`. */
export type MeiliFilterClause = readonly [string, string, string | readonly string[]];

/**
 * Meili's array filter form: a leading `'AND'` token followed by clauses. The
 * `visibility=public` clause is always present, so the array is never empty.
 */
export type MeiliEntitiesFilter = readonly [string, ...MeiliFilterClause[]];

export interface BuildEntitiesFilterInput {
  readonly docTypes?: readonly string[];
  readonly county?: string;
  readonly year?: number;
}

const ENTITY_DOC_TYPE_SET = new Set<string>(SEARCH_ENTITY_DOC_TYPES);

const isEntityDocType = (value: string): value is SearchEntityDocType =>
  ENTITY_DOC_TYPE_SET.has(value);

/**
 * Build the visibility-pinned, allowlist-validated Meili array filter for an
 * entities search. Pure: no IO, no throw — invalid optional clauses are dropped.
 */
export const buildEntitiesFilter = (input: BuildEntitiesFilterInput): MeiliEntitiesFilter => {
  const clauses: MeiliFilterClause[] = [['visibility', '=', 'public']];

  // doc_type IN [valid…] — drop unknown/duplicate types; omit the clause entirely
  // when nothing valid remains (so we never narrow to an impossible empty IN).
  if (input.docTypes !== undefined) {
    const validDocTypes = [...new Set(input.docTypes.filter(isEntityDocType))];
    if (validDocTypes.length > 0) clauses.push(['doc_type', 'IN', validDocTypes]);
  }

  // county_name = '<canonical name>' — only when a non-empty string is given.
  if (input.county !== undefined) {
    const county = input.county.trim();
    if (county !== '') clauses.push(['county_name', '=', county]);
  }

  // year = <int> — only when an integer is given (NaN/float ignored).
  if (input.year !== undefined && Number.isInteger(input.year)) {
    clauses.push(['year', '=', String(input.year)]);
  }

  return ['AND', ...clauses];
};
