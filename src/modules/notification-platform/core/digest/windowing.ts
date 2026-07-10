import type { DigestWindow } from './types.js';

export const DIGEST_EMAIL_MAX_ITEMS = 20;

const DIGEST_TIME_ZONE = 'Europe/Bucharest';
const DISPATCH_HOUR = 8;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface ZonedDateTimeParts extends CalendarDate {
  hour: number;
  minute: number;
  second: number;
}

const ZONED_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: DIGEST_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const getNumericPart = (parts: Intl.DateTimeFormatPart[], type: string): number => {
  const value = parts.find((part) => part.type === type)?.value;
  return value === undefined ? 0 : Number(value);
};

const getZonedParts = (date: Date): ZonedDateTimeParts => {
  const parts = ZONED_FORMATTER.formatToParts(date);
  return {
    year: getNumericPart(parts, 'year'),
    month: getNumericPart(parts, 'month'),
    day: getNumericPart(parts, 'day'),
    hour: getNumericPart(parts, 'hour'),
    minute: getNumericPart(parts, 'minute'),
    second: getNumericPart(parts, 'second'),
  };
};

const addCalendarDays = (date: CalendarDate, days: number): CalendarDate => {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
};

const zonedLocalToUtc = (date: CalendarDate, hour: number): Date => {
  const intendedAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour);
  let candidate = intendedAsUtc;

  for (let pass = 0; pass < 2; pass += 1) {
    const actualLocal = getZonedParts(new Date(candidate));
    const actualLocalAsUtc = Date.UTC(
      actualLocal.year,
      actualLocal.month - 1,
      actualLocal.day,
      actualLocal.hour,
      actualLocal.minute,
      actualLocal.second
    );
    candidate = intendedAsUtc - (actualLocalAsUtc - candidate);
  }

  return new Date(candidate);
};

const isBeforeDispatch = (parts: ZonedDateTimeParts): boolean => {
  return parts.hour < DISPATCH_HOUR;
};

const dailyWindowStart = (at: ZonedDateTimeParts): CalendarDate => {
  const localDate = { year: at.year, month: at.month, day: at.day };
  return isBeforeDispatch(at) ? addCalendarDays(localDate, -1) : localDate;
};

const weeklyWindowStart = (at: ZonedDateTimeParts): CalendarDate => {
  const localDate = { year: at.year, month: at.month, day: at.day };
  const dayOfWeek = new Date(Date.UTC(at.year, at.month - 1, at.day)).getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const currentMonday = addCalendarDays(localDate, -daysSinceMonday);
  const beforeMondayDispatch = daysSinceMonday === 0 && isBeforeDispatch(at);
  return beforeMondayDispatch ? addCalendarDays(currentMonday, -7) : currentMonday;
};

export const computeDigestWindow = (cadence: 'daily' | 'weekly', at: Date): DigestWindow => {
  const localAt = getZonedParts(at);
  const windowStartDate =
    cadence === 'daily' ? dailyWindowStart(localAt) : weeklyWindowStart(localAt);
  const windowEndDate = addCalendarDays(windowStartDate, cadence === 'daily' ? 1 : 7);
  const windowStartUtc = zonedLocalToUtc(windowStartDate, DISPATCH_HOUR);
  const windowEndUtc = zonedLocalToUtc(windowEndDate, DISPATCH_HOUR);

  return {
    windowStartUtc,
    windowEndUtc,
    dispatchAtUtc: new Date(windowEndUtc.getTime()),
  };
};
