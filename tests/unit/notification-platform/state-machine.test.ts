import { describe, expect, it } from 'vitest';

import { canTransition } from '@/modules/notification-platform/core/delivery/state-machine.js';
import {
  DELIVERY_STATES,
  TERMINAL_DELIVERY_STATES,
  type DeliveryState,
} from '@/modules/notification-platform/core/delivery/types.js';

const EXPECTED_TRANSITIONS: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
  pending_render: ['scheduled', 'ready', 'cancelled', 'suppressed', 'expired'],
  scheduled: ['ready', 'cancelled', 'suppressed', 'expired'],
  ready: ['sending', 'cancelled', 'suppressed', 'expired'],
  sending: [
    'accepted',
    'retry_wait',
    'permanent_failed',
    'cancelled',
    'suppressed',
    'expired',
    'unknown',
    'dead_letter',
  ],
  retry_wait: ['ready', 'sending', 'cancelled', 'suppressed', 'expired', 'dead_letter'],
  accepted: ['delivered', 'bounced', 'complained'],
  delivered: [],
  bounced: [],
  complained: [],
  suppressed: [],
  cancelled: [],
  expired: [],
  permanent_failed: ['ready'],
  dead_letter: ['ready'],
  unknown: ['ready'],
};

describe('canTransition', () => {
  it('matches the complete 15 by 15 transition matrix', () => {
    for (const from of DELIVERY_STATES) {
      for (const to of DELIVERY_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(
          EXPECTED_TRANSITIONS[from].includes(to)
        );
      }
    }
  });

  it.each([
    ['pending_render', 'ready'],
    ['scheduled', 'ready'],
    ['ready', 'sending'],
    ['sending', 'accepted'],
    ['sending', 'retry_wait'],
    ['retry_wait', 'sending'],
    ['accepted', 'delivered'],
    ['accepted', 'bounced'],
    ['accepted', 'complained'],
    ['dead_letter', 'ready'],
    ['permanent_failed', 'ready'],
    ['unknown', 'ready'],
  ] as const)('allows the happy path %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('keeps accepted non-terminal so webhooks can refine its outcome', () => {
    expect(TERMINAL_DELIVERY_STATES.includes('accepted')).toBe(false);
  });

  it('allows no terminal-state exits except audited requeue states', () => {
    for (const from of TERMINAL_DELIVERY_STATES) {
      const expectedTargets =
        from === 'dead_letter' || from === 'unknown' || from === 'permanent_failed'
          ? ['ready']
          : [];
      for (const to of DELIVERY_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expectedTargets.includes(to));
      }
    }
  });

  it.each([
    ['delivered', 'ready'],
    ['bounced', 'sending'],
    ['complained', 'accepted'],
    ['permanent_failed', 'retry_wait'],
    ['accepted', 'sending'],
    ['ready', 'pending_render'],
  ] as const)('rejects regression %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});
