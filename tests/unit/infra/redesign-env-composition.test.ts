/**
 * The composition settings that used to bypass the TypeBox schema (review
 * X/F13): procurement analytics (ClickHouse), the procurement record-list
 * search index map, the legal search aliases, the DA list window — plus the
 * proxy-trust switch (X/F15). Every rule the entrypoint used to apply ad hoc
 * is pinned here: empty string = off, dedicated connection overrides the
 * kernel-wide one, the search paths turn on only with an explicit index map /
 * alias, and TRUST_PROXY accepts only "true" / "false".
 */
import { describe, expect, it } from 'vitest';

import { loadEmbeddedKernelConfig, loadRedesignConfig } from '@/infra/config/redesign-env.js';

const base = {
  PROD_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
  PROD_OPENSEARCH_URL: 'https://os.internal:9200',
  PROD_OPENSEARCH_USERNAME: 'kernel',
  PROD_OPENSEARCH_PASSWORD: 'secret',
  PROD_OPENSEARCH_CA_FILE: '/etc/ca/os.pem',
  PROD_OPENSEARCH_TLS_SERVERNAME: 'os.internal',
};

describe('loadRedesignConfig — composition settings', () => {
  it('defaults: proxy trusted, no ClickHouse, no search paths, no DA window', () => {
    const c = loadRedesignConfig(base);
    expect(c.trustProxy).toBe(true);
    expect(c.procurement).toEqual({});
    expect(c.legalSearch).toBeUndefined();
  });

  it('treats an empty PROD_CLICKHOUSE_URL as off (the ConfigMap switch) and a set one as on', () => {
    expect(
      loadRedesignConfig({ ...base, PROD_CLICKHOUSE_URL: '' }).procurement.clickhouse
    ).toBeUndefined();
    expect(
      loadRedesignConfig({
        ...base,
        PROD_CLICKHOUSE_URL: 'http://ch:8123',
        PROD_CLICKHOUSE_USER: 'ro',
        PROD_CLICKHOUSE_PASSWORD: 'pw',
      }).procurement.clickhouse
    ).toEqual({ url: 'http://ch:8123', database: 'proto', user: 'ro', password: 'pw' });
    expect(
      loadRedesignConfig({
        ...base,
        PROD_CLICKHOUSE_URL: 'http://ch:8123',
        PROD_CLICKHOUSE_DATABASE: 'facts',
      }).procurement.clickhouse?.database
    ).toBe('facts');
  });

  it('enables procurement search only with an explicit per-grain index map, inheriting the kernel connection', () => {
    expect(loadRedesignConfig(base).procurement.search).toBeUndefined();
    const on = loadRedesignConfig({
      ...base,
      PROCUREMENT_SEARCH_OPENSEARCH_INDEXES:
        'contract:contracts-v2, procedure:procedures-v2,bad,:x,y:',
    }).procurement.search;
    expect(on).toEqual({
      url: 'https://os.internal:9200',
      username: 'kernel',
      password: 'secret',
      caFile: '/etc/ca/os.pem',
      tlsServername: 'os.internal',
      indexes: { contract: 'contracts-v2', procedure: 'procedures-v2' },
    });
  });

  it('lets a dedicated procurement connection override the kernel-wide one field by field', () => {
    const on = loadRedesignConfig({
      ...base,
      PROCUREMENT_SEARCH_OPENSEARCH_INDEXES: 'contract:contracts-v2',
      PROCUREMENT_SEARCH_OPENSEARCH_URL: 'https://os-proc:9200',
      PROCUREMENT_SEARCH_OPENSEARCH_CA_FILE: '',
    }).procurement.search;
    expect(on?.url).toBe('https://os-proc:9200');
    expect(on?.caFile).toBeUndefined();
    expect(on?.username).toBe('kernel');
  });

  it('stays off when an index map is named but no connection exists', () => {
    const c = loadRedesignConfig({
      PROD_DATABASE_URL: base.PROD_DATABASE_URL,
      PROCUREMENT_SEARCH_OPENSEARCH_INDEXES: 'contract:contracts-v2',
    });
    expect(c.procurement.search).toBeUndefined();
  });

  it('parses the DA window as a positive integer only', () => {
    expect(
      loadRedesignConfig({ ...base, PROCUREMENT_DA_LIST_MAX_WINDOW_DAYS: '90' }).procurement
        .daListMaxWindowDays
    ).toBe(90);
    expect(
      loadRedesignConfig({ ...base, PROCUREMENT_DA_LIST_MAX_WINDOW_DAYS: '0' }).procurement
        .daListMaxWindowDays
    ).toBeUndefined();
    expect(
      loadRedesignConfig({ ...base, PROCUREMENT_DA_LIST_MAX_WINDOW_DAYS: 'x' }).procurement
        .daListMaxWindowDays
    ).toBeUndefined();
  });

  it('enables legal search only when an acts or sections alias is named', () => {
    expect(loadRedesignConfig(base).legalSearch).toBeUndefined();
    expect(
      loadRedesignConfig({ ...base, LEGAL_SEARCH_OPENSEARCH_ACTS_INDEX: '' }).legalSearch
    ).toBeUndefined();
    const acts = loadRedesignConfig({
      ...base,
      LEGAL_SEARCH_OPENSEARCH_ACTS_INDEX: 'legal-acts',
    }).legalSearch;
    expect(acts).toMatchObject({
      url: 'https://os.internal:9200',
      actsIndex: 'legal-acts',
      caFile: '/etc/ca/os.pem',
    });
    expect(acts?.sectionsIndex).toBeUndefined();
    const both = loadRedesignConfig({
      ...base,
      LEGAL_SEARCH_OPENSEARCH_URL: 'https://os-legal:9200',
      LEGAL_SEARCH_OPENSEARCH_SECTIONS_INDEX: 'legal-sections',
    }).legalSearch;
    expect(both).toMatchObject({ url: 'https://os-legal:9200', sectionsIndex: 'legal-sections' });
  });

  it('shares the legacy TRUST_PROXY contract: booleans, hop counts, proxy lists; blank = default on', () => {
    expect(loadRedesignConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadRedesignConfig({ ...base, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadRedesignConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadRedesignConfig({ ...base, TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy).toBe(
      'loopback, 10.0.0.0/8'
    );
    expect(loadRedesignConfig({ ...base, TRUST_PROXY: '  ' }).trustProxy).toBe(true);
  });
});

describe('loadEmbeddedKernelConfig — the legacy composer ignores standalone-only settings', () => {
  // Codex review (slice 1): `api.ts` now loads the kernel config unconditionally,
  // so a standalone-only value the platform's `env.ts` accepts (an empty
  // CLERK_SECRET_KEY, a Clerk block without issuer, a webhook secret without the
  // user-data DB) must never stop the platform API from booting.
  it('accepts an env that the standalone loader rejects on auth / user-data grounds', () => {
    const standaloneOnly = {
      CLERK_SECRET_KEY: '',
      CLERK_ISSUER: 'https://clerk.example.com',
      CLERK_WEBHOOK_SIGNING_SECRET: 'whsec',
    };
    expect(() => loadRedesignConfig({ ...base, ...standaloneOnly })).toThrow();
    const embedded = loadEmbeddedKernelConfig({ ...base, ...standaloneOnly });
    expect(embedded.kernel.prodDatabaseUrl).toBe(base.PROD_DATABASE_URL);
    expect(Object.keys(embedded).sort()).toEqual(['kernel', 'procurement']);
  });

  it('still fails on a missing or invalid kernel source', () => {
    expect(() => loadEmbeddedKernelConfig({})).toThrow(/PROD_DATABASE_URL/u);
  });
});
