import { describe, expect, it } from 'vitest';

import { planCreateOrReplace } from '@/modules/user-data/core/planners/plan-create-or-replace.js';

import { identity, makeCurrent, makeDefinition, receipt, resolveDefinition } from './fixtures.js';
import { makeSequentialIds } from '../../support/ids.js';
import { expectErr, expectOk } from '../../support/result.js';

const command = (expectedRevision: number) => ({
  identity,
  expectedRevision,
  schemaVersion: 1,
  payload: { value: 'new' },
  target: { targetType: 'entity', targetId: '123' },
  clientOccurredAt: null,
  receipt,
});
const context = () => ({
  ids: makeSequentialIds('generated'),
  requesterId: identity.ownerId,
  actor: { type: 'owner' as const },
});

describe('planCreateOrReplace', () => {
  it('creates at expected revision zero with generated record and event ids', () => {
    const plan = expectOk(planCreateOrReplace(resolveDefinition(), null, command(0), context()));
    expect(plan).toMatchObject({
      operation: 'create',
      expectedRevision: 0,
      nextRevision: 1,
      recordId: 'generated-1',
      eventId: 'generated-2',
      quota: { maxRecordsInCategory: 10 },
    });
  });

  it('replaces at revision N and preserves annotations verbatim', () => {
    const current = makeCurrent();
    const plan = expectOk(planCreateOrReplace(resolveDefinition(), current, command(3), context()));
    expect(plan.nextRevision).toBe(4);
    expect(plan.afterImage.annotations).toBe(current.annotations);
    expect(plan.afterImage.payload).toEqual({ value: 'new' });
  });

  it.each([
    ['missing record at nonzero revision', null, command(2), 'NotFound'],
    ['existing record at create revision', makeCurrent(), command(0), 'RevisionConflict'],
    [
      'changed target',
      makeCurrent(),
      { ...command(3), target: { targetType: 'entity', targetId: '999' } },
      'InvalidTarget',
    ],
  ])('rejects %s', (_label, current, cmd, type) => {
    expect(expectErr(planCreateOrReplace(resolveDefinition(), current, cmd, context())).type).toBe(
      type
    );
  });

  it('rejects a write-disabled schema version', () => {
    const entry = resolveDefinition(makeDefinition({ writeEnabled: false }));
    expect(expectErr(planCreateOrReplace(entry, null, command(0), context())).type).toBe(
      'SchemaVersionWriteDisabled'
    );
  });
});
