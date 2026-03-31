import { describe, expect, it } from 'vitest';

import { createDatabaseError } from '@/modules/notification-delivery/core/errors.js';
import { toDeliveryError } from '@/modules/notification-delivery/shell/data/budget-data-fetcher.js';

describe('toDeliveryError', () => {
  it('returns known delivery errors unchanged', () => {
    const error = createDatabaseError('db failed');

    expect(toDeliveryError('fallback', error)).toBe(error);
  });

  it('falls back for foreign typed objects', () => {
    const error = {
      type: 'SomeOtherError',
      message: 'foreign',
    };

    expect(toDeliveryError('fallback', error)).toEqual(createDatabaseError('fallback'));
  });

  it('falls back for plain Error instances', () => {
    expect(toDeliveryError('fallback', new Error('boom'))).toEqual(createDatabaseError('fallback'));
  });
});
