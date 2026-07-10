import { describe, expect, it } from 'vitest';

import { searchDeadLetters } from '@/modules/notification-platform/core/admin/usecases/search-dead-letters.js';

import { makeUsecaseHarness } from './harness.js';
import { makeDelivery } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('searchDeadLetters', () => {
  it('returns only dead-letter scope with content and destination redacted', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.seed([
      makeDelivery(h, { id: 'dead-1', status: 'dead_letter' }),
      makeDelivery(h, { id: 'ready-1', status: 'ready' }),
    ]);
    const page = expectOk(await searchDeadLetters(h, {}));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty('renderedSubject');
    expect(page.items[0]).not.toHaveProperty('destinationFingerprint');
    expect(page.items[0]).not.toHaveProperty('lastErrorMessage');
  });
});
