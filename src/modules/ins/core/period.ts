import { Frequency } from '@/common/types/temporal.js';

import type { PeriodDate, ReportPeriodInput } from '@/common/types/analytics.js';

export function parsePeriodDateToInput(period: unknown): ReportPeriodInput | null {
  if (typeof period !== 'string') {
    return null;
  }

  const trimmedPeriod = period.trim();
  if (trimmedPeriod === '') {
    return null;
  }

  if (/^\d{4}$/.test(trimmedPeriod)) {
    const date = trimmedPeriod as PeriodDate;
    return {
      type: Frequency.YEAR,
      selection: {
        interval: {
          start: date,
          end: date,
        },
      },
    };
  }

  if (/^\d{4}-Q[1-4]$/.test(trimmedPeriod)) {
    const date = trimmedPeriod as PeriodDate;
    return {
      type: Frequency.QUARTER,
      selection: {
        interval: {
          start: date,
          end: date,
        },
      },
    };
  }

  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(trimmedPeriod)) {
    const date = trimmedPeriod as PeriodDate;
    return {
      type: Frequency.MONTH,
      selection: {
        interval: {
          start: date,
          end: date,
        },
      },
    };
  }

  return null;
}
