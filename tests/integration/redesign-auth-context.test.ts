/**
 * Request-level authentication on the kernel build (`buildRedesignApp` with a
 * configured JWT provider), end to end through `app.inject()`: a bearer token
 * the provider verifies reaches resolvers as an authenticated session with its
 * expiry; a missing or malformed header, and a sample of the provider's
 * refusals (wrong issuer, wrong authorized party, expired, forged key; each is
 * pinned at provider level in `tests/unit/auth/configured-jwt-provider.test.ts`),
 * reach them as the anonymous session with HTTP 200, the documented GraphQL
 * contract (resolvers decide, the transport does not reject). Without an auth
 * provider the context carries no session at all.
 *
 * The other redesign integration suites authenticate through a fake provider;
 * this one is the real jose-signed path through `makeConfiguredJWTProvider`.
 * The pool points at a closed port; only the probe field executes.
 */

import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { makeConfiguredJWTProvider } from '@/modules/auth/shell/adapters/configured-jwt-provider.js';

import type { AuthenticatedMercuriusContext } from '@/modules/auth/shell/middleware/graphql-context.js';
import type { FastifyInstance } from 'fastify';

const ISSUER = 'https://example.clerk.accounts.dev';
const CLIENT = 'https://dev.example.test';

/** A probe root that reflects the auth context a resolver sees. */
const probeSlice = {
  source: 'tests/integration/redesign-auth-context',
  typeDefs: 'extend type Query { authProbe: String }',
};
const probeResolvers = {
  Query: {
    authProbe: (
      _parent: unknown,
      _args: unknown,
      context: Partial<AuthenticatedMercuriusContext>
    ) =>
      context.auth === undefined
        ? 'no-context'
        : context.auth.userId === null
          ? `anonymous:${String(context.auth.isAnonymous)}`
          : `user:${context.auth.userId}:${context.auth.expiresAt.toISOString()}`,
  },
};

/** An explicit `exp` claim (epoch seconds), so the expected expiry is exact, not calendar-relative. */
const IN_ONE_HOUR = Math.floor(Date.now() / 1000) + 3600;

const kernelConfig = {
  prodDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
  meiliHost: '',
  meiliApiKey: '',
  opensearchUrl: '',
};

describe('redesign app: request-level authentication', () => {
  let app: FastifyInstance;
  let bare: FastifyInstance;
  let sign: (claims: {
    iss?: string;
    azp?: string;
    exp?: number;
    key?: CryptoKey;
  }) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    sign = async ({ iss = ISSUER, azp = CLIENT, exp = IN_ONE_HOUR, key = privateKey }) =>
      new SignJWT({ azp })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('user_2abc')
        .setIssuer(iss)
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(key);
    const authProvider = await makeConfiguredJWTProvider({
      jwtKey: await exportSPKI(publicKey),
      issuer: ISSUER,
      authorizedParties: [CLIENT],
    });
    app = (
      await buildRedesignApp({
        logLevel: 'silent',
        modules: [],
        kernelConfig,
        authProvider,
        graphqlSlices: [probeSlice],
        graphqlResolvers: probeResolvers,
      })
    ).app;
    bare = (
      await buildRedesignApp({
        logLevel: 'silent',
        modules: [],
        kernelConfig,
        graphqlSlices: [probeSlice],
        graphqlResolvers: probeResolvers,
      })
    ).app;
    await Promise.all([app.ready(), bare.ready()]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([app?.close(), bare?.close()]);
  });

  const probe = async (target: FastifyInstance, headers: Record<string, string> = {}) => {
    const res = await target.inject({
      method: 'POST',
      url: '/api/v1/graphql',
      headers,
      payload: { query: '{ authProbe }' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data?: { authProbe: string }; errors?: unknown[] }>();
    expect(body.errors).toBeUndefined();
    return body.data?.authProbe;
  };

  it('a verified bearer token reaches resolvers as the authenticated session, with its expiry', async () => {
    const token = await sign({});
    expect(await probe(app, { authorization: `Bearer ${token}` })).toBe(
      `user:user_2abc:${new Date(IN_ONE_HOUR * 1000).toISOString()}`
    );
  });

  it.each([
    ['no header', async () => ({})],
    ['a malformed header', async () => ({ authorization: 'Bearer not-a-jwt' })],
    [
      'the wrong issuer',
      async () => ({
        authorization: `Bearer ${await sign({ iss: 'https://other.clerk.accounts.dev' })}`,
      }),
    ],
    [
      'the wrong authorized party',
      async () => ({ authorization: `Bearer ${await sign({ azp: 'https://other.example' })}` }),
    ],
    [
      'an expired token',
      async () => ({ authorization: `Bearer ${await sign({ exp: IN_ONE_HOUR - 7200 })}` }),
    ],
    [
      'a token signed by another key',
      async () => ({
        authorization: `Bearer ${await sign({ key: (await generateKeyPair('RS256')).privateKey })}`,
      }),
    ],
  ])('%s reaches resolvers as the anonymous session, with HTTP 200', async (_name, headers) => {
    expect(await probe(app, await headers())).toBe('anonymous:true');
  });

  it('without an auth provider the context carries no session', async () => {
    expect(await probe(bare, { authorization: `Bearer ${await sign({})}` })).toBe('no-context');
  });
});
