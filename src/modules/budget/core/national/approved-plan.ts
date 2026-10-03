/**
 * National budget — pure law planning and classification.
 *
 * Planning runs on the loaded inventory before any descriptor read:
 * totals intersect requested targets with each edition's own slots (no cell
 * outside a law's horizon) and are counted before reading; series resolve each
 * chart year on one of three axes keeping budget year (edition) and target year
 * (`measureYear`) distinct. Classification then runs on the candidate records
 * the adapter read with all their stored slots, before choosing the target.
 * A form with more than one loaded interpretation makes every named result
 * from that form AMBIGUOUS; the guard lives in `classifyCandidates`, which both
 * totals and series use.
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import { formFor, TOTAL_DEFINITIONS } from './descriptors.js';
import { labelYear } from './periods.js';
import {
  BUDGET_FUNDS,
  REVENUE_HOLDER_AUTHORITY_CODE,
  type ApprovedCellStatus,
  type ApprovedForm,
  type ApprovedStatus,
  type BudgetFund,
  type CreditType,
  type TotalKey,
} from './vocabulary.js';

import type { ApprovedSeriesQuery, ApprovedTotalsQuery } from './approved-inputs.js';
import type {
  ApprovedAuthority,
  ApprovedEditionInventory,
  ApprovedFormInventory,
  ApprovedSlot,
  EditionRef,
} from './models.js';
import type { Decimal } from 'decimal.js';

export const MAX_TOTAL_CELLS = 100;

const compareEditions = (a: EditionRef, b: EditionRef): number => {
  if (a.budgetYear !== b.budgetYear) return a.budgetYear - b.budgetYear;
  return a.publication < b.publication ? -1 : a.publication > b.publication ? 1 : 0;
};

const loadedForm = (
  entry: ApprovedEditionInventory,
  form: ApprovedForm
): ApprovedFormInventory | undefined => entry.forms.find((candidate) => candidate.form === form);

/** What classification needs besides the candidates: the target and its form's state. */
export interface ClassificationTarget {
  readonly slot: ApprovedSlot;
  /** Loaded interpretations of the target's form; more than one → AMBIGUOUS. */
  readonly formInterpretationIds: readonly string[];
}

// ── totals ───────────────────────────────────────────────────────────────────

export interface TotalCellPlan {
  readonly edition: EditionRef;
  readonly fund: BudgetFund;
  readonly total: TotalKey;
  readonly form: ApprovedForm;
  /**
   * Authority scope: the requested printed code — kept even when its form is
   * not loaded. Null for fund scope, or for the single summary cell of an
   * unfiltered request whose authority form is not loaded.
   */
  readonly authorityCode: string | null;
  /**
   * The code's loaded authority when it has exactly one printed name; null when
   * the form is not loaded or several names share the code (never chosen
   * silently — the matched record's own authority is used instead, if exactly
   * one record matches). Never invented.
   */
  readonly authority: ApprovedAuthority | null;
  readonly slot: ApprovedSlot;
  /** Credit totals only. */
  readonly creditType: CreditType | null;
  /** False → the cell is FORM_NOT_LOADED and nothing is read for it. */
  readonly formLoaded: boolean;
  /** Loaded interpretations of `form` (empty when not loaded). */
  readonly formInterpretationIds: readonly string[];
}

export interface TotalsPlan {
  readonly cells: readonly TotalCellPlan[];
  readonly unloadedEditionIds: readonly string[];
  readonly missingAuthorities: readonly { readonly editionId: string; readonly code: string }[];
}

