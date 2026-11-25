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

describe('BullMQ Redis health configuration', () => {
  const base = { PROD_DATABASE_URL: 'postgres://reader@example.invalid/transparenta_prod' };
  const redisConfig = {
    BULLMQ_REDIS_URL: 'rediss://queue.example.invalid:6379/0',
    BULLMQ_REDIS_PASSWORD: 'fixture password',
    BULLMQ_REDIS_CA_FILE: '/public/ca.crt',
  };

  it('is optional and requires a complete TLS tuple when set', () => {
    expect(loadRedesignConfig(base).queueRedis).toBeUndefined();
    expect(loadRedesignConfig({ ...base, ...redisConfig }).queueRedis?.url).toBe(
      redisConfig.BULLMQ_REDIS_URL
    );
    expect(() =>
      loadRedesignConfig({ ...base, BULLMQ_REDIS_URL: redisConfig.BULLMQ_REDIS_URL })
    ).toThrow(/requires a TLS URL, password and CA file/);
  });

  it.each([
    'redis://queue.example.invalid:6379/0',
    'rediss://name:fixture@queue.example.invalid:6379/0',
    'rediss://queue.example.invalid:6379/1',
    'rediss://queue.example.invalid:6379/0?tls=false',
  ])('rejects unsupported connection targets', (url) => {
    expect(() => loadRedesignConfig({ ...base, ...redisConfig, BULLMQ_REDIS_URL: url })).toThrow(
      /requires a rediss URL/
    );
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

describe('direct-acquisition switches', () => {
  const base = { PROD_DATABASE_URL: 'postgres://reader@example.invalid/transparenta_prod' };

  it('refuses v3 without site-wide D6 (the rollout order: D6 first)', () => {
    expect(() => loadRedesignConfig({ ...base, PROCUREMENT_DA_V3_ENABLED: 'true' })).toThrow(
      /requires PROCUREMENT_SUPPLIER_DISCLOSURE_ENFORCED=true/u
    );
  });

  it('accepts D6 alone and D6 with v3', () => {
    expect(
      loadRedesignConfig({ ...base, PROCUREMENT_SUPPLIER_DISCLOSURE_ENFORCED: 'true' }).procurement
    ).toMatchObject({ supplierDisclosureEnforced: true });
    expect(
      loadRedesignConfig({
        ...base,
        PROCUREMENT_SUPPLIER_DISCLOSURE_ENFORCED: 'true',
        PROCUREMENT_DA_V3_ENABLED: 'true',
      }).procurement
    ).toMatchObject({ supplierDisclosureEnforced: true, daV3Enabled: true });
  });

  it('serves legacy by default and retires it only on the exact value false', () => {
    expect(loadRedesignConfig(base).procurement?.legacyEnabled).toBeUndefined();
    expect(
      loadRedesignConfig({ ...base, PROCUREMENT_LEGACY_ENABLED: 'true' }).procurement?.legacyEnabled
    ).toBeUndefined();
    expect(
      loadRedesignConfig({ ...base, PROCUREMENT_LEGACY_ENABLED: 'false' }).procurement
    ).toMatchObject({ legacyEnabled: false });
  });

  it('serves the legacy DA list by default and retires it only on the exact value false', () => {
    expect(loadRedesignConfig(base).procurement?.legacyDaListEnabled).toBeUndefined();
    expect(
      loadRedesignConfig({ ...base, PROCUREMENT_LEGACY_DA_LIST_ENABLED: 'true' }).procurement
        ?.legacyDaListEnabled
    ).toBeUndefined();
    expect(
      loadRedesignConfig({ ...base, PROCUREMENT_LEGACY_DA_LIST_ENABLED: 'false' }).procurement
    ).toMatchObject({ legacyDaListEnabled: false });
  });

  it.each(['False', 'off', '0', ''])(
    'refuses PROCUREMENT_LEGACY_DA_LIST_ENABLED=%j at boot (a privacy switch is never guessed)',
    (value) => {
      expect(() =>
        loadRedesignConfig({ ...base, PROCUREMENT_LEGACY_DA_LIST_ENABLED: value })
      ).toThrow(/PROCUREMENT_LEGACY_DA_LIST_ENABLED must be 'true' or 'false'/u);
    }
  );

  it.each(['False', 'off', '0', ''])(
    'refuses PROCUREMENT_LEGACY_ENABLED=%j at boot (a privacy switch is never guessed)',
    (value) => {
      expect(() => loadRedesignConfig({ ...base, PROCUREMENT_LEGACY_ENABLED: value })).toThrow(
        /PROCUREMENT_LEGACY_ENABLED must be 'true' or 'false'/u
      );
    }
  );

  it('serves no contract-award records by default, nor without site-wide D6', () => {
    expect(loadRedesignConfig(base).procurement?.caRecordsEnabled).toBeUndefined();
    expect(
      loadRedesignConfig({ ...base, PROCUREMENT_CA_RECORDS_ENABLED: 'false' }).procurement
        ?.caRecordsEnabled
    ).toBeUndefined();
    expect(() => loadRedesignConfig({ ...base, PROCUREMENT_CA_RECORDS_ENABLED: 'true' })).toThrow(
      /PROCUREMENT_CA_RECORDS_ENABLED=true requires PROCUREMENT_SUPPLIER_DISCLOSURE_ENFORCED=true/u
    );
    expect(
      loadRedesignConfig({
        ...base,
        PROCUREMENT_SUPPLIER_DISCLOSURE_ENFORCED: 'true',
        PROCUREMENT_CA_RECORDS_ENABLED: 'true',
      }).procurement
    ).toMatchObject({ caRecordsEnabled: true });
  });

  it.each(['True', 'on', '1', ''])(
    'refuses PROCUREMENT_CA_RECORDS_ENABLED=%j at boot (a privacy switch is never guessed)',
    (value) => {
      expect(() => loadRedesignConfig({ ...base, PROCUREMENT_CA_RECORDS_ENABLED: value })).toThrow(
        /PROCUREMENT_CA_RECORDS_ENABLED must be 'true' or 'false'/u
      );
    }
  );
});

describe('PROCUREMENT_DATABASE_URL (PRJ-54YB)', () => {
  const base = { PROD_DATABASE_URL: 'postgres://reader@example.invalid/transparenta_prod' };

  it('is absent from the kernel config when unset or blank: procurement shares the kernel pool', () => {
    expect(loadRedesignConfig(base).kernel.procurementDatabaseUrl).toBeUndefined();
    expect(
      loadRedesignConfig({ ...base, PROCUREMENT_DATABASE_URL: '' }).kernel.procurementDatabaseUrl
    ).toBeUndefined();
  });

  it.each([
    [
      'a host and sslmode',
      'postgresql://procurement@example.invalid/transparenta_prod?sslmode=require',
    ],
    ['a host in the query', 'postgresql:///transparenta_prod?host=db.example.invalid&user=reader'],
    ['a Unix socket directory', 'postgres:///transparenta_prod?host=/var/run/postgresql'],
    ['a percent-encoded password', 'postgres://reader:p%40ss%2Fw@example.invalid:5432/db'],
  ])('passes a postgres URL with %s through to the kernel config', (_label, url) => {
    expect(
      loadRedesignConfig({ ...base, PROCUREMENT_DATABASE_URL: url }).kernel.procurementDatabaseUrl
    ).toBe(url);
  });

  it.each([
    ['another scheme', 'mysql://secret-user:secret-pass@example.invalid/db'],
    ['an out-of-range port', 'postgres://secret-user:secret-pass@example.invalid:99999/db'],
    ['no host', 'postgres://secret-user:secret-pass@/db'],
    ['an empty host', 'postgres:///secret_db'],
    ['no URL at all', 'secret-user secret-pass'],
  ])('refuses %s at boot without echoing it', (_label, value) => {
    let message = '';
    try {
      loadRedesignConfig({ ...base, PROCUREMENT_DATABASE_URL: value });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/PROCUREMENT_DATABASE_URL must be a postgres/u);
    expect(message).not.toContain('secret');
  });
});
