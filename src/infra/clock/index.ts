import type { Clock } from '@/common/ports/clock.js';

/** Production Clock adapter. Composed into core deps by the shell. */
export const systemClock: Clock = {
  now: () => new Date(),
};