export const planTotals = (
  query: ApprovedTotalsQuery,
  inventory: readonly ApprovedEditionInventory[]
): Result<TotalsPlan, ApiError> => {
  const byId = new Map(inventory.map((entry) => [entry.edition.id, entry]));
  const unloadedEditionIds: string[] = [];
  let editions: ApprovedEditionInventory[];
  if (query.editionIds === null) {
    editions = [...inventory];
  } else {
    editions = [];
    for (const { id } of query.editionIds) {
      const entry = byId.get(id);
      if (entry === undefined) unloadedEditionIds.push(id);
      else editions.push(entry);
    }
  }
  editions.sort((a, b) => compareEditions(a.edition, b.edition));

  const cells: TotalCellPlan[] = [];
  const missingAuthorities: { editionId: string; code: string }[] = [];
  for (const entry of editions) {
    const slots = entry.slots.filter(
      (slot) =>
        (query.measureYears?.includes(slot.measureYear) ?? true) &&
        (query.measures?.includes(slot.measure) ?? true)
    );
    for (const total of query.totals) {
      const definition = TOTAL_DEFINITIONS[total];
      const creditTypes: readonly (CreditType | null)[] = definition.requiresCreditType
        ? (query.creditTypes ?? [])
        : [null];
      const funds = BUDGET_FUNDS.filter(
        (fund) => definition.funds.includes(fund) && (query.funds?.includes(fund) ?? true)
      );
      for (const fund of funds) {
        const form = formFor(definition, fund);
        const formEntry = loadedForm(entry, form);
        const formLoaded = formEntry !== undefined;
        const formInterpretationIds = formEntry?.interpretationIds ?? [];
        let authorities: readonly { code: string | null; authority: ApprovedAuthority | null }[] = [
          { code: null, authority: null },
        ];
        if (definition.scope === 'AUTHORITY' && !formLoaded && query.authorityCodes !== null) {
          // Missing form: keep each explicitly requested code distinguishable.
          authorities = query.authorityCodes.map((code) => ({ code, authority: null }));
        } else if (definition.scope === 'AUTHORITY' && formLoaded) {
          const loaded = new Map<string, ApprovedAuthority[]>();
          for (const authority of entry.authorities) {
            if (authority.code === REVENUE_HOLDER_AUTHORITY_CODE) continue;
            loaded.set(authority.code, [...(loaded.get(authority.code) ?? []), authority]);
          }
          const requested = query.authorityCodes ?? [...loaded.keys()].sort();
          const found: { code: string; authority: ApprovedAuthority | null }[] = [];
          for (const code of requested) {
            const named = loaded.get(code);
            if (named === undefined) {
              missingAuthorities.push({ editionId: entry.edition.id, code });
            } else {
              found.push({ code, authority: named.length === 1 ? (named[0] ?? null) : null });
            }
          }
          authorities = found;
        }
        for (const { code, authority } of authorities) {
          for (const slot of slots) {
            for (const creditType of creditTypes) {
              cells.push({
                edition: entry.edition,
                fund,
                total,
                form,
                authorityCode: code,
                authority,
                slot,
                creditType,
                formLoaded,
                formInterpretationIds,
              });
            }
          }
        }
      }
    }
  }
  if (cells.length > MAX_TOTAL_CELLS) {
    return err(
      invalidInput(
        `request resolves to ${String(cells.length)} cells; at most ${String(MAX_TOTAL_CELLS)} allowed — narrow editions, slots or authorities`,
        'input'
      )
    );
  }
  return ok({ cells, unloadedEditionIds, missingAuthorities });
};

// ── descriptor read groups ───────────────────────────────────────────────────

/**
 * One descriptor read: every candidate record of a total in an edition form
 * (with all its stored slots), for one credit type and authority. Cells that
 * differ only by slot share a group, so each group is read once.
 */
export interface DescriptorGroup {
  readonly editionId: string;
  readonly form: ApprovedForm;
  readonly total: TotalKey;
  readonly creditType: CreditType | null;
  readonly authorityCode: string | null;
}

export const descriptorGroupKey = (group: DescriptorGroup): string =>
  JSON.stringify([group.editionId, group.form, group.total, group.creditType, group.authorityCode]);

