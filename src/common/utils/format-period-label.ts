export type PeriodLabelType = 'monthly' | 'quarterly' | 'yearly';

export const formatPeriodLabel = (periodKey: string, periodType: PeriodLabelType): string => {
  const parts = periodKey.split('-');
  const year = parts[0] ?? periodKey;

  switch (periodType) {
    case 'monthly': {
      const monthIndex = Number.parseInt(parts[1] ?? '1', 10) - 1;
      const yearValue = Number.parseInt(year, 10);

      if (
        Number.isNaN(monthIndex) ||
        Number.isNaN(yearValue) ||
        monthIndex < 0 ||
        monthIndex > 11
      ) {
        return periodKey;
      }

      return new Intl.DateTimeFormat('ro-RO', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(Date.UTC(yearValue, monthIndex, 1)));
    }
    case 'quarterly':
      return `${parts[1] ?? 'Q1'} ${year}`;
    case 'yearly':
      return year;
    default:
      return periodKey;
  }
};
