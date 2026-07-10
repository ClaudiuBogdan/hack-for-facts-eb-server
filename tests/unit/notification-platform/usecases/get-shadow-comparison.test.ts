import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { getShadowComparison } from '@/modules/notification-platform/core/admin/usecases/get-shadow-comparison.js';

import { makeUsecaseHarness } from './harness.js';
import { makeDelivery } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('getShadowComparison', () => {
  it('computes recipient and content-hash parity', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.seed([
      makeDelivery(h, {
        id: 'shadow-1',
        userId: 'user-1',
        senderMode: 'shadow',
        contentHash: 'same',
      }),
      makeDelivery(h, {
        id: 'shadow-2',
        userId: 'shadow-only',
        senderMode: 'shadow',
        contentHash: 'shadow',
      }),
    ]);
    const summary = expectOk(
      await getShadowComparison(
        {
          ...h,
          legacyOutboxReader: {
            listComparisonRecipients: async () =>
              ok([
                { userId: 'user-1', contentHash: 'same' },
                { userId: 'legacy-only', contentHash: 'legacy' },
              ]),
          },
        },
        { kindId: h.kind.kindId }
      )
    );
    expect(summary).toEqual(
      expect.objectContaining({
        matchingRecipientCount: 1,
        legacyOnlyRecipientCount: 1,
        shadowOnlyRecipientCount: 1,
        matchingContentCount: 1,
      })
    );
  });
});
