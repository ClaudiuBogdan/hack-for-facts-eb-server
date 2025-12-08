/**
 * Tests for the JWT authentication adapter.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  makeJWTAdapter,
  type JWTVerifyFn,
  type ImportSPKIFn,
  type JWTPayload,
} from '@/modules/auth/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

const TEST_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMIIBIjANtest\n-----END PUBLIC KEY-----';

const createMockJwtVerify = (payload: JWTPayload | Error): JWTVerifyFn => {
  return vi.fn().mockImplementation(async () => {
    if (payload instanceof Error) {
      throw payload;
    }
    return { payload };
  });
};

const createMockImportSPKI = (shouldFail = false): ImportSPKIFn => {
  return vi.fn().mockImplementation(async () => {
    if (shouldFail) {
      throw new Error('Failed to import key');
    }
    return { type: 'public' }; // Mock CryptoKey
  });
};

const validPayload: JWTPayload = {
  sub: 'user_123',
  exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
  iat: Math.floor(Date.now() / 1000),
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('makeJWTAdapter', () => {
  describe('successful verification', () => {
    it('returns session with userId from sub claim', async () => {
      const jwtVerify = createMockJwtVerify(validPayload);
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      const result = await adapter.verifyToken('valid-token');

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().userId).toBe('user_123');
    });

    it('returns session with correct expiration time', async () => {
      const exp = Math.floor(Date.now() / 1000) + 7200; // 2 hours
      const jwtVerify = createMockJwtVerify({ ...validPayload, exp });
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      const result = await adapter.verifyToken('valid-token');

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().expiresAt.getTime()).toBe(exp * 1000);
    });

    it('passes token to jwtVerify function', async () => {
      const jwtVerify = createMockJwtVerify(validPayload);
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      await adapter.verifyToken('my-secret-token');

      expect(jwtVerify).toHaveBeenCalledWith(
        'my-secret-token',
        expect.anything(),
        expect.anything()
      );
    });
  });

  describe('key caching', () => {
    it('imports key only once for multiple verifications', async () => {
      const jwtVerify = createMockJwtVerify(validPayload);
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      await adapter.verifyToken('token-1');
      await adapter.verifyToken('token-2');
      await adapter.verifyToken('token-3');

      expect(importSPKI).toHaveBeenCalledTimes(1);
    });

    it('passes correct algorithm to importSPKI', async () => {
      const jwtVerify = createMockJwtVerify(validPayload);
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
        algorithm: 'ES256',
      });

      await adapter.verifyToken('token');

      expect(importSPKI).toHaveBeenCalledWith(TEST_PUBLIC_KEY, 'ES256');
    });

    it('uses RS256 as default algorithm', async () => {
      const jwtVerify = createMockJwtVerify(validPayload);
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      await adapter.verifyToken('token');

      expect(importSPKI).toHaveBeenCalledWith(TEST_PUBLIC_KEY, 'RS256');
    });
  });

  describe('verification options', () => {
    it('passes issuer to jwtVerify when provided', async () => {
      const jwtVerify = createMockJwtVerify(validPayload);
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
        issuer: 'https://clerk.example.com',
      });

      await adapter.verifyToken('token');

      expect(jwtVerify).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ issuer: 'https://clerk.example.com' })
      );
    });

    it('passes audience to jwtVerify when provided', async () => {
      const jwtVerify = createMockJwtVerify(validPayload);
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
        audience: 'my-app',
      });

      await adapter.verifyToken('token');

      expect(jwtVerify).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ audience: 'my-app' })
      );
    });

    it('passes clockTolerance to jwtVerify', async () => {
      const jwtVerify = createMockJwtVerify(validPayload);
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
        clockToleranceSeconds: 30,
      });

      await adapter.verifyToken('token');

      expect(jwtVerify).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ clockTolerance: 30 })
      );
    });

    it('uses default clockTolerance of 5 seconds', async () => {
      const jwtVerify = createMockJwtVerify(validPayload);
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      await adapter.verifyToken('token');

      expect(jwtVerify).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ clockTolerance: 5 })
      );
    });
  });

  describe('missing claims', () => {
    it('returns InvalidTokenError when sub claim is missing', async () => {
      const payloadWithoutSub: JWTPayload = {
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const jwtVerify = createMockJwtVerify(payloadWithoutSub);
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      const result = await adapter.verifyToken('token');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('InvalidTokenError');
      expect(result._unsafeUnwrapErr().message).toContain('sub');
    });

    it('returns InvalidTokenError when sub claim is empty string', async () => {
      const payloadWithEmptySub: JWTPayload = {
        sub: '',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const jwtVerify = createMockJwtVerify(payloadWithEmptySub);
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      const result = await adapter.verifyToken('token');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('InvalidTokenError');
    });

    it('returns InvalidTokenError when exp claim is missing', async () => {
      const payloadWithoutExp: JWTPayload = {
        sub: 'user_123',
      };
      const jwtVerify = createMockJwtVerify(payloadWithoutExp);
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      const result = await adapter.verifyToken('token');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('InvalidTokenError');
      expect(result._unsafeUnwrapErr().message).toContain('exp');
    });
  });

  describe('error handling', () => {
    it('returns TokenExpiredError for expired tokens', async () => {
      const jwtVerify = createMockJwtVerify(new Error('token expired'));
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      const result = await adapter.verifyToken('expired-token');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('TokenExpiredError');
    });

    it('returns TokenExpiredError for "exp" claim errors', async () => {
      const jwtVerify = createMockJwtVerify(new Error('"exp" claim timestamp check failed'));
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      const result = await adapter.verifyToken('token');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('TokenExpiredError');
    });

    it('returns TokenSignatureError for signature verification failures', async () => {
      const jwtVerify = createMockJwtVerify(new Error('signature verification failed'));
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      const result = await adapter.verifyToken('bad-signature-token');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('TokenSignatureError');
    });

    it('returns TokenSignatureError for invalid compact JWS', async () => {
      const jwtVerify = createMockJwtVerify(new Error('Invalid Compact JWS'));
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      const result = await adapter.verifyToken('malformed');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('TokenSignatureError');
    });

    it('returns InvalidTokenError for malformed tokens', async () => {
      const jwtVerify = createMockJwtVerify(new Error('malformed token'));
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      const result = await adapter.verifyToken('not-a-jwt');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('InvalidTokenError');
    });

    it('returns AuthProviderError for key import failures', async () => {
      const jwtVerify = createMockJwtVerify(validPayload);
      const importSPKI = createMockImportSPKI(true); // Will fail

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: 'invalid-key',
      });

      const result = await adapter.verifyToken('token');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('AuthProviderError');
      expect(result._unsafeUnwrapErr().message).toContain('key');
    });

    it('returns AuthProviderError for unknown errors', async () => {
      const jwtVerify = createMockJwtVerify(new Error('Something completely unexpected'));
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      const result = await adapter.verifyToken('token');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('AuthProviderError');
    });

    it('handles non-Error throws', async () => {
      const jwtVerify = vi.fn().mockImplementation(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw handling
        throw 'string error';
      });
      const importSPKI = createMockImportSPKI();

      const adapter = makeJWTAdapter({
        jwtVerify: jwtVerify as JWTVerifyFn,
        importSPKI,
        publicKeyPEM: TEST_PUBLIC_KEY,
      });

      const result = await adapter.verifyToken('token');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('AuthProviderError');
    });
  });
});
