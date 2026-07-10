import { describe, expect, it } from 'vitest';

import { listSuppressions } from '@/modules/notification-platform/core/admin/usecases/list-suppressions.js';

import { makeUsecaseHarness } from './harness.js';
import { makeChannelDestination } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('listSuppressions', () => {
  it('returns fingerprint-only suppression views', async () => {
    const h = makeUsecaseHarness();
    h.destinations.store.put(
      makeChannelDestination(h, {
        suppressedAt: h.clock.now(),
        suppressionReason: 'bounced',
      })
    );
    const page = expectOk(await listSuppressions(h, { userId: 'user-1' }));
    expect(page.items).toEqual([
      expect.objectContaining({ fingerprint: 'fingerprint-1', suppressionReason: 'bounced' }),
    ]);
    expect(page.items[0]).not.toHaveProperty('address');
  });
});
