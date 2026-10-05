/**
 * National budget — validated law (approved budget) root inputs.
 *
 * Mirrors the v3 SDL inputs exactly. Omitted optional filters stay `null`,
 * meaning the documented default scope resolved against the catalog by the
 * usecase ("all loaded editions", "applicable funds", ...); no default is
 * inferred here beyond the SDL's own `unit = THOUSAND_LEI`.
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import { TOTAL_DEFINITIONS } from './descriptors.js';
import {
  authorityCodeValue,
  codeValue,
  declaredOrder,
  editionIdValue,
  enumValue,
  idValue,
  isPresent,
  objectWithKeys,
  oneOfMember,
  optionalList,
  requiredList,
  yearValue,
  type EditionKey,
} from './input-rules.js';
import { validateReportPeriod, type PeriodPlan } from './periods.js';
import {
  APPROVED_FORMS,
  APPROVED_MEASURES,
  APPROVED_UNITS,
  BUDGET_FUNDS,
  CREDIT_TYPES,
  REVENUE_HOLDER_AUTHORITY_CODE,
  ROW_ROLES,
  TOTAL_KEYS,
  AUTHORITY_DETAIL_FORM,
  type ApprovedForm,
  type ApprovedMeasure,
  type ApprovedUnit,
  type BudgetFund,
  type CreditType,
  type RowRole,
  type TotalKey,
} from './vocabulary.js';

export const MAX_TOTAL_KEYS = 5;
export const MAX_EDITION_IDS = 20;
export const MAX_TARGET_YEARS = 10;
export const MAX_AUTHORITY_CODES = 100;
export const MAX_CAPITOLS = 50;
export const MAX_SERIES_YEARS = 20;

const editionList = {
  max: MAX_EDITION_IDS,
  item: editionIdValue,
  sortKey: (e: EditionKey) => e.id,
};
const fundList = {
  max: BUDGET_FUNDS.length,
  item: enumValue(BUDGET_FUNDS),
  sortKey: declaredOrder(BUDGET_FUNDS),
};
const creditList = {
  max: CREDIT_TYPES.length,
  item: enumValue(CREDIT_TYPES),
  sortKey: declaredOrder(CREDIT_TYPES),
};

const unitOf = (value: unknown, field: string): Result<ApprovedUnit, ApiError> =>
  isPresent(value) ? enumValue(APPROVED_UNITS)(value, field) : ok('THOUSAND_LEI');

const notRevenueHolder = (code: string, field: string): Result<string, ApiError> =>
  code === REVENUE_HOLDER_AUTHORITY_CODE
    ? err(invalidInput(`${field}: code 999 is the revenue holder, not an authority`, field))
    : ok(code);

// ── budgetApprovedTotals ─────────────────────────────────────────────────────

export interface ApprovedTotalsQuery {
  readonly totals: readonly TotalKey[];
  /** Null iff every requested total is a revenue descriptor. */
  readonly creditTypes: readonly CreditType[] | null;
  /** Null = all loaded editions. */
  readonly editionIds: readonly EditionKey[] | null;
  /** Null = every fund applicable to each requested total. */
  readonly funds: readonly BudgetFund[] | null;
  /** Null = all loaded slots. */
  readonly measureYears: readonly number[] | null;
  readonly measures: readonly ApprovedMeasure[] | null;
  /** Null = every authority of each edition except 999 (authority total only). */
  readonly authorityCodes: readonly string[] | null;
  readonly unit: ApprovedUnit;
}

