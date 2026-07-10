import { expect, it } from 'vitest';

import { planDelete } from '@/modules/user-data/core/planners/plan-delete.js';

import { identity, makeCurrent, receipt, resolveDefinition } from './fixtures.js';
import { makeSequentialIds } from '../../support/ids.js';
import { expectErr, expectOk } from '../../support/result.js';

const ctx = {
  ids: makeSequentialIds(),
  requesterId: identity.ownerId,
  actor: { type: 'owner' as const },
};
const cmd = { identity, expectedRevision: 3, clientOccurredAt: null, receipt };

it('deletes to a complete tombstone', () => {
  const plan = expectOk(planDelete(resolveDefinition(), makeCurrent(), cmd, ctx));
  expect(plan.afterImage).toMatchObject({ status: 'deleted', payload: null, annotations: null });
  expect(plan.nextRevision).toBe(4);
});

it('rejects deletion of a tombstone', () => {
  const error = expectErr(
    planDelete(
      resolveDefinition(),
      makeCurrent({ status: 'deleted', payload: null, annotations: null, deletedAt: new Date() }),
      cmd,
      ctx
    )
  );
  expect(error.type).toBe('RecordDeleted');
});