/** Distinct descriptor groups of the readable (form-loaded) totals cells. */
export const totalsDescriptorGroups = (plan: TotalsPlan): readonly DescriptorGroup[] => {
  const groups = new Map<string, DescriptorGroup>();
  for (const cell of plan.cells) {
    if (!cell.formLoaded) continue;
    const group: DescriptorGroup = {
      editionId: cell.edition.id,
      form: cell.form,
      total: cell.total,
      creditType: cell.creditType,
      authorityCode: cell.authorityCode,
    };
    groups.set(descriptorGroupKey(group), group);
  }
  return [...groups.values()];
};

// ── candidate classification ─────────────────────────────────────────────────

/** A descriptor-matching record with every stored slot of its edition. */
export interface DescriptorCandidate<R> {
  readonly interpretationId: string;
  readonly recordIndex: number;
  /** Stored numbers by slot field; an absent field means no stored number. */
  readonly slotValues: ReadonlyMap<string, Decimal>;
  /** Adapter payload (descriptor match, line references). */
  readonly ref: R;
}

export interface CellClassification<R> {
  readonly status: ApprovedCellStatus;
  readonly matchCount: number;
  /** Native thousand-lei value, only when AVAILABLE. */
  readonly value: Decimal | null;
  /** The single matched record (AVAILABLE or SLOT_WITHOUT_VALUE). */
  readonly match: DescriptorCandidate<R> | null;
  readonly candidates: readonly DescriptorCandidate<R>[];
}

/**
 * Classify the candidates of one target.
 *
 * 1. A conflicting form (more than one interpretation among the form's loaded
 *    interpretations and the candidates' own) → AMBIGUOUS with no number, even
 *    when only one interpretation matches or stores the target slot.
 * 2. Zero candidates → NO_MATCHING_RECORD.
 * 3. Several records → AMBIGUOUS with no number.
 * 4. One record → its target slot value, or SLOT_WITHOUT_VALUE.
 *
 * Never sums, never picks a "best" candidate.
 */
export const classifyCandidates = <R>(
  candidates: readonly DescriptorCandidate<R>[],
  target: ClassificationTarget
): CellClassification<R> => {
  const interpretations = new Set([
    ...target.formInterpretationIds,
    ...candidates.map((candidate) => candidate.interpretationId),
  ]);
  const ambiguous = {
    status: 'AMBIGUOUS' as const,
    matchCount: candidates.length,
    value: null,
    match: null,
    candidates,
  };
  if (interpretations.size > 1) return ambiguous;
  const [only] = candidates;
  if (only === undefined) {
    return { status: 'NO_MATCHING_RECORD', matchCount: 0, value: null, match: null, candidates };
  }
  if (candidates.length > 1) return ambiguous;
  const value = only.slotValues.get(target.slot.field) ?? null;
  return {
    status: value === null ? 'SLOT_WITHOUT_VALUE' : 'AVAILABLE',
    matchCount: 1,
    value,
    match: only,
    candidates,
  };
};

// ── series axes ──────────────────────────────────────────────────────────────

/** A resolved chart year: either a final axis status or one cell to read. */
export type SeriesPeriodPlan =
  | {
      readonly kind: 'STATUS';
      readonly date: string;
      readonly status: Extract<
        ApprovedStatus,
        | 'EDITION_NOT_LOADED'
        | 'MULTIPLE_EDITIONS'
        | 'NOT_IN_EDITION'
        | 'FORM_NOT_LOADED'
        | 'AMBIGUOUS'
      >;
      readonly edition: EditionRef | null;
      readonly candidateEditions: readonly EditionRef[];
      readonly measureYear: number | null;
    }
  | {
      readonly kind: 'READ';
      readonly date: string;
      readonly edition: EditionRef;
      readonly form: ApprovedForm;
      readonly slot: ApprovedSlot;
      /** Loaded interpretations of `form`; more than one → AMBIGUOUS when classified. */
      readonly formInterpretationIds: readonly string[];
    };

