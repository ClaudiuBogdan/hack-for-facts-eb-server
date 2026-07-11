import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { planAnnotate } from '@/modules/user-data/core/planners/plan-annotate.js';
import { createActorContext } from '@/modules/user-data/core/schemas.js';

import { identity, makeCurrent, makeDefinition, receipt, resolveDefinition } from './fixtures.js';
import { makeSequentialIds } from '../../support/ids.js';
import { expectErr, expectOk } from '../../support/result.js';

const command = {
  identity,
  expectedRevision: 3,
  namespace: 'review',
  annotation: { status: 'approved' },
  clientOccurredAt: null,
  receipt,
};
const ctx = (
  actor:
    | { type: 'owner' }
    | { type: 'system'; source: string }
    | { type: 'admin'; actorId: string; reason: string }
) => ({ ids: makeSequentialIds(), requesterId: 'requester', actor });

describe('planAnnotate', () => {
  it.each([
    { type: 'system' as const, source: 'worker' },
    { type: 'admin' as const, actorId: 'admin-1', reason: 'reviewed' },
  ])('accepts an allowed $type actor and preserves payload verbatim', (actor) => {
    const current = makeCurrent();
    const plan = expectOk(planAnnotate(resolveDefinition(), current, command, ctx(actor)));
    expect(plan.afterImage.payload).toBe(current.payload);
    expect(plan.nextRevision).toBe(4);
    expect(plan.actor).toEqual(actor);
  });

  it.each([
    [{ type: 'owner' as const }, 'ActorNotAllowed'],
    [{ type: 'admin' as const, actorId: 'a', reason: 'r' }, 'ActorNotAllowed'],
  ])('rejects a forbidden actor', (actor, type) => {
    const entry = resolveDefinition(makeDefinition({ allowedActorTypes: ['system'] }));
    expect(expectErr(planAnnotate(entry, makeCurrent(), command, ctx(actor))).type).toBe(type);
  });

  it('rejects an unknown namespace', () => {
    expect(
      expectErr(
        planAnnotate(
          resolveDefinition(),
          makeCurrent(),
          { ...command, namespace: 'missing' },
          ctx({ type: 'system', source: 'worker' })
        )
      ).type
    ).toBe('UnknownAnnotationNamespace');
  });

  it('requires admin identity and reason at the ActorContext validation boundary', () => {
    expect(
      expectErr(createActorContext({ type: 'admin', actorId: 'admin-1', reason: '' })).type
    ).toBe('InvalidPayload');
  });

  it.each([
    [
      'schema',
      makeDefinition({ annotationSchema: Type.Object({ status: Type.Literal('approved') }) }),
      { status: 'wrong' },
      'InvalidPayload',
    ],
    [
      'bytes',
      makeDefinition({ annotationMaxBytes: 10 }),
      { status: 'approved' },
      'PayloadTooLarge',
    ],
  ])('validates annotation %s', (_label, definition, annotation, type) => {
    expect(
      expectErr(
        planAnnotate(
          resolveDefinition(definition),
          makeCurrent(),
          { ...command, annotation },
          ctx({ type: 'system', source: 'worker' })
        )
      ).type
    ).toBe(type);
  });
});
