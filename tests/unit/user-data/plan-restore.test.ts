import { expect, it } from 'vitest';

import { planRestore } from '@/modules/user-data/core/planners/plan-restore.js';

import { identity, makeCurrent, receipt, resolveDefinition } from './fixtures.js';
import { makeSequentialIds } from '../../support/ids.js';
import { expectErr, expectOk } from '../../support/result.js';

const ctx = {
  ids: makeSequentialIds(),
  requesterId: identity.ownerId,
  actor: { type: 'owner' as const },
};
const cmd = {
  identity,
  expectedRevision: 3,
  schemaVersion: 1,
  payload: { value: 'restored' },
  target: { targetType: 'entity', targetId: '123' },
  clientOccurredAt: null,
  receipt,
};

it('restores a tombstone from a complete payload without resurrecting annotations', () => {
  const current = makeCurrent({
    status: 'deleted',
    payload: null,
    annotations: null,
    deletedAt: new Date(),
  });
  const plan = expectOk(planRestore(resolveDefinition(), current, cmd, ctx));
  expect(plan.afterImage).toMatchObject({
    status: 'active',
    payload: { value: 'restored' },
    annotations: null,
  });
  expect(plan.nextRevision).toBe(4);
});

it('rejects restore on an active record', () => {
  expect(expectErr(planRestore(resolveDefinition(), makeCurrent(), cmd, ctx)).type).toBe(
    'RecordNotDeleted'
  );
});

it('requires the tombstone revision', () => {
  const current = makeCurrent({
    status: 'deleted',
    payload: null,
    annotations: null,
    deletedAt: new Date(),
  });
  expect(
    expectErr(planRestore(resolveDefinition(), current, { ...cmd, expectedRevision: 2 }, ctx)).type
  ).toBe('RevisionConflict');
});
