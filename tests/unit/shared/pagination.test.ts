/**
 * Kernel pagination: cursor encode/decode + fhash binding, offset guards.
 */

import { describe, expect, it } from 'vitest';

import {
  buildNextCursor,
  CURSOR_VERSION,
  decodeCursor,
  encodeCursor,
  MAX_PAGE_SIZE,
  normalizeOffset,
  offsetFor,
} from '@/modules/shared/core/pagination.js';

describe('cursor envelope', () => {
  const expected = { sort: 'flow_date', dir: 'desc' as const, fhash: 'abc123' };

  it('round-trips an envelope', () => {
    const cursor = encodeCursor({
      v: CURSOR_VERSION,
      sort: 'flow_date',
      dir: 'desc',
      fhash: 'abc123',
      keys: ['2024-01-01', '42'],
    });
    const decoded = decodeCursor(cursor, expected);
    expect(decoded.isOk()).toBe(true);
    expect(decoded._unsafeUnwrap().keys).toEqual(['2024-01-01', '42']);
  });

  it('rejects an fhash mismatch (filters changed mid-pagination)', () => {
    const cursor = buildNextCursor({ sort: 'flow_date', dir: 'desc', fhash: 'OLD', lastKeys: ['2024-01-01', 42] });
    const decoded = decodeCursor(cursor, expected);
    expect(decoded.isErr()).toBe(true);
    expect(decoded._unsafeUnwrapErr().message).toContain('mismatch');
  });

  it('rejects a sort/dir mismatch', () => {
    const cursor = buildNextCursor({ sort: 'amount', dir: 'asc', fhash: 'abc123', lastKeys: ['1'] });
    expect(decodeCursor(cursor, expected).isErr()).toBe(true);
  });

  it('rejects malformed base64 / json', () => {
    expect(decodeCursor('!!!notbase64!!!', expected).isErr()).toBe(true);
    expect(decodeCursor('eyJub3QiOiJjdXJzb3IifQ', expected).isErr()).toBe(true);
  });

  it('rejects a stale envelope version', () => {
    const cursor = encodeCursor({
      v: 999,
      sort: 'flow_date',
      dir: 'desc',
      fhash: 'abc123',
      keys: ['x'],
    });
    expect(decodeCursor(cursor, expected).isErr()).toBe(true);
  });

  it('encodes null keys as empty strings', () => {
    const cursor = buildNextCursor({ sort: 'flow_date', dir: 'desc', fhash: 'abc123', lastKeys: [null, 7] });
    const decoded = decodeCursor(cursor, expected);
    expect(decoded._unsafeUnwrap().keys).toEqual(['', '7']);
  });
});

describe('offset pagination', () => {
  it('defaults page=1 pageSize=20', () => {
    expect(normalizeOffset(undefined, undefined)).toEqual({ page: 1, pageSize: 20 });
  });

  it('clamps pageSize to the max', () => {
    expect(normalizeOffset(1, 9999).pageSize).toBe(MAX_PAGE_SIZE);
  });

  it('rejects sub-1 values back to defaults', () => {
    expect(normalizeOffset(0, 0)).toEqual({ page: 1, pageSize: 20 });
  });

  it('computes the offset', () => {
    expect(offsetFor({ page: 3, pageSize: 25 })).toBe(50);
  });
});
