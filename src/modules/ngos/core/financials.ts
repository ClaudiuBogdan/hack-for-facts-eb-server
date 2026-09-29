import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import type { NgoFinancialIndicator } from './organization-types.js';

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
