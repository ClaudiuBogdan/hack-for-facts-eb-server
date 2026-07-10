import type { DeliveryState } from './types.js';

const TRANSITIONS: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
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
  permanent_failed: [],
  dead_letter: ['ready'],
  unknown: ['ready'],
};

export const canTransition = (from: DeliveryState, to: DeliveryState): boolean => {
  return TRANSITIONS[from].includes(to);
};
