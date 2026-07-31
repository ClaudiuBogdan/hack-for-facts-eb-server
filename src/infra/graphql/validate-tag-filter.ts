/**
 * GraphQL-boundary validation for the faceted tags filter.
 *
 * Malformed tags must surface as a user-input error, not vanish or 500: the
 * repos' internal `assertValidTagFilter` throw is caught by their catch-alls
 * and becomes a retryable-looking DatabaseError, which production redaction
 * (`security.ts`) then blanks to "Internal server error". Validating here,
 * with `BAD_USER_INPUT` (in the redactor's safe-code set), keeps the message
 * intact for the caller. The repo-level assertion remains as defense in depth.
 */
import { GraphQLError } from 'graphql';

import { TAG_FILTER_PATTERN } from '@/infra/database/query-filters/index.js';

interface TagBearingFilter {
  tags?: readonly string[] | undefined;
  exclude?: { tags?: readonly string[] | undefined } | undefined;
}

export function assertValidTagFilterInput(filter: TagBearingFilter | undefined): void {
  if (filter === undefined) return;
  const candidates = [...(filter.tags ?? []), ...(filter.exclude?.tags ?? [])];
  for (const tag of candidates) {
    if (!TAG_FILTER_PATTERN.test(tag)) {
      throw new GraphQLError(
        `Invalid tags filter value '${tag}': expected lowercase namespace::value ` +
          `(e.g. 'kind::hospital' or 'kind::school::gymnasium').`,
        { extensions: { code: 'BAD_USER_INPUT', type: 'InvalidInput', field: 'tags' } }
      );
    }
  }
}
