import type { AxisDataType, AxisGranularity, DatasetAxesType, DatasetFrequency } from '../types.js';

/**
 * Map internal axis type to GraphQL AxisDataType enum.
 * - 'date' -> 'DATE'
 * - 'number' -> 'FLOAT'
 * - 'category' -> 'STRING'
 */
export const mapAxisType = (type: DatasetAxesType): AxisDataType => {
  switch (type) {
    case 'date':
      return 'DATE';
    case 'number':
      return 'FLOAT';
    case 'category':
      return 'STRING';
  }
};

/**
 * Map dataset frequency to GraphQL AxisGranularity enum.
 * - 'yearly' -> 'YEAR'
 * - 'quarterly' -> 'QUARTER'
 * - 'monthly' -> 'MONTH'
 * - undefined -> 'CATEGORY' (default for non-time-based data)
 */
export const mapFrequencyToGranularity = (frequency?: DatasetFrequency): AxisGranularity => {
  switch (frequency) {
    case 'yearly':
      return 'YEAR';
    case 'quarterly':
      return 'QUARTER';
    case 'monthly':
      return 'MONTH';
    default:
      return 'CATEGORY';
  }
};
