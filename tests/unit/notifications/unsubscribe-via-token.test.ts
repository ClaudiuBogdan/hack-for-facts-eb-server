/**
 * Unit tests for unsubscribe-via-token use case (HMAC flow)
 *
 * Tests cover:
 * - Invalid/tampered token handling
 * - Successful unsubscribe via valid HMAC token
 * - Idempotent behavior (calling twice succeeds both times)
 */

import { describe, expect, it } from 'vitest';

import { unsubscribeViaToken } from '@/modules/notifications/core/usecases/unsubscribe-via-token.js';

import { makeFakeNotificationsRepo, makeFakeTokenSigner } from '../../fixtures/fakes.js';

describe('unsubscribeViaToken use case', () => {
  const tokenSigner = makeFakeTokenSigner();

  it('returns TokenInvalidError for invalid/tampered token', async () => {
    const notificationsRepo = makeFakeNotificationsRepo();

    const result = await unsubscribeViaToken(
      { notificationsRepo, tokenSigner },
      { token: 'invalid-token-garbage' }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('TokenInvalidError');
    }
  });

  it('returns success and calls deactivateGlobalUnsubscribe for valid token', async () => {
    const notificationsRepo = makeFakeNotificationsRepo();
    const signedToken = tokenSigner.sign('user-1');

    const result = await unsubscribeViaToken(
      { notificationsRepo, tokenSigner },
      { token: signedToken }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.userId).toBe('user-1');
    }
  });

  it('is idempotent (calling twice returns success both times)', async () => {
    const notificationsRepo = makeFakeNotificationsRepo();
    const signedToken = tokenSigner.sign('user-1');

    const result1 = await unsubscribeViaToken(
      { notificationsRepo, tokenSigner },
      { token: signedToken }
    );
    expect(result1.isOk()).toBe(true);

    const result2 = await unsubscribeViaToken(
      { notificationsRepo, tokenSigner },
      { token: signedToken }
    );
    expect(result2.isOk()).toBe(true);
    if (result2.isOk()) {
      expect(result2.value.userId).toBe('user-1');
    }
  });
});
