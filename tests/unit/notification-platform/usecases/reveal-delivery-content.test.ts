import { describe, expect, it } from 'vitest';

import { revealDeliveryContent } from '@/modules/notification-platform/core/admin/usecases/reveal-delivery-content.js';

import { makeUsecaseHarness } from './harness.js';
import { makeDelivery } from '../../../fixtures/notification-platform/index.js';
import { expectErr, expectOk } from '../../../support/index.js';

describe('revealDeliveryContent', () => {
  it('requires a reason and audits rendered-content reveal', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(makeDelivery(h, { id: 'delivery-1' }));
    const base = { deliveryId: 'delivery-1', adminUserId: 'admin-1' };
    expect(expectErr(await revealDeliveryContent(h, { ...base, reason: ' ' })).type).toBe(
      'ValidationError'
    );
    const revealed = expectOk(
      await revealDeliveryContent(h, { ...base, reason: 'support investigation' })
    );
    expect(revealed.html).toBe('<p>Body</p>');
    expect(h.audit.store.list()[0]?.action).toBe('admin.content_revealed');
  });
});
