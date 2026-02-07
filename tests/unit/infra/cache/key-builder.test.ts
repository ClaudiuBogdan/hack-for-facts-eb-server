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

  describe('nested object handling', () => {
    it('generates different keys when nested object values differ', () => {
      const builder = createKeyBuilder();
      const filter2023 = {
        account_category: 'ch',
        report_period: { type: 1, selection: { dates: ['2023'] } },
      };
      const filter2022 = {
        account_category: 'ch',
        report_period: { type: 1, selection: { dates: ['2022'] } },
      };

      const key2023 = builder.fromFilter(CacheNamespace.ANALYTICS_COUNTY, filter2023);
      const key2022 = builder.fromFilter(CacheNamespace.ANALYTICS_COUNTY, filter2022);

      expect(key2023).not.toBe(key2022);
    });

    it('generates same key regardless of nested property order', () => {
      const builder = createKeyBuilder();
      const filter1 = {
        account_category: 'ch',
        report_period: { type: 1, selection: { dates: ['2023'] } },
      };
      const filter2 = {
        report_period: { selection: { dates: ['2023'] }, type: 1 },
        account_category: 'ch',
      };

      const key1 = builder.fromFilter(CacheNamespace.ANALYTICS_COUNTY, filter1);
      const key2 = builder.fromFilter(CacheNamespace.ANALYTICS_COUNTY, filter2);

      expect(key1).toBe(key2);
    });

    it('handles deeply nested objects correctly', () => {
      const builder = createKeyBuilder();
      const filter1 = {
        level1: { level2: { level3: { value: 'a' } } },
      };
      const filter2 = {
        level1: { level2: { level3: { value: 'b' } } },
      };

      const key1 = builder.fromFilter(CacheNamespace.ANALYTICS_EXECUTION, filter1);
      const key2 = builder.fromFilter(CacheNamespace.ANALYTICS_EXECUTION, filter2);

      expect(key1).not.toBe(key2);
    });

    it('handles arrays inside nested objects correctly', () => {
      const builder = createKeyBuilder();
      const filter1 = {
        selection: { dates: ['2023', '2024'] },
      };
      const filter2 = {
        selection: { dates: ['2022', '2023'] },
      };

      const key1 = builder.fromFilter(CacheNamespace.ANALYTICS_EXECUTION, filter1);
      const key2 = builder.fromFilter(CacheNamespace.ANALYTICS_EXECUTION, filter2);

      expect(key1).not.toBe(key2);
    });

    it('handles null values in nested objects', () => {
      const builder = createKeyBuilder();
      const filter1 = { data: { value: null } };
      const filter2 = { data: { value: 'test' } };

      const key1 = builder.fromFilter(CacheNamespace.ANALYTICS_EXECUTION, filter1);
      const key2 = builder.fromFilter(CacheNamespace.ANALYTICS_EXECUTION, filter2);

      expect(key1).not.toBe(key2);
    });

    it('generates deterministic keys for complex analytics filters', () => {
      const builder = createKeyBuilder();
      const complexFilter = {
        account_category: 'ch',
        report_type: 'PRINCIPAL_AGGREGATED',
        report_period: {
          type: 1,
          selection: { dates: ['2023'] },
        },
        entity_cuis: ['123', '456'],
      };

      const key1 = builder.fromFilter(CacheNamespace.ANALYTICS_COUNTY, complexFilter);
      const key2 = builder.fromFilter(CacheNamespace.ANALYTICS_COUNTY, complexFilter);

      expect(key1).toBe(key2);
      expect(key1).toMatch(/^transparenta:analytics:county:[a-f0-9]{16}$/);
    });
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
      expect(CacheNamespace.INS_QUERIES).toBe('ins:queries');
      expect(CacheNamespace.DATASETS).toBe('datasets');
    });
  });
});
