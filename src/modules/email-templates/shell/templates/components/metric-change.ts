import { toDecimal } from '../formatting.js';

import type { DecimalString } from '../../../core/types.js';

export type MetricChangeType = 'income' | 'expenses' | 'balance';

export const getMetricChangeArrow = (changePercent: DecimalString): string => {
  const decimal = toDecimal(changePercent);
  if (decimal.greaterThan(0)) return '\u2191';
  if (decimal.lessThan(0)) return '\u2193';
  return '\u2192';
};

export const getMetricChangeColor = (
  type: MetricChangeType,
  changePercent: DecimalString
): string => {
  const decimal = toDecimal(changePercent);
  if (decimal.isZero()) return '#8898aa';

  if (type === 'expenses') {
    return decimal.greaterThan(0) ? '#f43f5e' : '#10b981';
  }

  return decimal.greaterThan(0) ? '#10b981' : '#f43f5e';
};

export const getMetricChangeBackgroundColor = (
  type: MetricChangeType,
  changePercent: DecimalString
): string => {
  const decimal = toDecimal(changePercent);
  if (decimal.isZero()) return '#f6f9fc';

  if (type === 'expenses') {
    return decimal.greaterThan(0) ? '#fef2f2' : '#ecfdf5';
  }

  return decimal.greaterThan(0) ? '#ecfdf5' : '#fef2f2';
};
