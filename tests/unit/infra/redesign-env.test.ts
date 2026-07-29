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
