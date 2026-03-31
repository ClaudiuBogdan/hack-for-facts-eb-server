import { Decimal } from 'decimal.js';

import type { DecimalString, SupportedLanguage } from '../../core/types.js';

const LOCALES: Record<SupportedLanguage, string> = {
  ro: 'ro-RO',
  en: 'en-US',
};

const COMPACT_UNITS: Record<
  SupportedLanguage,
  { billions: string; millions: string; thousands: string }
> = {
  ro: {
    billions: 'mld.',
    millions: 'mil.',
    thousands: 'mii',
  },
  en: {
    billions: 'B',
    millions: 'M',
    thousands: 'K',
  },
};

export const toDecimal = (value: DecimalString): Decimal => new Decimal(value);

const getDecimalSeparator = (lang: SupportedLanguage): string => {
  const decimalPart = new Intl.NumberFormat(LOCALES[lang], {
    minimumFractionDigits: 1,
  })
    .formatToParts(1.1)
    .find((part) => part.type === 'decimal');

  return decimalPart?.value ?? '.';
};

const formatGroupedDecimal = (
  decimal: Decimal,
  lang: SupportedLanguage,
  maximumFractionDigits: number
): string => {
  const rounded = decimal.toDecimalPlaces(maximumFractionDigits, Decimal.ROUND_HALF_UP);
  const absolute = rounded.abs();
  const [integerPart = '0', fractionPart = ''] = absolute.toFixed(maximumFractionDigits).split('.');
  const trimmedFraction = fractionPart.replace(/0+$/u, '');
  const groupedInteger = new Intl.NumberFormat(LOCALES[lang], {
    maximumFractionDigits: 0,
  }).format(BigInt(integerPart));
  const sign = rounded.isNegative() ? '-' : '';

  if (trimmedFraction === '') {
    return `${sign}${groupedInteger}`;
  }

  return `${sign}${groupedInteger}${getDecimalSeparator(lang)}${trimmedFraction}`;
};

const formatIntegerCurrency = (
  decimal: Decimal,
  currency: string,
  lang: SupportedLanguage
): string => {
  const rounded = decimal.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);

  return new Intl.NumberFormat(LOCALES[lang], {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(BigInt(rounded));
};

export const formatFixedDecimal = (
  value: DecimalString,
  fractionDigits: number,
  lang: SupportedLanguage
): string => {
  const decimal = toDecimal(value);
  const fixed = decimal.toFixed(fractionDigits);
  return lang === 'ro' ? fixed.replace('.', ',') : fixed;
};

export const formatCompactCurrency = (
  value: DecimalString,
  currency: string,
  lang: SupportedLanguage
): string => {
  const decimal = toDecimal(value);
  const absolute = decimal.abs();
  const units = COMPACT_UNITS[lang];

  if (absolute.greaterThanOrEqualTo('1000000000')) {
    return `${formatFixedDecimal(decimal.div('1000000000').toString(), 2, lang)} ${units.billions} ${currency}`;
  }

  if (absolute.greaterThanOrEqualTo('1000000')) {
    return `${formatFixedDecimal(decimal.div('1000000').toString(), 2, lang)} ${units.millions} ${currency}`;
  }

  if (absolute.greaterThanOrEqualTo('1000')) {
    return `${formatFixedDecimal(decimal.div('1000').toString(), 2, lang)} ${units.thousands} ${currency}`;
  }

  return new Intl.NumberFormat(LOCALES[lang], {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(BigInt(decimal.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0)));
};

export const formatCurrency = (
  value: DecimalString,
  currency: string,
  lang: SupportedLanguage
): string => {
  return formatIntegerCurrency(toDecimal(value), currency, lang);
};

export const formatPercentage = (
  value: DecimalString,
  lang: SupportedLanguage,
  fractionDigits = 1
): string => {
  return `${formatFixedDecimal(value, fractionDigits, lang)}%`;
};

export const formatAbsolutePercentage = (
  value: DecimalString,
  lang: SupportedLanguage,
  fractionDigits = 1
): string => {
  return formatPercentage(toDecimal(value).abs().toString(), lang, fractionDigits);
};

export const clampPercentage = (value: DecimalString): number => {
  const decimal = toDecimal(value);

  if (decimal.lessThan(0)) {
    return 0;
  }

  if (decimal.greaterThan(100)) {
    return 100;
  }

  return decimal.toNumber();
};

export const formatNumberWithUnit = (
  value: DecimalString,
  unit: string,
  lang: SupportedLanguage
): string => {
  return `${formatGroupedDecimal(toDecimal(value), lang, 2)} ${unit}`;
};
