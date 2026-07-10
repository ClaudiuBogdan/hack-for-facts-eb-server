import { describe, expect, it } from 'vitest';

import { makeInMemoryQuotaStore } from '@/modules/agent/shell/quota/quota-store.js';

describe('Agent quota reservations', () => {
  it('allows only one in-flight reservation and reconciles it to actual usage', async () => {
    const store = makeInMemoryQuotaStore();
    const userId = 'quota-user';
    await store.recordUsage(userId, 100);

    const first = await store.reserveRemaining(userId, 1_000);
    expect(first.isOk() && first.value).toBe(900);

    const concurrent = await store.reserveRemaining(userId, 1_000);
    expect(concurrent.isOk() && concurrent.value).toBeNull();

    await store.reconcileReservation(userId, 900, 50);
    // A retry after an ambiguous Redis/network response must be idempotent.
    await store.reconcileReservation(userId, 900, 0);
    const used = await store.usedToday(userId);
    expect(used.isOk() && used.value).toBe(150);
  });

  it('releases a reservation when provider work never starts', async () => {
    const store = makeInMemoryQuotaStore();
    const userId = 'quota-release-user';

    const reservation = await store.reserveRemaining(userId, 1_000);
    expect(reservation.isOk() && reservation.value).toBe(1_000);
    await store.reconcileReservation(userId, 1_000, 0);

    const used = await store.usedToday(userId);
    expect(used.isOk() && used.value).toBe(0);
  });
});