export const validateApprovedTotalsInput = (
  raw: unknown
): Result<ApprovedTotalsQuery, ApiError> => {
  const input = objectWithKeys(raw, 'input', [
    'totals',
    'creditTypes',
    'editionIds',
    'funds',
    'measureYears',
    'measures',
    'authorityCodes',
    'unit',
  ]);
  if (input.isErr()) return err(input.error);
  const v = input.value;

  const totals = requiredList(v['totals'], 'input.totals', {
    max: MAX_TOTAL_KEYS,
    item: enumValue(TOTAL_KEYS),
    sortKey: declaredOrder(TOTAL_KEYS),
  });
  if (totals.isErr()) return err(totals.error);
  const anyCredit = totals.value.some((key) => TOTAL_DEFINITIONS[key].requiresCreditType);

  const creditTypes = optionalList(v['creditTypes'], 'input.creditTypes', creditList);
  if (creditTypes.isErr()) return err(creditTypes.error);
  if (anyCredit && creditTypes.value === null) {
    return err(
      invalidInput(
        'input.creditTypes is required when a credit total is requested',
        'input.creditTypes'
      )
    );
  }
  if (!anyCredit && creditTypes.value !== null) {
    return err(
      invalidInput('input.creditTypes is not allowed for revenue-only totals', 'input.creditTypes')
    );
  }

  const editionIds = optionalList(v['editionIds'], 'input.editionIds', editionList);
  if (editionIds.isErr()) return err(editionIds.error);

  const funds = optionalList(v['funds'], 'input.funds', fundList);
  if (funds.isErr()) return err(funds.error);
  const fundFilter = funds.value;
  if (fundFilter !== null) {
    const orphan = totals.value.find((key) =>
      TOTAL_DEFINITIONS[key].funds.every((fund) => !fundFilter.includes(fund))
    );
    if (orphan !== undefined) {
      return err(invalidInput(`input.funds excludes every fund of total ${orphan}`, 'input.funds'));
    }
  }

  const measureYears = optionalList(v['measureYears'], 'input.measureYears', {
    max: MAX_TARGET_YEARS,
    item: yearValue,
    sortKey: (year: number) => year,
  });
  if (measureYears.isErr()) return err(measureYears.error);

  const measures = optionalList(v['measures'], 'input.measures', {
    max: APPROVED_MEASURES.length,
    item: enumValue(APPROVED_MEASURES),
    sortKey: declaredOrder(APPROVED_MEASURES),
  });
  if (measures.isErr()) return err(measures.error);

  const authorityCodes = optionalList(v['authorityCodes'], 'input.authorityCodes', {
    max: MAX_AUTHORITY_CODES,
    item: (value, field) =>
      authorityCodeValue(value, field).andThen((c) => notRevenueHolder(c, field)),
    sortKey: (code: string) => code,
  });
  if (authorityCodes.isErr()) return err(authorityCodes.error);
  if (authorityCodes.value !== null && !totals.value.includes('AUTHORITY_EXPENDITURE_5001')) {
    return err(
      invalidInput(
        'input.authorityCodes requires the AUTHORITY_EXPENDITURE_5001 total',
        'input.authorityCodes'
      )
    );
  }

  const unit = unitOf(v['unit'], 'input.unit');
  if (unit.isErr()) return err(unit.error);

  return ok({
    totals: totals.value,
    creditTypes: creditTypes.value,
    editionIds: editionIds.value,
    funds: funds.value,
    measureYears: measureYears.value,
    measures: measures.value,
    authorityCodes: authorityCodes.value,
    unit: unit.value,
  });
};

// ── budgetApprovedSeries ─────────────────────────────────────────────────────

export type ApprovedSeriesAxis =
  | { readonly kind: 'TARGET_YEARS_OF_EDITION'; readonly edition: EditionKey }
  | {
      readonly kind: 'EDITIONS_FOR_TARGET';
      readonly targetYear: number;
      /** Null = all loaded candidate editions. */
      readonly editionIds: readonly EditionKey[] | null;
    }
  | { readonly kind: 'OWN_YEAR_APPROVALS'; readonly editionIds: readonly EditionKey[] | null };

export interface ApprovedSeriesQuery {
  readonly axis: ApprovedSeriesAxis;
  readonly fund: BudgetFund;
  readonly total: TotalKey;
  /** Required for credit totals, null for revenue. */
  readonly creditType: CreditType | null;
  /** Required for the authority total, null otherwise. */
  readonly authorityCode: string | null;
  /** YEAR labels; the chart date's meaning depends on the axis. */
  readonly period: PeriodPlan;
  readonly unit: ApprovedUnit;
}

const AXIS_KEYS = ['targetYearsOfEdition', 'editionsForTarget', 'ownYearApprovals'] as const;

/** Edition-axis candidates: at most one explicit edition per budget year. */
const axisEditionIds = (
  value: unknown,
  field: string
): Result<readonly EditionKey[] | null, ApiError> =>
  optionalList(value, field, editionList).andThen((list) => {
    if (list === null) return ok(list);
    const years = new Set<number>();
    for (const edition of list) {
      if (years.has(edition.budgetYear)) {
        return err(
          invalidInput(
            `${field} lists two editions for budget year ${String(edition.budgetYear)}`,
            field
          )
        );
      }
      years.add(edition.budgetYear);
    }
    return ok(list);
  });

