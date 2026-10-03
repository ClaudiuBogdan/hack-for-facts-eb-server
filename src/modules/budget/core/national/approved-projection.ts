/**
 * National budget — law results from plans plus candidate classifications.
 *
 * Values are native thousand lei until here; the requested unit is applied
 * exactly (RON = × 1,000). Period metadata stays numberless; the only numbers
 * are in `series.data` (series) or the cell `value` (totals).
 */

import { err, ok, type Result } from 'neverthrow';

import { serviceUnavailable, type ApiError } from '@/modules/shared/index.js';

import { projectSeries, type PeriodMetadata, type SeriesEnvelope } from './series.js';
import { projectLawAmount } from './values.js';

import type { ApprovedSeriesQuery } from './approved-inputs.js';
import type { CellClassification, SeriesPeriodPlan, TotalCellPlan } from './approved-plan.js';
import type {
  ApprovedAuthority,
  ApprovedCandidateRef,
  ApprovedDescriptorMatch,
  ApprovedLineRef,
  EditionRef,
} from './models.js';
import type {
  ApprovedCellStatus,
  ApprovedMeasure,
  ApprovedStatus,
  ApprovedUnit,
  BudgetFund,
  CreditType,
  TotalKey,
} from './vocabulary.js';
import type { Decimal } from 'decimal.js';

export type ApprovedClassification = CellClassification<ApprovedCandidateRef>;

const lineAt = (classification: ApprovedClassification, field: string): ApprovedLineRef | null =>
  classification.match?.ref.lines.get(field) ?? null;

// ── series ───────────────────────────────────────────────────────────────────

export interface ApprovedSeriesPeriod extends PeriodMetadata {
  readonly date: string;
  readonly status: ApprovedStatus;
  readonly edition: EditionRef | null;
  readonly candidateEditions: readonly EditionRef[];
  readonly budgetYear: number | null;
  /** Resolved target year (normalization year), not the chart date. */
  readonly measureYear: number | null;
  readonly measure: ApprovedMeasure | null;
  readonly matchCount: number | null;
  readonly descriptor: ApprovedDescriptorMatch | null;
  readonly line: ApprovedLineRef | null;
}

export interface ApprovedSeriesProjection extends SeriesEnvelope<ApprovedSeriesPeriod> {
  readonly unit: ApprovedUnit;
}

/**
 * Combine axis plans with the classification of each READ period (keyed by
 * date). A READ period without a classification is an adapter defect.
 */
export const projectApprovedSeries = (
  query: ApprovedSeriesQuery,
  plans: readonly SeriesPeriodPlan[],
  classifications: ReadonlyMap<string, ApprovedClassification>
): Result<ApprovedSeriesProjection, ApiError> => {
  const entries: { period: ApprovedSeriesPeriod; value: Decimal | null }[] = [];
  for (const plan of plans) {
    if (plan.kind === 'STATUS') {
      entries.push({
        period: {
          date: plan.date,
          status: plan.status,
          edition: plan.edition,
          candidateEditions: plan.candidateEditions,
          budgetYear: plan.edition?.budgetYear ?? null,
          measureYear: plan.measureYear,
          measure: null,
          matchCount: null,
          descriptor: null,
          line: null,
        },
        value: null,
      });
      continue;
    }
    const classification = classifications.get(plan.date);
    if (classification === undefined) {
      return err(serviceUnavailable(`approved series has no descriptor read for ${plan.date}`));
    }
    entries.push({
      period: {
        date: plan.date,
        status: classification.status,
        edition: plan.edition,
        candidateEditions: [plan.edition],
        budgetYear: plan.edition.budgetYear,
        measureYear: plan.slot.measureYear,
        measure: plan.slot.measure,
        matchCount: classification.matchCount,
        descriptor: classification.match?.ref.descriptor ?? null,
        line: lineAt(classification, plan.slot.field),
      },
      value:
        classification.value === null ? null : projectLawAmount(classification.value, query.unit),
    });
  }
  return projectSeries(query.period, entries).map((envelope) => ({
    unit: query.unit,
    ...envelope,
  }));
};

// ── totals ───────────────────────────────────────────────────────────────────

export interface ApprovedTotalCell {
  readonly edition: EditionRef;
  readonly fund: BudgetFund;
  readonly total: TotalKey;
  /**
   * Requested authority code (authority scope), echoed even when the authority
   * or its form is unavailable. Null for fund scope or for the single summary
   * cell of an unfiltered request whose authority form is not loaded.
   * (Additive field, CONTRACT_DELTAS item 5.)
   */
  readonly authorityCode: string | null;
  /** The authority's printed identity when known; never invented. */
  readonly authority: ApprovedAuthority | null;
  readonly measure: ApprovedMeasure;
  readonly measureYear: number;
  readonly creditType: CreditType | null;
  readonly status: ApprovedCellStatus;
  readonly matchCount: number;
  /** Exact value in `unit`, only when AVAILABLE. */
  readonly value: Decimal | null;
  readonly unit: ApprovedUnit;
  readonly descriptor: ApprovedDescriptorMatch | null;
  readonly line: ApprovedLineRef | null;
  /** Each candidate's line at the target slot, where it stores one. */
  readonly candidates: readonly ApprovedLineRef[];
}

export const projectTotalCell = (
  plan: TotalCellPlan,
  classification: ApprovedClassification | null,
  unit: ApprovedUnit
): Result<ApprovedTotalCell, ApiError> => {
  const base = {
    edition: plan.edition,
    fund: plan.fund,
    total: plan.total,
    authorityCode: plan.authorityCode,
    measure: plan.slot.measure,
    measureYear: plan.slot.measureYear,
    creditType: plan.creditType,
    unit,
  };
  if (!plan.formLoaded) {
    if (classification !== null) {
      return err(serviceUnavailable('approved totals read a form that is not loaded'));
    }
    return ok({
      ...base,
      authority: plan.authority,
      status: 'FORM_NOT_LOADED',
      matchCount: 0,
      value: null,
      descriptor: null,
      line: null,
      candidates: [],
    });
  }
  if (classification === null) {
    return err(serviceUnavailable('approved totals cell has no descriptor read'));
  }
  const candidates: ApprovedLineRef[] = [];
  for (const candidate of classification.candidates) {
    const line = candidate.ref.lines.get(plan.slot.field);
    if (line !== undefined) candidates.push(line);
  }
  return ok({
    ...base,
    authority: plan.authority ?? classification.match?.ref.authority ?? null,
    status: classification.status,
    matchCount: classification.matchCount,
    value: classification.value === null ? null : projectLawAmount(classification.value, unit),
    descriptor: classification.match?.ref.descriptor ?? null,
    line: lineAt(classification, plan.slot.field),
    candidates,
  });
};
