import { Frequency } from '@/common/types/temporal.js';

/**
 * Formats a year and sub-period into a standard label string.
 * @param year - The year (e.g. 2023)
 * @param subPeriod - The sub-period value (Month 1-12, Quarter 1-4, or ignored for Year)
 * @param frequency - The frequency (YEAR, QUARTER, MONTH)
 */
export function formatPeriodLabel(year: number, subPeriod: number, frequency: Frequency): string {
  switch (frequency) {
    case Frequency.YEAR:
      return year.toString();
    case Frequency.QUARTER:
      return `${year.toString()}-Q${subPeriod.toString()}`;
    case Frequency.MONTH:
      return `${year.toString()}-${subPeriod.toString().padStart(2, '0')}`;
    default:
      // This should never happen due to type safety, but provides a fallback
      return year.toString();
  }
}

/**
 * Calculates the label for the previous period.
 * Useful for growth calculations.
 *
 * @param currentLabel - The current period label (e.g. "2023-Q1")
 * @param frequency - The frequency
 * @returns The label of the previous period, or null if parsing fails.
 */
export function getPreviousPeriodLabel(currentLabel: string, frequency: Frequency): string | null {
  if (frequency === Frequency.YEAR) {
    const year = parseInt(currentLabel, 10);
    return isNaN(year) ? null : (year - 1).toString();
  }

  if (frequency === Frequency.QUARTER) {
    // Format: YYYY-Qx
    const match = /^(\d{4})-Q(\d)$/.exec(currentLabel);
    if (match !== null) {
      const yearStr = match[1];
      const qStr = match[2];

      if (yearStr !== undefined && qStr !== undefined) {
        const year = parseInt(yearStr, 10);
        const q = parseInt(qStr, 10);
        if (q === 1) return `${(year - 1).toString()}-Q4`;
        return `${year.toString()}-Q${(q - 1).toString()}`;
      }
    }
  }

  if (frequency === Frequency.MONTH) {
    // Format: YYYY-MM
    const match = /^(\d{4})-(\d{2})$/.exec(currentLabel);
    if (match !== null) {
      const yearStr = match[1];
      const mStr = match[2];

      if (yearStr !== undefined && mStr !== undefined) {
        const year = parseInt(yearStr, 10);
        const m = parseInt(mStr, 10);
        if (m === 1) return `${(year - 1).toString()}-12`;
        return `${year.toString()}-${(m - 1).toString().padStart(2, '0')}`;
      }
    }
  }

  return null;
}

/**
 * Extracts the year from a standard period label.
 */
export function parseYearFromLabel(label: string): number | null {
  // Assumes standard format YYYY...
  if (label.length < 4) return null;
  const year = parseInt(label.substring(0, 4), 10);
  return isNaN(year) ? null : year;
}
