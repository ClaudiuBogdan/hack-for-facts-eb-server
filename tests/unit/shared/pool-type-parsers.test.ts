/**
 * Per-pool type-parser selection (no live DB). The prod pool returns int8 + the
 * date/timestamp OID family as raw STRINGS (so repos no longer need `::text`),
 * while every other OID keeps the node-pg default. This asserts the OID set the
 * pool overrides — the live format-match invariant is covered by the integration
 * test `tests/integration/shared/pool-type-parsers.test.ts`.
 */

import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { PROD_STRING_PARSED_OIDS, prodReturnsStringFor } from '@/modules/shared/shell/db/pool.js';

const { builtins } = pg.types;

describe('prod pool string-typed OIDs', () => {
  it('returns strings for int8 + date + timestamp + timestamptz (text format)', () => {
    for (const oid of [builtins.INT8, builtins.DATE, builtins.TIMESTAMP, builtins.TIMESTAMPTZ]) {
      expect(prodReturnsStringFor(oid)).toBe(true);
    }
    expect([...PROD_STRING_PARSED_OIDS].sort((a, b) => a - b)).toEqual(
      [builtins.INT8, builtins.DATE, builtins.TIMESTAMP, builtins.TIMESTAMPTZ].sort((a, b) => a - b)
    );
  });

  it('does NOT override unrelated OIDs (numeric, text, bool, int4)', () => {
    for (const oid of [builtins.NUMERIC, builtins.TEXT, builtins.BOOL, builtins.INT4]) {
      expect(prodReturnsStringFor(oid)).toBe(false);
    }
  });

  it('only overrides the text wire format (binary is left to the default)', () => {
    expect(prodReturnsStringFor(builtins.DATE, 'text')).toBe(true);
    expect(prodReturnsStringFor(builtins.DATE, 'binary')).toBe(false);
  });
});