const validateAxis = (raw: unknown): Result<ApprovedSeriesAxis, ApiError> => {
  const member = oneOfMember(raw, 'input.axis', AXIS_KEYS);
  if (member.isErr()) return err(member.error);
  const { key, value } = member.value;
  const field = `input.axis.${key}`;
  switch (key) {
    case 'targetYearsOfEdition':
      return editionIdValue(value, field).map((edition) => ({
        kind: 'TARGET_YEARS_OF_EDITION' as const,
        edition,
      }));
    case 'editionsForTarget': {
      const body = objectWithKeys(value, field, ['targetYear', 'editionIds']);
      if (body.isErr()) return err(body.error);
      const targetYear = yearValue(body.value['targetYear'], `${field}.targetYear`);
      if (targetYear.isErr()) return err(targetYear.error);
      return axisEditionIds(body.value['editionIds'], `${field}.editionIds`).map((editionIds) => ({
        kind: 'EDITIONS_FOR_TARGET' as const,
        targetYear: targetYear.value,
        editionIds,
      }));
    }
    case 'ownYearApprovals': {
      const body = objectWithKeys(value, field, ['editionIds']);
      if (body.isErr()) return err(body.error);
      return axisEditionIds(body.value['editionIds'], `${field}.editionIds`).map((editionIds) => ({
        kind: 'OWN_YEAR_APPROVALS' as const,
        editionIds,
      }));
    }
  }
};

export const validateApprovedSeriesInput = (
  raw: unknown
): Result<ApprovedSeriesQuery, ApiError> => {
  const input = objectWithKeys(raw, 'input', [
    'axis',
    'fund',
    'total',
    'creditType',
    'authorityCode',
    'period',
    'unit',
  ]);
  if (input.isErr()) return err(input.error);
  const v = input.value;

  const axis = validateAxis(v['axis']);
  if (axis.isErr()) return err(axis.error);
  const fund = enumValue(BUDGET_FUNDS)(v['fund'], 'input.fund');
  if (fund.isErr()) return err(fund.error);
  const total = enumValue(TOTAL_KEYS)(v['total'], 'input.total');
  if (total.isErr()) return err(total.error);
  const definition = TOTAL_DEFINITIONS[total.value];
  if (!definition.funds.includes(fund.value)) {
    return err(
      invalidInput(`input.total ${total.value} does not exist for fund ${fund.value}`, 'input.fund')
    );
  }

  let creditType: CreditType | null = null;
  if (definition.requiresCreditType) {
    if (!isPresent(v['creditType'])) {
      return err(
        invalidInput('input.creditType is required for a credit total', 'input.creditType')
      );
    }
    const checked = enumValue(CREDIT_TYPES)(v['creditType'], 'input.creditType');
    if (checked.isErr()) return err(checked.error);
    creditType = checked.value;
  } else if (isPresent(v['creditType'])) {
    return err(
      invalidInput('input.creditType is not allowed for a revenue total', 'input.creditType')
    );
  }

  let authorityCode: string | null = null;
  if (definition.scope === 'AUTHORITY') {
    if (!isPresent(v['authorityCode'])) {
      return err(
        invalidInput(
          'input.authorityCode is required for AUTHORITY_EXPENDITURE_5001',
          'input.authorityCode'
        )
      );
    }
    const checked = authorityCodeValue(v['authorityCode'], 'input.authorityCode').andThen((code) =>
      notRevenueHolder(code, 'input.authorityCode')
    );
    if (checked.isErr()) return err(checked.error);
    if (axis.value.kind !== 'TARGET_YEARS_OF_EDITION') {
      return err(
        invalidInput(
          'AUTHORITY_EXPENDITURE_5001 is only available on the targetYearsOfEdition axis',
          'input.axis'
        )
      );
    }
    authorityCode = checked.value;
  } else if (isPresent(v['authorityCode'])) {
    return err(
      invalidInput(
        'input.authorityCode is only allowed for AUTHORITY_EXPENDITURE_5001',
        'input.authorityCode'
      )
    );
  }

  const period = validateReportPeriod(v['period'], 'input.period', {
    allowedTypes: ['YEAR'],
    maxLabels: MAX_SERIES_YEARS,
  });
  if (period.isErr()) return err(period.error);
  const unit = unitOf(v['unit'], 'input.unit');
  if (unit.isErr()) return err(unit.error);

  return ok({
    axis: axis.value,
    fund: fund.value,
    total: total.value,
    creditType,
    authorityCode,
    period: period.value,
    unit: unit.value,
  });
};

