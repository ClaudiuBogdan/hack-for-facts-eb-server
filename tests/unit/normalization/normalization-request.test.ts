import { describe, expect, it } from 'vitest';

import { resolveNormalizationRequest } from '@/modules/normalization/index.js';

describe('resolveNormalizationRequest', () => {
  it('defaults to total in RON', () => {
    const req = resolveNormalizationRequest({});
    expect(req.normalization).toBe('total');
    expect(req.currency).toBe('RON');
    expect(req.inflationAdjusted).toBe(false);
    expect(req.showPeriodGrowth).toBe(false);
    expect(req.requiresExternalPerCapitaDivision).toBe(false);
    expect(req.transformation).toEqual({
      inflationAdjusted: false,
      currency: 'RON',
      normalization: 'total',
      showPeriodGrowth: false,
    });
  });

  it('maps legacy total_euro to currency EUR', () => {
    const req = resolveNormalizationRequest({ normalization: 'total_euro' });
    expect(req.normalization).toBe('total');
    expect(req.currency).toBe('EUR');
    expect(req.requiresExternalPerCapitaDivision).toBe(false);
    expect(req.transformation.currency).toBe('EUR');
    expect(req.transformation.normalization).toBe('total');
  });

  it('treats per_capita as external division (service uses total)', () => {
    const req = resolveNormalizationRequest({ normalization: 'per_capita' });
    expect(req.normalization).toBe('per_capita');
    expect(req.currency).toBe('RON');
    expect(req.requiresExternalPerCapitaDivision).toBe(true);
    expect(req.transformation.normalization).toBe('total');
  });

  it('lets explicit currency override legacy currency shortcuts', () => {
    const req = resolveNormalizationRequest({
      normalization: 'total_euro',
      currency: 'USD',
    });
    expect(req.normalization).toBe('total');
    expect(req.currency).toBe('USD');
    expect(req.transformation.currency).toBe('USD');
  });

  it('forces currency to RON for percent_gdp', () => {
    const req = resolveNormalizationRequest({
      normalization: 'percent_gdp',
      currency: 'EUR',
      inflationAdjusted: true,
    });
    expect(req.normalization).toBe('percent_gdp');
    expect(req.currency).toBe('RON');
    expect(req.transformation.currency).toBe('RON');
  });
});
