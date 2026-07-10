import { describe, expect, it } from 'vitest';

import {
  decodeSyncCursor,
  encodeSyncCursor,
  validateSyncCursorCategory,
} from '@/modules/user-data/core/sync-cursor.js';

import { expectErr, expectOk } from '../../support/result.js';

describe('sync cursor', () => {
  it('round-trips all filter binding data without numeric conversion', () => {
    const cursor = {
      lastSeq: '90071992547409931234',
      cycleHighWater: '90071992547409939999',
      category: 'funky.interaction',
    };
    expect(expectOk(decodeSyncCursor(encodeSyncCursor(cursor)))).toEqual(cursor);
  });

  it.each([
    ['malformed base64', '%%%'],
    ['bad JSON', Buffer.from('not-json').toString('base64url')],
    ['non-decimal', encodeSyncCursor({ lastSeq: '1.5', cycleHighWater: null, category: null })],
    ['negative', encodeSyncCursor({ lastSeq: '-1', cycleHighWater: null, category: null })],
    ['wrong shape', Buffer.from(JSON.stringify({ lastSeq: '1' })).toString('base64url')],
  ])('rejects %s', (_label, raw) => {
    expect(expectErr(decodeSyncCursor(raw)).type).toBe('InvalidCursor');
  });

  it('detects category-filter mismatch', () => {
    const cursor = { lastSeq: '1', cycleHighWater: '10', category: 'funky.interaction' };
    expect(expectErr(validateSyncCursorCategory(cursor, 'learning.progress')).type).toBe(
      'InvalidCursor'
    );
  });
});
