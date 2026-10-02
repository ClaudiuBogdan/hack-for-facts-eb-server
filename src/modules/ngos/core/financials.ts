import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import type {
  NgoFinancialIndicator,
  NgoFinancialQuality,
  NgoFinancialQualityReasonCode,
} from './organization-types.js';

/** Every MFP NGO resource dictionary publishes exactly I1..I46 (scraper MFP NGO loader). */
export const NGO_FINANCIAL_INDICATOR_COUNT = 46;

const IndicatorDefinitionsSchema = Type.Array(
  Type.Object({ code: Type.String({ pattern: '^I[1-9][0-9]?$' }), name: Type.String() }),
  { minItems: NGO_FINANCIAL_INDICATOR_COUNT, maxItems: NGO_FINANCIAL_INDICATOR_COUNT }
);
/** Exact signed integer strings as retained by the MFP parser; blanks are absent keys. */
const IndicatorValuesSchema = Type.Record(Type.String(), Type.String({ pattern: '^-?[0-9]+$' }));

const codeNumber = (code: string): number => Number.parseInt(code.slice(1), 10);

/**
 * Binds one statement's values to its own resource dictionary, in numeric code order.
 * Labels are the verbatim dictionary `name`; values are never parsed or canonicalized.
 */
export const mapFinancialIndicators = (
  definitions: unknown,
  values: unknown
): Result<readonly NgoFinancialIndicator[], string> => {
  if (!Value.Check(IndicatorDefinitionsSchema, definitions))
    return err('indicator definitions do not match the 46-position dictionary shape');
  if (!Value.Check(IndicatorValuesSchema, values))
    return err('indicator values are not exact integer strings');
  const ordered = [...definitions].sort((a, b) => codeNumber(a.code) - codeNumber(b.code));
  if (ordered.some((definition, index) => codeNumber(definition.code) !== index + 1))
    return err('indicator definitions must be exactly I1..I46');
  const known = new Set(ordered.map((definition) => definition.code));
  const unknown = Object.keys(values).find((code) => !known.has(code));
  if (unknown !== undefined) return err(`indicator ${unknown} is not in the statement dictionary`);
  return ok(
    ordered.map((definition) => ({
      code: definition.code,
      label: definition.name,
      value: values[definition.code] ?? null,
    }))
  );
};

/** Measured on the retained FY2016–2025 MFP NGO originals, 2026-10-02; review on refresh. */
export const NGO_REVENUE_REVIEW_THRESHOLD_RON = '1000000000';
export const NGO_FINANCIAL_QUALITY_RULE_VERSION = 'ngo-revenue-v1';

/**
 * Qualified FY2008–2025 dictionaries keep these positions' meanings. FY2021–2023
 * reuse 2020 labels; FY2025 reuses 2024 labels. Future/changed dictionaries remain
 * unsupported. A match is a review signal, not proof of an incorrect filing.
 * Missing cells do not match a rule and are never converted to zero.
 */
export const assessNgoFinancialQuality = (
  fiscalYear: number,
  indicators: readonly NgoFinancialIndicator[]
): NgoFinancialQuality => {
  const assets = indicators.find(({ code }) => code === 'I1');
  const revenue = indicators.find(({ code }) => code === 'I38');
  const labelYear = fiscalYear >= 2024 ? 2024 : fiscalYear >= 2020 ? 2020 : fiscalYear;
  const assetLabel =
    fiscalYear >= 2024 ? 'Active imobilizate  -  total' : 'A. Active imobilizate  -  total';
  if (
    !Number.isInteger(fiscalYear) ||
    fiscalYear < 2008 ||
    fiscalYear > 2025 ||
    assets?.label !== assetLabel ||
    revenue?.label !== `Venituri totale - la 31.12.${String(labelYear)}`
  )
    return {
      ruleVersion: NGO_FINANCIAL_QUALITY_RULE_VERSION,
      assessment: 'unsupported',
      suspected: null,
      reasons: [],
    };

  // The mapper already validates these strings; this check also makes this pure
  // function safe for direct callers without ever throwing from BigInt().
  const integer = (value: string | null | undefined): bigint | null =>
    value !== null && value !== undefined && /^-?[0-9]+$/u.test(value) ? BigInt(value) : null;
  const revenueValue = integer(revenue.value);
  const assetsValue = integer(assets.value);
  const reasons: { code: NgoFinancialQualityReasonCode; detail: string }[] = [];
  if (revenueValue !== null && revenueValue > BigInt(NGO_REVENUE_REVIEW_THRESHOLD_RON))
    reasons.push({
      code: 'IMPLAUSIBLE_REVENUE',
      detail: `I38 = ${String(revenueValue)} lei > ${NGO_REVENUE_REVIEW_THRESHOLD_RON} lei`,
    });
  if (
    revenueValue !== null &&
    assetsValue !== null &&
    revenueValue > 0n &&
    assetsValue > 0n &&
    revenueValue === assetsValue
  )
    reasons.push({
      code: 'REVENUE_EQUALS_FIXED_ASSETS',
      detail: `I38 = I1 = ${String(revenueValue)} lei`,
    });
  return {
    ruleVersion: NGO_FINANCIAL_QUALITY_RULE_VERSION,
    assessment: 'assessed',
    suspected: reasons.length > 0,
    reasons,
  };
};
