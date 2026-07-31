/**
 * Faceted-tag filter validation for MCP use cases.
 *
 * Core must stay pure (no infra imports) and must not throw, so this is a
 * deliberate MIRROR of `TAG_FILTER_PATTERN` in
 * `src/infra/database/query-filters/entity-filter.ts`, returning the offending
 * tag for the caller to wrap in `err(invalidInputError(...))`. A unit test
 * pins the two patterns as identical so they cannot drift.
 *
 * A malformed tag must be rejected loudly, never dropped: a filter that
 * silently becomes a no-op WIDENS the result set.
 */
export const MCP_TAG_FILTER_PATTERN = /^[a-z_]+(::[a-z_]+){1,2}$/;

/**
 * Scans `tags` and `exclude.tags` on an MCP filter object and returns the
 * first malformed value, or undefined when everything is well-formed.
 */
export function findInvalidTagFilterValue(
  filter: Record<string, unknown> | undefined
): string | undefined {
  if (filter === undefined) return undefined;
  const candidates: unknown[] = [];
  if (Array.isArray(filter['tags'])) candidates.push(...(filter['tags'] as unknown[]));
  const exclude = filter['exclude'];
  if (typeof exclude === 'object' && exclude !== null) {
    const excludeTags = (exclude as Record<string, unknown>)['tags'];
    if (Array.isArray(excludeTags)) candidates.push(...(excludeTags as unknown[]));
  }
  for (const tag of candidates) {
    if (typeof tag !== 'string' || !MCP_TAG_FILTER_PATTERN.test(tag)) {
      return String(tag);
    }
  }
  return undefined;
}

export function invalidTagFilterMessage(tag: string): string {
  return (
    `Invalid tags filter value '${tag}': expected lowercase namespace::value ` +
    `(e.g. 'kind::hospital' or 'kind::school::gymnasium').`
  );
}
