import { describe, expect, it } from 'vitest';

import { getPreferences } from '@/modules/notification-platform/core/preferences/usecases/get-preferences.js';

import { makeUsecaseHarness } from './harness.js';
import { expectOk } from '../../../support/index.js';

describe('getPreferences', () => {
  it('materializes defaults for a user without stored overrides', async () => {
    const h = makeUsecaseHarness();
    const preferences = expectOk(await getPreferences(h, { userId: 'user-1' }));
    expect(preferences.globalOptionalEnabled).toBe(true);
    expect(preferences.channels.email).toEqual({ enabled: true, cadence: 'immediate' });
  });
});
