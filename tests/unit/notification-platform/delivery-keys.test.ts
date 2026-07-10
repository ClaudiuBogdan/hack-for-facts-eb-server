import { describe, expect, it } from 'vitest';

import {
  buildDigestDeliveryKey,
  buildImmediateDeliveryKey,
} from '@/modules/notification-platform/core/delivery/delivery-keys.js';

describe('delivery keys', () => {
  it('builds the exact immediate delivery identity', () => {
    expect(buildImmediateDeliveryKey('logical-123', 'email', 7)).toBe(
      'logical:logical-123:email:7'
    );
  });

  it('builds the exact digest delivery identity', () => {
    expect(buildDigestDeliveryKey('batch-456')).toBe('digest:batch-456');
  });
});
