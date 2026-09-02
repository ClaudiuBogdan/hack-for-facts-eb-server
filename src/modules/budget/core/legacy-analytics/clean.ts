/**
 * `AnalyticsFilterInput` → `LegacyAggregateQuery` (the compatibility manifest,
 * program §2 item 2 + Appendix A), field by field:
 *
 *  - `null` / absent / `[]` ⇒ no predicate (legacy `hasValues`; the kernel's
 *    `in: []` → FALSE rule must NOT apply on these roots);
 *  - `account_category` required (prunes L3); `report_type` optional — omitted
 *    sums ALL execution report types (kept); a COMMITMENT_* literal is rejected
 *    as legacy did (`toAnalyticsInput` threw);
 *  - `[ID!]` ids must be non-negative integers. DELTA: legacy `toNumericIds`
 *    silently DROPPED non-numeric ids (an id list of `['abc']` became "no
 *    filter" and widened the result); here it is `InvalidInput`;
 *  - amounts travel as decimal STRINGS so SQL compares `numeric` to `numeric`;
 *  - `aggregate_min/max_amount` are carried (legacy accepted and ignored them —
 *    the repo applies them as HAVING, a documented delta);
 *  - every `exclude.*` field is carried (legacy ignored main_creditor_cui,
 *    funding_source_ids, budget_sector_ids, expense_types, program_codes).
 */

import { err, ok, type Result } from 'neverthrow';

import { legacyDecimal } from './decimal.js';
import { planPeriod } from './period.js';
import { groupTagsByFacet, validateTags } from './tags.js';
import {
  COMMITMENT_REPORT_TYPE_FROM_LABEL,
  EXECUTION_REPORT_TYPE_FROM_LABEL,
} from '../constants.js';

import type {
  CleanExclude,
  LegacyAggregateQuery,
  LegacyAnalyticsExclude,
  LegacyAnalyticsFilter,
  Maybe,
} from './types.js';
import type { ApiError } from '@/modules/shared/index.js';

const invalid = (message: string, field: string): ApiError => ({
  type: 'InvalidInput',
  message,
  field,
});

const list = <T>(v: Maybe<readonly T[]>): readonly T[] | undefined => {
  if (v === null || v === undefined) return undefined;
  return v.length === 0 ? undefined : v;
};

const text = (v: Maybe<string>): string | undefined => v ?? undefined;

const INTEGER_ID = /^\d+$/u;

const ids = (
  v: Maybe<readonly string[]>,
  field: string
): Result<readonly number[] | undefined, ApiError> => {
  const values = list(v);
  if (values === undefined) return ok(undefined);
  const out: number[] = [];
  for (const raw of values) {
    const s = raw.trim();
    if (!INTEGER_ID.test(s)) {
      return err(invalid(`${field} must contain integer ids; got '${raw}'`, field));
    }
    out.push(Number.parseInt(s, 10));
  }
  return ok(out);
};

/** A GraphQL `Float`/`Int` → exact decimal string (the double's shortest repr). */
const amount = (v: Maybe<number>): string | undefined => {
  if (v === null || v === undefined || !Number.isFinite(v)) return undefined;
  return legacyDecimal(v).toString();
};

const bounded = (v: Maybe<number>): number | undefined =>
  v === null || v === undefined || !Number.isFinite(v) ? undefined : v;

const cleanExclude = (
  ex: Maybe<LegacyAnalyticsExclude>
): Result<CleanExclude | undefined, ApiError> => {
  if (ex === null || ex === undefined) return ok(undefined);
  const fundingSourceIds = ids(ex.funding_source_ids, 'exclude.funding_source_ids');
  if (fundingSourceIds.isErr()) return err(fundingSourceIds.error);
  const budgetSectorIds = ids(ex.budget_sector_ids, 'exclude.budget_sector_ids');
  if (budgetSectorIds.isErr()) return err(budgetSectorIds.error);
  const uatIds = ids(ex.uat_ids, 'exclude.uat_ids');
  if (uatIds.isErr()) return err(uatIds.error);
  const rawTags = list(ex.tags);
  if (rawTags !== undefined) {
    const valid = validateTags(rawTags, 'exclude.tags');
    if (valid.isErr()) return err(valid.error);
  }

  const reportIds = list(ex.report_ids);
  const entityCuis = list(ex.entity_cuis);
  const mainCreditorCui = text(ex.main_creditor_cui);
  const functionalCodes = list(ex.functional_codes);
  const functionalPrefixes = list(ex.functional_prefixes);
  const economicCodes = list(ex.economic_codes);
  const economicPrefixes = list(ex.economic_prefixes);
  const expenseTypes = list(ex.expense_types);
  const programCodes = list(ex.program_codes);
  const countyCodes = list(ex.county_codes);
  const regions = list(ex.regions);
  const entityTypes = list(ex.entity_types);
  const tags = rawTags === undefined ? undefined : [...new Set(rawTags)];

  const out: CleanExclude = {
    ...(reportIds !== undefined && { reportIds }),
    ...(entityCuis !== undefined && { entityCuis }),
    ...(mainCreditorCui !== undefined && { mainCreditorCui }),
    ...(functionalCodes !== undefined && { functionalCodes }),
    ...(functionalPrefixes !== undefined && { functionalPrefixes }),
    ...(economicCodes !== undefined && { economicCodes }),
    ...(economicPrefixes !== undefined && { economicPrefixes }),
    ...(fundingSourceIds.value !== undefined && { fundingSourceIds: fundingSourceIds.value }),
    ...(budgetSectorIds.value !== undefined && { budgetSectorIds: budgetSectorIds.value }),
    ...(expenseTypes !== undefined && { expenseTypes }),
    ...(programCodes !== undefined && { programCodes }),
    ...(countyCodes !== undefined && { countyCodes }),
    ...(regions !== undefined && { regions }),
    ...(uatIds.value !== undefined && { uatIds: uatIds.value }),
    ...(entityTypes !== undefined && { entityTypes }),
    ...(tags !== undefined && { tags }),
  };
  return ok(Object.keys(out).length === 0 ? undefined : out);
};

