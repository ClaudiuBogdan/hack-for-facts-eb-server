/**
 * The MCP core mirrors the infra tag pattern because core must stay pure (no
 * infra imports) — this test is what makes that duplication safe: if the two
 * patterns ever diverge, MCP would accept tags GraphQL rejects (or vice
 * versa), and the divergence would be invisible at runtime.
 */
import { describe, expect, it } from 'vitest';

import { TAG_FILTER_PATTERN } from '@/infra/database/query-filters/index.js';
import {
  MCP_TAG_FILTER_PATTERN,
  findInvalidTagFilterValue,
  invalidTagFilterMessage,
} from '@/modules/mcp/core/tag-filter-validation.js';

describe('MCP tag filter validation', () => {
  it('mirrors the infra pattern exactly', () => {
    expect(MCP_TAG_FILTER_PATTERN.source).toBe(TAG_FILTER_PATTERN.source);
    expect(MCP_TAG_FILTER_PATTERN.flags).toBe(TAG_FILTER_PATTERN.flags);
  });

  it('finds the first malformed value in tags and exclude.tags', () => {
    expect(findInvalidTagFilterValue(undefined)).toBeUndefined();
    expect(findInvalidTagFilterValue({})).toBeUndefined();
    expect(findInvalidTagFilterValue({ tags: ['kind::hospital'] })).toBeUndefined();
    expect(
      findInvalidTagFilterValue({ tags: ['kind::hospital'], exclude: { tags: ['level::local'] } })
    ).toBeUndefined();

    expect(findInvalidTagFilterValue({ tags: ['Kind::Hospital'] })).toBe('Kind::Hospital');
    expect(findInvalidTagFilterValue({ exclude: { tags: ['BAD TAG'] } })).toBe('BAD TAG');
    // Non-string members must be reported, not coerced into a filter.
    expect(findInvalidTagFilterValue({ tags: [42 as unknown as string] })).toBe('42');
  });

  it('names the offending tag in the message', () => {
    expect(invalidTagFilterMessage('BAD')).toContain("'BAD'");
    expect(invalidTagFilterMessage('BAD')).toContain('namespace::value');
  });
});