// ── budgetApprovedRecords ────────────────────────────────────────────────────

export type ApprovedRecordSource =
  | { readonly kind: 'EDITION'; readonly edition: EditionKey; readonly form: ApprovedForm }
  | { readonly kind: 'INTERPRETATION'; readonly interpretationId: string };

export interface ApprovedRecordsQuery {
  readonly source: ApprovedRecordSource;
  /** Printed authority code filter; 999 is a faithful record code and allowed. */
  readonly authorityCode: string | null;
  readonly rowRoles: readonly RowRole[] | null;
  readonly creditTypes: readonly CreditType[] | null;
  readonly capitols: readonly string[] | null;
  /** Records are always native: no unit input exists. */
  readonly unit: 'THOUSAND_LEI';
}

const validateRecordSource = (raw: unknown): Result<ApprovedRecordSource, ApiError> => {
  const member = oneOfMember(raw, 'input.source', ['edition', 'interpretationId'] as const);
  if (member.isErr()) return err(member.error);
  const { key, value } = member.value;
  if (key === 'interpretationId') {
    return idValue(value, 'input.source.interpretationId').map((interpretationId) => ({
      kind: 'INTERPRETATION' as const,
      interpretationId,
    }));
  }
  const body = objectWithKeys(value, 'input.source.edition', ['editionId', 'form']);
  if (body.isErr()) return err(body.error);
  const edition = editionIdValue(body.value['editionId'], 'input.source.edition.editionId');
  if (edition.isErr()) return err(edition.error);
  const form = enumValue(APPROVED_FORMS)(body.value['form'], 'input.source.edition.form');
  if (form.isErr()) return err(form.error);
  return ok({ kind: 'EDITION', edition: edition.value, form: form.value });
};

export const validateApprovedRecordsInput = (
  raw: unknown
): Result<ApprovedRecordsQuery, ApiError> => {
  const input = objectWithKeys(raw, 'input', [
    'source',
    'authorityCode',
    'rowRoles',
    'creditTypes',
    'capitols',
  ]);
  if (input.isErr()) return err(input.error);
  const v = input.value;

  const source = validateRecordSource(v['source']);
  if (source.isErr()) return err(source.error);

  let authorityCode: string | null = null;
  if (isPresent(v['authorityCode'])) {
    const checked = authorityCodeValue(v['authorityCode'], 'input.authorityCode');
    if (checked.isErr()) return err(checked.error);
    if (source.value.kind === 'EDITION' && source.value.form !== AUTHORITY_DETAIL_FORM) {
      return err(
        invalidInput(
          `input.authorityCode applies only to ${AUTHORITY_DETAIL_FORM} records`,
          'input.authorityCode'
        )
      );
    }
    authorityCode = checked.value;
  }

  const rowRoles = optionalList(v['rowRoles'], 'input.rowRoles', {
    max: ROW_ROLES.length,
    item: enumValue(ROW_ROLES),
    sortKey: declaredOrder(ROW_ROLES),
  });
  if (rowRoles.isErr()) return err(rowRoles.error);
  const creditTypes = optionalList(v['creditTypes'], 'input.creditTypes', creditList);
  if (creditTypes.isErr()) return err(creditTypes.error);
  if (creditTypes.value !== null && rowRoles.value !== null && !rowRoles.value.includes('CREDIT')) {
    return err(invalidInput('input.creditTypes requires the CREDIT row role', 'input.creditTypes'));
  }
  const capitols = optionalList(v['capitols'], 'input.capitols', {
    max: MAX_CAPITOLS,
    item: codeValue,
    sortKey: (code: string) => code,
  });
  if (capitols.isErr()) return err(capitols.error);

  return ok({
    source: source.value,
    authorityCode,
    rowRoles: rowRoles.value,
    creditTypes: creditTypes.value,
    capitols: capitols.value,
    unit: 'THOUSAND_LEI',
  });
};