export const cleanFilter = (f: LegacyAnalyticsFilter): Result<LegacyAggregateQuery, ApiError> => {
  // `account_category` / `report_period.type` are closed GraphQL enums — the
  // schema rejects anything outside 'vn'|'ch' / MONTH|QUARTER|YEAR before here.
  const frequency = f.report_period.type;

  const reportLiteral = text(f.report_type);
  let reportType: string | null = null;
  if (reportLiteral !== undefined) {
    if (COMMITMENT_REPORT_TYPE_FROM_LABEL.has(reportLiteral)) {
      return err(
        invalid(
          'ReportType COMMITMENT_* is not supported for execution analytics. Use Commitments queries.',
          'report_type'
        )
      );
    }
    if (!EXECUTION_REPORT_TYPE_FROM_LABEL.has(reportLiteral)) {
      return err(invalid(`unknown report_type '${reportLiteral}'`, 'report_type'));
    }
    reportType = reportLiteral;
  }

  const period = planPeriod(f.report_period.selection, frequency);
  if (period.isErr()) return err(period.error);

  const fundingSourceIds = ids(f.funding_source_ids, 'funding_source_ids');
  if (fundingSourceIds.isErr()) return err(fundingSourceIds.error);
  const budgetSectorIds = ids(f.budget_sector_ids, 'budget_sector_ids');
  if (budgetSectorIds.isErr()) return err(budgetSectorIds.error);
  const uatIds = ids(f.uat_ids, 'uat_ids');
  if (uatIds.isErr()) return err(uatIds.error);

  let tagFacets: readonly (readonly string[])[] | undefined;
  const tags = list(f.tags);
  if (tags !== undefined) {
    const valid = validateTags(tags, 'tags');
    if (valid.isErr()) return err(valid.error);
    tagFacets = groupTagsByFacet(tags);
  }

  const exclude = cleanExclude(f.exclude);
  if (exclude.isErr()) return err(exclude.error);

  const mainCreditorCui = text(f.main_creditor_cui);
  const reportIds = list(f.report_ids);
  const entityCuis = list(f.entity_cuis);
  const functionalCodes = list(f.functional_codes);
  const functionalPrefixes = list(f.functional_prefixes);
  const economicCodes = list(f.economic_codes);
  const economicPrefixes = list(f.economic_prefixes);
  const expenseTypes = list(f.expense_types);
  const programCodes = list(f.program_codes);
  const countyCodes = list(f.county_codes);
  const regions = list(f.regions);
  const entityTypes = list(f.entity_types);
  const isUat = f.is_uat ?? undefined;
  const trimmedSearch = text(f.search)?.trim();
  const search = trimmedSearch === undefined || trimmedSearch === '' ? undefined : trimmedSearch;
  const minPopulation = bounded(f.min_population);
  const maxPopulation = bounded(f.max_population);
  const itemMinAmount = amount(f.item_min_amount);
  const itemMaxAmount = amount(f.item_max_amount);
  const aggregateMinAmount = amount(f.aggregate_min_amount);
  const aggregateMaxAmount = amount(f.aggregate_max_amount);

  const q: LegacyAggregateQuery = {
    frequency,
    accountCategory: f.account_category,
    reportType,
    period: period.value,
    ...(mainCreditorCui !== undefined && { mainCreditorCui }),
    ...(reportIds !== undefined && { reportIds }),
    ...(entityCuis !== undefined && { entityCuis }),
    ...(functionalCodes !== undefined && { functionalCodes }),
    ...(functionalPrefixes !== undefined && { functionalPrefixes }),
    ...(economicCodes !== undefined && { economicCodes }),
    ...(economicPrefixes !== undefined && { economicPrefixes }),
    ...(fundingSourceIds.value !== undefined && { fundingSourceIds: fundingSourceIds.value }),
    ...(budgetSectorIds.value !== undefined && { budgetSectorIds: budgetSectorIds.value }),
    ...(expenseTypes !== undefined && { expenseTypes }),
    ...(programCodes !== undefined && { programCodes }),
    ...(countyCodes !== undefined && { countyCodes }),
    ...(regions !== undefined && { regions }),
    ...(uatIds.value !== undefined && { uatIds: uatIds.value }),
    ...(entityTypes !== undefined && { entityTypes }),
    ...(isUat !== undefined && { isUat }),
    ...(search !== undefined && { search }),
    ...(tagFacets !== undefined && { tagFacets }),
    ...(minPopulation !== undefined && { minPopulation }),
    ...(maxPopulation !== undefined && { maxPopulation }),
    ...(itemMinAmount !== undefined && { itemMinAmount }),
    ...(itemMaxAmount !== undefined && { itemMaxAmount }),
    ...(aggregateMinAmount !== undefined && { aggregateMinAmount }),
    ...(aggregateMaxAmount !== undefined && { aggregateMaxAmount }),
    ...(exclude.value !== undefined && { exclude: exclude.value }),
  };
  return ok(q);
};
