import { describe, expect, it } from 'vitest';

import { buildNormalizedSubscriptionKey } from '@/modules/notification-platform/core/subscriptions/normalized-key.js';

import { expectErr, expectOk } from '../../support/index.js';

const buildKey = (
  kindId: string,
  subjectType: string,
  subjectId: string,
  config: Record<string, unknown>
): string => expectOk(buildNormalizedSubscriptionKey(kindId, subjectType, subjectId, config));

describe('buildNormalizedSubscriptionKey', () => {
  it('is independent of nested config key order', () => {
    const first = buildKey('kind', 'entity', '123', {
      threshold: { currency: 'RON', amount: '100' },
      labels: ['a', 'b'],
    });
    const second = buildKey('kind', 'entity', '123', {
      labels: ['a', 'b'],
      threshold: { amount: '100', currency: 'RON' },
    });

    expect(first).toBe(second);
  });

  it.each([
    ['other-kind', 'entity', '123', {}],
    ['kind', 'other-entity', '123', {}],
    ['kind', 'entity', '456', {}],
    ['kind', 'entity', '123', { enabled: true }],
  ] as const)(
    'distinguishes a changed normalized input',
    (kindId, subjectType, subjectId, config) => {
      const baseline = buildKey('kind', 'entity', '123', {});
      expect(buildKey(kindId, subjectType, subjectId, config)).not.toBe(baseline);
    }
  );

  it('rejects non-JSON-representable config values instead of collapsing them', () => {
    const error = expectErr(
      buildNormalizedSubscriptionKey('kind', 'entity', '123', { threshold: undefined })
    );
    expect(error.type).toBe('ValidationError');
    expect(
      buildNormalizedSubscriptionKey('kind', 'entity', '123', { at: new Date() }).isErr()
    ).toBe(true);
  });
});
