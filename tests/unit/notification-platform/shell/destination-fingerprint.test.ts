import { describe, expect, it } from 'vitest';

import { computeDestinationFingerprint } from '@/modules/notification-platform/shell/channel/destination-fingerprint.js';

describe('computeDestinationFingerprint', () => {
  it('is deterministic and normalizes casing and surrounding whitespace', () => {
    const expected = computeDestinationFingerprint('secret-a', 'User@Example.COM');

    expect(computeDestinationFingerprint('secret-a', '  user@example.com  ')).toBe(expected);
    expect(computeDestinationFingerprint('secret-a', 'User@Example.COM')).toBe(expected);
  });

  it('changes when the HMAC secret changes', () => {
    expect(computeDestinationFingerprint('secret-a', 'user@example.com')).not.toBe(
      computeDestinationFingerprint('secret-b', 'user@example.com')
    );
  });
});