const resolveCell = (
  date: string,
  entry: ApprovedEditionInventory,
  measureYear: number,
  form: ApprovedForm
): SeriesPeriodPlan => {
  const status = (value: 'NOT_IN_EDITION' | 'FORM_NOT_LOADED' | 'AMBIGUOUS'): SeriesPeriodPlan => ({
    kind: 'STATUS',
    date,
    status: value,
    edition: entry.edition,
    candidateEditions: [entry.edition],
    measureYear,
  });
  const slots = entry.slots.filter((slot) => slot.measureYear === measureYear);
  const [slot] = slots;
  if (slot === undefined) return status('NOT_IN_EDITION');
  if (slots.length > 1) return status('AMBIGUOUS');
  const formEntry = loadedForm(entry, form);
  if (formEntry === undefined) return status('FORM_NOT_LOADED');
  return {
    kind: 'READ',
    date,
    edition: entry.edition,
    form,
    slot,
    formInterpretationIds: formEntry.interpretationIds,
  };
};

/**
 * Plan every requested YEAR label of an approved series.
 *
 * - targetYearsOfEdition: date = target year inside one fixed law;
 * - editionsForTarget: date = edition (budget) year, target fixed;
 * - ownYearApprovals: date = edition year = target year.
 */
export const planApprovedSeries = (
  query: ApprovedSeriesQuery,
  inventory: readonly ApprovedEditionInventory[]
): readonly SeriesPeriodPlan[] => {
  const form = formFor(TOTAL_DEFINITIONS[query.total], query.fund);
  const axis = query.axis;
  const years = query.period.labels.map((label) => ({
    date: label,
    year: labelYear('YEAR', label) ?? Number.NaN,
  }));

  if (axis.kind === 'TARGET_YEARS_OF_EDITION') {
    const entry = inventory.find((candidate) => candidate.edition.id === axis.edition.id);
    return years.map(({ date, year }) =>
      entry === undefined
        ? {
            kind: 'STATUS',
            date,
            status: 'EDITION_NOT_LOADED',
            edition: null,
            candidateEditions: [],
            measureYear: year,
          }
        : resolveCell(date, entry, year, form)
    );
  }

  const allowed = axis.editionIds === null ? null : new Set(axis.editionIds.map((e) => e.id));
  const pool = inventory
    .filter((entry) => allowed?.has(entry.edition.id) ?? true)
    .sort((a, b) => compareEditions(a.edition, b.edition));
  return years.map(({ date, year }) => {
    const measureYear = axis.kind === 'EDITIONS_FOR_TARGET' ? axis.targetYear : year;
    const candidates = pool.filter((entry) => entry.edition.budgetYear === year);
    const [single] = candidates;
    if (single === undefined) {
      return {
        kind: 'STATUS',
        date,
        status: 'EDITION_NOT_LOADED',
        edition: null,
        candidateEditions: [],
        measureYear,
      };
    }
    if (candidates.length > 1) {
      return {
        kind: 'STATUS',
        date,
        status: 'MULTIPLE_EDITIONS',
        edition: null,
        candidateEditions: candidates.map((entry) => entry.edition),
        measureYear,
      };
    }
    return resolveCell(date, single, measureYear, form);
  });
};

/** Distinct descriptor groups of the READ periods of an approved series. */
export const seriesDescriptorGroups = (
  query: ApprovedSeriesQuery,
  plans: readonly SeriesPeriodPlan[]
): readonly DescriptorGroup[] => {
  const groups = new Map<string, DescriptorGroup>();
  for (const plan of plans) {
    if (plan.kind !== 'READ') continue;
    const group: DescriptorGroup = {
      editionId: plan.edition.id,
      form: plan.form,
      total: query.total,
      creditType: query.creditType,
      authorityCode: query.authorityCode,
    };
    groups.set(descriptorGroupKey(group), group);
  }
  return [...groups.values()];
};
