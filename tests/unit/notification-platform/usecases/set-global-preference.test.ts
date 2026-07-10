import { describe, expect, it } from 'vitest';

import { setGlobalPreference } from '@/modules/notification-platform/core/preferences/usecases/set-global-preference.js';
import { makeKindRegistry } from '@/modules/notification-platform/core/registry/registry.js';

import { makeUsecaseHarness } from './harness.js';
import { makeDelivery, makeTestKind } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('setGlobalPreference', () => {
  it('cancels pending optional external work when globally disabled', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(makeDelivery(h, { id: 'delivery-1' }));
    const preferences = expectOk(
      await setGlobalPreference(h, { userId: 'user-1', enabled: false })
    );
    expect(preferences.globalOptionalEnabled).toBe(false);
    expect(h.deliveries.store.get('delivery-1')?.status).toBe('cancelled');
  });

  it('preserves pending required-kind work when globally disabled', async () => {
    const h = makeUsecaseHarness();
    const requiredKind = makeTestKind({
      kindId: 'required.kind',
      eventType: 'required.event',
      preferenceClass: 'required',
    });
    const registry = expectOk(makeKindRegistry([h.kind, requiredKind]));
    h.deliveries.store.seed([
      makeDelivery(h, { id: 'optional-delivery', kindId: h.kind.kindId }),
      makeDelivery(h, { id: 'required-delivery', kindId: requiredKind.kindId }),
    ]);

    expectOk(await setGlobalPreference({ ...h, registry }, { userId: 'user-1', enabled: false }));
    expect(h.deliveries.store.get('optional-delivery')?.status).toBe('cancelled');
    expect(h.deliveries.store.get('required-delivery')?.status).toBe('ready');
  });
});
