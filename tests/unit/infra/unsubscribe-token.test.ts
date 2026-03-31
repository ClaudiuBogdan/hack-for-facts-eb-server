import { describe, expect, it } from 'vitest';

import { makeUnsubscribeTokenSigner } from '@/infra/unsubscribe/token.js';

const SECRET = 'test-secret-for-unit-tests-minimum-32!';

describe('UnsubscribeTokenSigner', () => {
  const signer = makeUnsubscribeTokenSigner(SECRET);

  it('round-trips sign and verify', () => {
    const userId = 'user_abc123';
    const token = signer.sign(userId);
    const result = signer.verify(token);

    expect(result).toEqual({ userId });
  });

  it('produces a base64url string', () => {
    const token = signer.sign('user_abc123');
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is deterministic (same input produces same token)', () => {
    const a = signer.sign('user_abc123');
    const b = signer.sign('user_abc123');
    expect(a).toBe(b);
  });

  it('returns null for a tampered token (modified userId)', () => {
    const token = signer.sign('user_abc123');
    // Decode, tamper, re-encode
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const tampered = decoded.replace('user_abc123', 'user_evil');
    const reEncoded = Buffer.from(tampered).toString('base64url');

    expect(signer.verify(reEncoded)).toBeNull();
  });

  it('returns null for a tampered token (modified signature)', () => {
    const token = signer.sign('user_abc123');
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const dotIndex = decoded.lastIndexOf('.');
    const tampered = decoded.slice(0, dotIndex + 1) + 'deadbeef'.repeat(8);
    const reEncoded = Buffer.from(tampered).toString('base64url');

    expect(signer.verify(reEncoded)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(signer.verify('')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(signer.verify('not-a-valid-token')).toBeNull();
  });

  it('returns null for token signed with a different secret', () => {
    const otherSigner = makeUnsubscribeTokenSigner('different-secret-also-32-chars-long!');
    const token = otherSigner.sign('user_abc123');
    expect(signer.verify(token)).toBeNull();
  });

  it('handles user IDs with special characters', () => {
    const userId = 'user_3BdMoiq4SasffFck28PoRqHLrnK';
    const token = signer.sign(userId);
    expect(signer.verify(token)).toEqual({ userId });
  });
});
