/**
 * The companies analytics reader configuration: its own ClickHouse user and
 * database, all-or-nothing, never inherited from procurement's connection, and
 * read only by the standalone (Chronos) entrypoint.
 */
import { describe, expect, it } from 'vitest';

import { loadEmbeddedKernelConfig, loadRedesignConfig } from '@/infra/config/redesign-env.js';

const base = { PROD_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' };
const reader = {
  COMPANIES_ANALYTICS_CLICKHOUSE_URL:
    'https://transparenta-eu-etl-clickhouse.transparenta-eu-etl-prod.svc.cluster.local:8443',
  COMPANIES_ANALYTICS_CLICKHOUSE_DATABASE: 'companies_analytics',
  COMPANIES_ANALYTICS_CLICKHOUSE_USER: 'companies_reader',
  COMPANIES_ANALYTICS_CLICKHOUSE_PASSWORD: 'pw-not-in-errors',
};

const failure = (env: Record<string, string>): string => {
  try {
    loadRedesignConfig(env);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the configuration to be refused');
};

describe('companies analytics reader configuration', () => {
  it('is disabled when unset, including an empty URL (the ConfigMap switch)', () => {
    expect(loadRedesignConfig(base).companiesAnalytics).toBeUndefined();
    expect(
      loadRedesignConfig({ ...base, COMPANIES_ANALYTICS_CLICKHOUSE_URL: '' }).companiesAnalytics
    ).toBeUndefined();
  });

  it('composes the complete tuple with the origin only', () => {
    expect(loadRedesignConfig({ ...base, ...reader }).companiesAnalytics).toEqual({
      clickhouse: {
        url: 'https://transparenta-eu-etl-clickhouse.transparenta-eu-etl-prod.svc.cluster.local:8443',
        database: 'companies_analytics',
        user: 'companies_reader',
        password: 'pw-not-in-errors',
      },
    });
  });

  it('never borrows procurement’s ClickHouse connection', () => {
    const config = loadRedesignConfig({
      ...base,
      PROD_CLICKHOUSE_URL: 'http://ch:8123',
      PROD_CLICKHOUSE_USER: 'procurement',
      PROD_CLICKHOUSE_PASSWORD: 'pw',
    });
    expect(config.procurement.clickhouse).toBeDefined();
    expect(config.companiesAnalytics).toBeUndefined();
  });

  it.each([
    ['without a URL', { ...reader, COMPANIES_ANALYTICS_CLICKHOUSE_URL: '' }],
    ['without a password', { ...reader, COMPANIES_ANALYTICS_CLICKHOUSE_PASSWORD: '' }],
    ['without a user', { ...reader, COMPANIES_ANALYTICS_CLICKHOUSE_USER: '' }],
    ['without the database', { ...reader, COMPANIES_ANALYTICS_CLICKHOUSE_DATABASE: '' }],
    ['with another database', { ...reader, COMPANIES_ANALYTICS_CLICKHOUSE_DATABASE: 'proto' }],
    [
      'with credentials in the URL',
      { ...reader, COMPANIES_ANALYTICS_CLICKHOUSE_URL: 'https://u:p@clickhouse:8443' },
    ],
    [
      'with a query string',
      { ...reader, COMPANIES_ANALYTICS_CLICKHOUSE_URL: 'https://clickhouse:8443/?user=x' },
    ],
    ['with a path', { ...reader, COMPANIES_ANALYTICS_CLICKHOUSE_URL: 'https://clickhouse:8443/x' }],
    ['with another scheme', { ...reader, COMPANIES_ANALYTICS_CLICKHOUSE_URL: 'ftp://clickhouse' }],
    ['with an unparsable URL', { ...reader, COMPANIES_ANALYTICS_CLICKHOUSE_URL: 'clickhouse' }],
  ])('fails the boot %s, naming keys but never values', (_label, env) => {
    const message = failure({ ...base, ...env });
    expect(message).toContain('COMPANIES_ANALYTICS_CLICKHOUSE');
    expect(message).not.toContain('pw-not-in-errors');
  });

  it('is invisible to the embedded (api.js) loader, even when half-configured', () => {
    expect(() =>
      loadEmbeddedKernelConfig({ ...base, COMPANIES_ANALYTICS_CLICKHOUSE_PASSWORD: 'x' })
    ).not.toThrow();
    expect(loadEmbeddedKernelConfig({ ...base, ...reader })).not.toHaveProperty(
      'companiesAnalytics'
    );
  });
});
