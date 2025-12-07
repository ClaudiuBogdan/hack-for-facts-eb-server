import { describe, expect, it } from 'vitest';

import { CacheNamespace, createKeyBuilder } from '@/infra/cache/key-builder.js';

describe('KeyBuilder', () => {
  it('builds keys with default prefix', () => {
    const builder = createKeyBuilder();
    const key = builder.build(CacheNamespace.ANALYTICS_EXECUTION, 'test-id');
    expect(key).toBe('transparenta:analytics:execution:test-id');
  });

  it('builds keys with custom prefix', () => {
    const builder = createKeyBuilder({ globalPrefix: 'custom' });
    const key = builder.build(CacheNamespace.DATASETS, 'budget-2024');
    expect(key).toBe('custom:datasets:budget-2024');
  });

  it('generates deterministic keys from filters', () => {
    const builder = createKeyBuilder();
    const filter = { year: 2024, category: 'expense' };

    const key1 = builder.fromFilter(CacheNamespace.ANALYTICS_EXECUTION, filter);
    const key2 = builder.fromFilter(CacheNamespace.ANALYTICS_EXECUTION, filter);

    expect(key1).toBe(key2);
    expect(key1).toMatch(/^transparenta:analytics:execution:[a-f0-9]{16}$/);
  });

  it('generates same key regardless of property order', () => {
    const builder = createKeyBuilder();
    const filter1 = { year: 2024, category: 'expense' };
    const filter2 = { category: 'expense', year: 2024 };

    const key1 = builder.fromFilter(CacheNamespace.ANALYTICS_EXECUTION, filter1);
    const key2 = builder.fromFilter(CacheNamespace.ANALYTICS_EXECUTION, filter2);

    expect(key1).toBe(key2);
  });

  it('generates different keys for different filters', () => {
    const builder = createKeyBuilder();
    const filter1 = { year: 2024 };
    const filter2 = { year: 2025 };

    const key1 = builder.fromFilter(CacheNamespace.ANALYTICS_EXECUTION, filter1);
    const key2 = builder.fromFilter(CacheNamespace.ANALYTICS_EXECUTION, filter2);

    expect(key1).not.toBe(key2);
  });

  it('returns prefix for namespace', () => {
    const builder = createKeyBuilder();
    expect(builder.getPrefix(CacheNamespace.ANALYTICS_EXECUTION)).toBe(
      'transparenta:analytics:execution:'
    );
    expect(builder.getPrefix(CacheNamespace.DATASETS)).toBe('transparenta:datasets:');
  });

  it('returns global prefix', () => {
    const defaultBuilder = createKeyBuilder();
    expect(defaultBuilder.getGlobalPrefix()).toBe('transparenta');

    const customBuilder = createKeyBuilder({ globalPrefix: 'myapp' });
    expect(customBuilder.getGlobalPrefix()).toBe('myapp');
  });

  describe('CacheNamespace', () => {
    it('has expected namespace values', () => {
      expect(CacheNamespace.ANALYTICS_EXECUTION).toBe('analytics:execution');
      expect(CacheNamespace.ANALYTICS_AGGREGATED).toBe('analytics:aggregated');
      expect(CacheNamespace.ANALYTICS_COUNTY).toBe('analytics:county');
      expect(CacheNamespace.ANALYTICS_ENTITY).toBe('analytics:entity');
      expect(CacheNamespace.DATASETS).toBe('datasets');
    });
  });
});
