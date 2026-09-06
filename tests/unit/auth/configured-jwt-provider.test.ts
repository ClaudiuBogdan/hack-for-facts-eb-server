import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { describe, it, expect } from 'vitest';

import { makeConfiguredJWTProvider } from '@/modules/auth/shell/adapters/configured-jwt-provider.js';

describe('configured native JWT provider', () => {
  it('verifies real signatures, issuer, client and expiration without token-result caching', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const issuer = 'https://example.clerk.accounts.dev';
    const client = 'https://dev.example.test';
    const provider = await makeConfiguredJWTProvider({
      jwtKey: await exportSPKI(publicKey),
      issuer,
      authorizedParties: [client],
    });
    const token = (iss = issuer, azp = client, expiration = '1h') =>
      new SignJWT({ azp })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('user_test')
        .setIssuer(iss)
        .setIssuedAt()
        .setExpirationTime(expiration)
        .sign(privateKey);
    expect((await provider.verifyToken(await token())).isOk()).toBe(true);
    expect(
      (await provider.verifyToken(await token('https://other.clerk.accounts.dev'))).isErr()
    ).toBe(true);
    expect((await provider.verifyToken(await token(issuer, 'https://other.example'))).isErr()).toBe(
      true
    );
    expect((await provider.verifyToken(await token(issuer, client, '-1h'))).isErr()).toBe(true);
    for (const claims of [{ aud: client }, { azp: 'https://other.example', aud: client }]) {
      const audienceBypass = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('user_test')
        .setIssuer(issuer)
        .setExpirationTime('1h')
        .sign(privateKey);
      expect((await provider.verifyToken(audienceBypass)).isErr()).toBe(true);
    }
    const attacker = await generateKeyPair('RS256');
    const forged = await new SignJWT({ azp: client })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('user_test')
      .setIssuer(issuer)
      .setExpirationTime('1h')
      .sign(attacker.privateKey);
    expect((await provider.verifyToken(forged)).isErr()).toBe(true);
  });
  it('fails startup with an invalid key', async () => {
    await expect(
      makeConfiguredJWTProvider({
        jwtKey: 'invalid',
        issuer: 'https://example.clerk.accounts.dev',
        authorizedParties: ['http://localhost:3000'],
      })
    ).rejects.toThrow();
  });
});
