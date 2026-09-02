/**
 * Faceted tag filter validation + facet grouping — ported from the legacy
 * `infra/database/query-filters/entity-filter.ts` (the infra dies with the
 * legacy modules, so the rule is copied here, not imported).
 *
 * Deliberately NOT a closed-vocabulary check: a well-formed unknown tag simply
 * matches nothing, and a new tag from the classification engine must never be
 * rejected by the API. Malformed tags are rejected LOUDLY (`InvalidInput`) —
 * a filter that quietly becomes a no-op WIDENS the result set.
 *
 * Ancestor roll-up is materialized in the data (an entity tagged
 * `kind::school::gymnasium` physically also carries `kind::school`), so exact
 * containment is the complete predicate — the legacy builder did no prefix
 * expansion and neither does this one.
 */

import { err, ok, type Result } from 'neverthrow';

import type { ApiError } from '@/modules/shared/index.js';

/** `namespace::value` with an optional third segment. */
export const TAG_FILTER_PATTERN = /^[a-z_]+(::[a-z_]+){1,2}$/u;

export const validateTags = (
  tags: readonly string[],
  field: string
): Result<readonly string[], ApiError> => {
  for (const tag of tags) {
    if (!TAG_FILTER_PATTERN.test(tag)) {
      return err({
        type: 'InvalidInput',
        message:
          `Invalid tags filter value '${tag}': expected lowercase namespace::value ` +
          `(e.g. 'kind::hospital' or 'kind::school::gymnasium').`,
        field,
      });
    }
  }
  return ok(tags);
};

/** `kind::school::gymnasium` → `kind`. Validation has already run. */
const facetOf = (tag: string): string => tag.slice(0, tag.indexOf('::'));

/**
 * Group validated tags by facet (insertion order, deduplicated): OR within a
 * group, AND across groups — the legacy `buildTagConditions` shape.
 */
export const groupTagsByFacet = (tags: readonly string[]): readonly (readonly string[])[] => {
  const byFacet = new Map<string, string[]>();
  for (const tag of new Set(tags)) {
    const facet = facetOf(tag);
    const group = byFacet.get(facet);
    if (group === undefined) byFacet.set(facet, [tag]);
    else group.push(tag);
  }
  return [...byFacet.values()];
};
