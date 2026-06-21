/**
 * Shared Kernel — Meilisearch filter builder for the `entities` index
 * (search module plan, item 3).
 *
 * Emits Meili's documented ARRAY filter form: an array of filter-expression
 * STRINGS that Meili AND-s together (e.g. `['visibility = "public"',
 * 'doc_type IN ["company","bill"]']`). This is NOT a `['AND', [field, op, value]]`
 * token form — Meili rejects that, so the whole search would 400 and silently
 * degrade to pg-only. See https://www.meilisearch.com/docs (filter expressions).
 *
 * Every filter ALWAYS pins `visibility = "public"` so the public gate can never
 * be dropped.
 *
 * SECURITY: the only values interpolated into expression strings come from
 * allowlisted/typed sources — `docTypes` ∈ `SEARCH_ENTITY_DOC_TYPES`, `year` is
 * an integer, and `county` must match a strict name shape. Every string value is
 * additionally JSON.stringify-quoted, so there is no operator/quote-injection
 * surface.
 *
 * NOTE: Meili string equality is CASE-SENSITIVE — `county` must already be a
 * canonical county name (`'Cluj'` ≠ `'cluj'`); this builder does not normalize
 * case (callers map county codes → canonical names upstream).
 */

import { SEARCH_ENTITY_DOC_TYPES, type SearchEntityDocType } from '../types.js';

/** Meili array filter: filter-expression strings, AND-ed by Meili. */
export type MeiliEntitiesFilter = readonly string[];

export interface BuildEntitiesFilterInput {
  readonly docTypes?: readonly string[];
  readonly county?: string;
  readonly year?: number;
}

const ENTITY_DOC_TYPE_SET = new Set<string>(SEARCH_ENTITY_DOC_TYPES);

const isEntityDocType = (value: string): value is SearchEntityDocType =>
  ENTITY_DOC_TYPE_SET.has(value);

/**
 * County names are letters (incl. Romanian diacritics), spaces, hyphens,
 * apostrophes and dots — never quotes, brackets, or filter operators. Anything
 * else is dropped rather than risk altering the filter (defense in depth on top
 * of the JSON-quoting below).
 */
const COUNTY_NAME_RE = /^[\p{L}][\p{L} .'-]{0,62}$/u;

/** Requested doc types ∩ the entity-grade allowlist (deduped, order-preserved). */
export const validEntityDocTypes = (
  docTypes: readonly string[] | undefined
): readonly SearchEntityDocType[] =>
  docTypes === undefined ? [] : [...new Set(docTypes.filter(isEntityDocType))];

/** A shape-valid, trimmed canonical county name, or `undefined` when invalid. */
export const normalizeCounty = (county: string | undefined): string | undefined => {
  if (county === undefined) return undefined;
  const trimmed = county.trim();
  return COUNTY_NAME_RE.test(trimmed) ? trimmed : undefined;
};

/** Quote a string value for a Meili filter expression (no injection surface). */
const quote = (value: string): string => JSON.stringify(value);

/**
 * Build the visibility-pinned, allowlist-validated Meili array filter for an
 * entities search. Pure: no IO, no throw — invalid optional clauses are dropped.
 */
export const buildEntitiesFilter = (input: BuildEntitiesFilterInput): MeiliEntitiesFilter => {
  const clauses: string[] = [`visibility = ${quote('public')}`];

  // doc_type IN ["a","b"] — drop unknown/duplicate types; omit entirely when
  // nothing valid remains (so we never narrow to an impossible empty IN).
  const docTypes = validEntityDocTypes(input.docTypes);
  if (docTypes.length > 0) {
    clauses.push(`doc_type IN [${docTypes.map(quote).join(', ')}]`);
  }

  // county_name = "<canonical name>" — only for a shape-valid county.
  const county = normalizeCounty(input.county);
  if (county !== undefined) clauses.push(`county_name = ${quote(county)}`);

  // year = <int> — only when an integer is given (NaN/float ignored).
  if (input.year !== undefined && Number.isInteger(input.year)) {
    clauses.push(`year = ${String(input.year)}`);
  }

  return clauses;
};
