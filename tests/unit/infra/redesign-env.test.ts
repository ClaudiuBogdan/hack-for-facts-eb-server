import { describe, expect, it } from 'vitest';

import { loadRedesignConfig } from '@/infra/config/redesign-env.js';

describe('loadRedesignConfig', () => {
  it('applies empty defaults for optional serving dependencies', () => {
    const config = loadRedesignConfig({
      PROD_DATABASE_URL: 'postgres://reader@example.invalid/transparenta_prod',
    });

    expect(config.kernel.meiliHost).toBe('');
    expect(config.kernel.meiliApiKey).toBe('');
    expect(config.kernel.opensearchUrl).toBe('');
  });

  it('accepts the search-only Meilisearch key without a master key', () => {
    const config = loadRedesignConfig({
      PROD_DATABASE_URL: 'postgres://reader@example.invalid/transparenta_prod',
      PROD_MEILI_HOST: 'http://meilisearch.example.invalid',
      PROD_MEILI_SEARCH_API_KEY: 'search-only-test-key',
    });

    expect(config.kernel.meiliApiKey).toBe('');
    expect(config.kernel.meiliSearchApiKey).toBe('search-only-test-key');
  });
});

describe('native Clerk configuration', () => {
  const base = { PROD_DATABASE_URL: 'postgres://reader@example.invalid/transparenta_prod' };
  const auth = {
    CLERK_JWT_KEY: 'test public key',
    CLERK_ISSUER: 'https://example.clerk.accounts.dev',
    CLERK_AUTHORIZED_PARTIES: 'https://dev.example.test,http://localhost:60509',
  };
  it('keeps anonymous native boot available when auth is absent', () => {
    expect(loadRedesignConfig(base).auth).toBeUndefined();
  });
  it('requires a complete explicit issuer/key/client tuple', () => {
    for (const name of Object.keys(auth)) {
      const incomplete = Object.fromEntries(Object.entries(auth).filter(([key]) => key !== name));
      expect(() => loadRedesignConfig({ ...base, ...incomplete })).toThrow(/Clerk auth requires/);
    }
    expect(loadRedesignConfig({ ...base, ...auth }).auth?.authorizedParties).toEqual([
      'https://dev.example.test',
      'http://localhost:60509',
    ]);
  });
  it('rejects wildcard, credentialed, insecure remote and path-based clients', () => {
    for (const value of [
      '*',
      'http://remote.example',
      'https://name:password@dev.example',
      'https://dev.example/path',
      'https://dev.example/#fragment',
    ]) {
      expect(() =>
        loadRedesignConfig({ ...base, ...auth, CLERK_AUTHORIZED_PARTIES: value })
      ).toThrow(/explicit HTTPS or loopback origins/);
    }
  });
});

describe('native user-data configuration', () => {
  const base = {
    PROD_DATABASE_URL: 'postgres://reader@example.invalid/transparenta_prod',
    CLERK_JWT_KEY: 'public key',
    CLERK_ISSUER: 'https://example.clerk.accounts.dev',
    CLERK_AUTHORIZED_PARTIES: 'https://dev.example.test',
  };
  const userData = {
    USER_DATA_DATABASE_URL: 'postgres://app@dev.example.invalid/user_data',
    USER_DATA_DB_CA_FILE: '/public/ca.crt',
    CLERK_WEBHOOK_SIGNING_SECRET: 'test-signing-secret',
  };
  it('requires auth, dedicated TLS database configuration and deletion verification together', () => {
    for (const key of Object.keys(userData)) {
      const incomplete = Object.fromEntries(
        Object.entries(userData).filter(([name]) => name !== key)
      );
      expect(() => loadRedesignConfig({ ...base, ...incomplete })).toThrow(/User data requires/);
    }
    expect(() =>
      loadRedesignConfig({ PROD_DATABASE_URL: base.PROD_DATABASE_URL, ...userData })
    ).toThrow(/User data requires/);
    expect(loadRedesignConfig({ ...base, ...userData }).userData?.url).toBe(
      userData.USER_DATA_DATABASE_URL
    );
  });
});
