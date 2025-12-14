import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { computeCpiAdjustmentFactorMap } from '@/modules/normalization/index.js';

describe('computeCpiAdjustmentFactorMap', () => {
  it('computes adjustment factors relative to reference year', () => {
    const yoy = new Map([
      ['2023', new Decimal(100)],
      ['2024', new Decimal(110)],
    ]);

    const factors = computeCpiAdjustmentFactorMap(yoy, 2024);

    expect(factors.get('2023')?.toNumber()).toBeCloseTo(1.1, 10);
    expect(factors.get('2024')?.toNumber()).toBeCloseTo(1, 10);
  });

  it('chains YoY indices across multiple years', () => {
    const yoy = new Map([
      ['2022', new Decimal(120)],
      ['2023', new Decimal(110)],
      ['2024', new Decimal(105)],
    ]);

    const factors = computeCpiAdjustmentFactorMap(yoy, 2024);

    // Levels: 2022=1, 2023=1.10, 2024=1.10*1.05=1.155
    // Factors: 2022=1.155, 2023=1.05, 2024=1
    expect(factors.get('2022')?.toNumber()).toBeCloseTo(1.155, 10);
    expect(factors.get('2023')?.toNumber()).toBeCloseTo(1.05, 10);
    expect(factors.get('2024')?.toNumber()).toBeCloseTo(1, 10);
  });
});
