import { describe, expect, it } from 'vitest';

import { hashEventPayload } from '@/modules/notification-platform/core/events/hash-event-payload.js';

import { expectErr, expectOk } from '../../support/index.js';

const hash = (facts: Record<string, unknown>): string => expectOk(hashEventPayload(facts));

describe('hashEventPayload', () => {
  it('is independent of object key order', () => {
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
  });

  it('canonicalizes nested object keys', () => {
    const first = { outer: { alpha: 1, beta: { x: true, y: null } } };
    const second = { outer: { beta: { y: null, x: true }, alpha: 1 } };
    expect(hash(first)).toBe(hash(second));
  });

  it('keeps array order significant', () => {
    expect(hash({ values: [1, 2, 3] })).not.toBe(hash({ values: [3, 2, 1] }));
  });

  it('is stable across calls for identical facts', () => {
    expect(hash({ b: 2, a: 1 })).toBe(hash({ a: 1, b: 2 }));
    expect(hash({ b: 2, a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects undefined property values instead of collapsing them', () => {
    const error = expectErr(hashEventPayload({ a: undefined }));
    expect(error.type).toBe('ValidationError');
    expect(expectOk(hashEventPayload({}))).not.toBe(hashEventPayload({ a: undefined }));
  });

  it('rejects undefined inside arrays instead of coercing to null', () => {
    expect(hashEventPayload({ values: [undefined] }).isErr()).toBe(true);
    expect(hashEventPayload({ values: [null] }).isOk()).toBe(true);
  });

  it('rejects bigint, non-finite numbers, and non-plain objects', () => {
    expect(hashEventPayload({ a: 1n }).isErr()).toBe(true);
    expect(hashEventPayload({ a: Number.NaN }).isErr()).toBe(true);
    expect(hashEventPayload({ a: Number.POSITIVE_INFINITY }).isErr()).toBe(true);
    expect(hashEventPayload({ a: new Date() }).isErr()).toBe(true);
    expect(hashEventPayload({ a: new Map() }).isErr()).toBe(true);
  });

  it('rejects cyclic structures instead of throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const error = expectErr(hashEventPayload(cyclic));
    expect(error.message).toContain('Cyclic');
  });
});
