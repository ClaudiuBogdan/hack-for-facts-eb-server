import { describe, expect, it } from 'vitest';

import { createSubscription } from '@/modules/notification-platform/core/subscriptions/usecases/create-subscription.js';

import { makeUsecaseHarness } from './harness.js';
import { makeFakeSubjectAuthorizationPort } from '../../../fixtures/notification-platform/index.js';
import { expectErr, expectOk } from '../../../support/index.js';

describe('createSubscription', () => {
  it('validates, authorizes, and reactivates the normalized identity', async () => {
    const h = makeUsecaseHarness();
    const authorizer = makeFakeSubjectAuthorizationPort();
    const deps = { ...h, subjectAuthorizers: new Map([[h.kind.kindId, authorizer]]) };
    const input = {
      userId: 'user-1',
      kindId: h.kind.kindId,
      subjectType: 'test-subject',
      subjectId: 'subject-1',
      config: {},
    };
    const created = expectOk(await createSubscription(deps, input));
    expect(created.state).toBe('active');
    expect(expectOk(await createSubscription(deps, input)).id).toBe(created.id);
    expect(h.subscriptions.store.size()).toBe(1);
    expect(
      expectErr(await createSubscription({ ...h, subjectAuthorizers: new Map() }, input)).type
    ).toBe('Forbidden');
  });
});
