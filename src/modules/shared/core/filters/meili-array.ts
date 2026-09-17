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
 * Every filter ALWAYS pins `privacy_class = "public"` so the public gate can
 * never be dropped.
 *
 * SECURITY: the only values interpolated into expression strings come from
 * allowlisted/typed sources — `docTypes` ∈ `SEARCH_ENTITY_DOC_TYPES`, `roles` ∈ `SEARCH_ENTITY_ROLES`,
 * `isActive` is a boolean, and `county` must match a strict name shape. Every
 * string value is additionally JSON.stringify-quoted, so there is no
 * operator/quote-injection surface.
 *
 * Meili string equality is case-insensitive. County input still uses a
 * bounded name shape; callers map county codes to names upstream.
 */

import {
  SEARCH_ENTITY_DOC_TYPES,
  SEARCH_ENTITY_ROLES,
  type SearchEntityDocType,
  type SearchEntityRole,
} from '../types.js';

/** Meili array filter: filter-expression strings, AND-ed by Meili. */
export type MeiliEntitiesFilter = readonly string[];

export interface BuildEntitiesFilterInput {
  readonly docTypes?: readonly string[];
  readonly county?: string;
  /** Narrow to identities playing a given role (e.g. every PNRR entity). */
  readonly roles?: readonly string[];
  /** Narrow to entities that are currently active (half of all companies are
   *  struck off, so this is the single strongest quality filter). */
  readonly isActive?: boolean;
  readonly isUat?: boolean;
  readonly entityTags?: readonly string[];
  readonly excludeEntityTags?: readonly string[];
}

/** Same namespaced tag shape as the public-entity vocabulary; unknown values are valid. */
export const ENTITY_TAG_PATTERN = /^[a-z][a-z0-9_]*(?:::[a-z][a-z0-9_]*)+$/u;
export const validEntityTags = (tags: readonly string[] | undefined): boolean =>
  tags === undefined ||
  (tags.length <= 100 && tags.every((tag) => tag.length <= 200 && ENTITY_TAG_PATTERN.test(tag)));

const ENTITY_DOC_TYPE_SET = new Set<string>(SEARCH_ENTITY_DOC_TYPES);

const ENTITY_ROLE_SET = new Set<string>(SEARCH_ENTITY_ROLES);

export const validEntityRoles = (
  roles: readonly string[] | undefined
): readonly SearchEntityRole[] =>
  roles === undefined
    ? []
    : [...new Set(roles.filter((role): role is SearchEntityRole => ENTITY_ROLE_SET.has(role)))];

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
  // The palette carries the full `privacy_class`, not a binary visibility flag.
  // This clause is ALWAYS pinned so the public gate can never be dropped.
  const clauses: string[] = [`privacy_class = ${quote('public')}`];

  // doc_type IN ["a","b"] — drop unknown/duplicate types; omit entirely when
  // nothing valid remains (so we never narrow to an impossible empty IN).
  const docTypes = validEntityDocTypes(input.docTypes);
  if (docTypes.length > 0) {
    clauses.push(`doc_type IN [${docTypes.map(quote).join(', ')}]`);
  }

  // roles IN [...] — catalog document types are not entity roles.
  const roles = validEntityRoles(input.roles);
  if (roles.length > 0) {
    clauses.push(`roles IN [${roles.map(quote).join(', ')}]`);
  }

  // county_name = "<canonical name>" — only for a shape-valid county.
  const county = normalizeCounty(input.county);
  if (county !== undefined) clauses.push(`county_name = ${quote(county)}`);

  if (input.isActive !== undefined) {
    clauses.push(`is_active = ${input.isActive ? 'true' : 'false'}`);
  }

  if (input.isUat !== undefined) {
    clauses.push(`is_uat = ${input.isUat ? 'true' : 'false'}`);
  }
  // Array membership is OR within a facet; separate clauses are ANDed.
  const facets = new Map<string, string[]>();
  for (const tag of [...new Set(input.entityTags ?? [])].sort()) {
    const facet = tag.split('::')[0] ?? '';
    const values = facets.get(facet) ?? [];
    values.push(tag);
    facets.set(facet, values);
  }
  for (const values of facets.values()) {
    clauses.push(`entity_tags IN [${values.map(quote).join(', ')}]`);
  }
  const excluded = [...new Set(input.excludeEntityTags ?? [])].sort();
  if (excluded.length > 0) clauses.push(`entity_tags NOT IN [${excluded.map(quote).join(', ')}]`);
  return clauses;
};
