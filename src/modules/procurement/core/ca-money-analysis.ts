/**
 * The analysis API's contract grain answered from the money build (PROC-KB0Z, slice a;
 * root, 28 Nov): the same facts, floor, D6 and joint-win rule as procurementTotals, so a
 * figure here equals the totals answer for the same keys by construction.
 *
 * - recordCount is the record population: every contract-award fact of the scope's record
 *   kinds, any status (one fact per record: `awarded` for ordinary contracts and call-offs,
 *   `framework_ceiling` for framework agreements). It equals the contract-award views' lists
 *   and the totals' own `population` count.
 * - withValueCount and every lei figure are the facts procurementTotals counts: status
 *   awarded, additive, with a lei amount, dated inside a window, and for a supplier scope
 *   without joint wins (`exclusionOf`, the totals rule itself). Joint-win money of a supplier
 *   scope is `valueWithheldAssociationSum`.
 *
 * Pure: the shell reads the aggregate rows (the totals' grouped read, optionally per month).
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import { scopeWindow, type AnalysisScope } from './analysis-scope.js';
import { caMoneyExclusion } from './ca-money-scope.js';
import { BASIS_ALLOW_FLOOR, COUNT_TIME_DEGRADE_FLOOR, type MeasureId } from './constants.js';
import {
  baniToLei,
  exclusionOf,
  type AggregateFilters,
  type ContractKind,
  type FactAggregate,
  type TotalsFilters,
  type ValueKind,
} from './money-totals.js';

import type { GrainQualityVerdict } from './gate-v2.js';
import type { AnalysisSeriesRow, AnalysisStatsRead } from './ports.js';

/** The statuses a contract-grain figure counts (the totals default). */
const COUNTED_STATUSES = ['awarded'] as const;

/** Attached to every contract-grain envelope this source answers. */
export const CA_MONEY_VALUE_NOTE =
  'contract awards: recordCount is every contract-award record of the scope (one per contract across notice versions), any status, as the contract-award lists count them; withValueCount and lei figures are the records procurementTotals counts (status awarded, a summable lei amount, published values without VAT conversion); a framework agreement’s money is its ceiling';

/** Attached to supplier-scoped contract-grain envelopes. */
export const CA_MONEY_JOINT_NOTE =
  'a firm’s own figures leave jointly won contracts out of withValueCount and lei figures (their money is valueWithheldAssociationSum) until the split rule is decided; recordCount includes them';

/** One contract-award record kind as the money build holds it. */
interface RecordShape {
  readonly contractKind: ContractKind;
  readonly valueKind: ValueKind;
}

const ORDINARY: RecordShape = { contractKind: 'ordinary', valueKind: 'awarded' };
const CALL_OFF: RecordShape = { contractKind: 'call_off', valueKind: 'awarded' };
const FRAMEWORK: RecordShape = {
  contractKind: 'framework_agreement',
  valueKind: 'framework_ceiling',
};

/**
 * The record shapes a scope selects. frameworkRole unset is the purchases-only default
 * (ordinary contracts and call-offs, never a ceiling); `all` adds framework agreements.
 * recordKind narrows to award records or framework agreements; the two intersect.
 */
export const recordShapesOf = (scope: AnalysisScope): readonly RecordShape[] => {
  const byRole: readonly RecordShape[] =
    scope.frameworkRole === undefined
      ? [ORDINARY, CALL_OFF]
      : scope.frameworkRole === 'standalone'
        ? [ORDINARY]
        : scope.frameworkRole === 'call_off'
          ? [CALL_OFF]
          : scope.frameworkRole === 'framework_ceiling'
            ? [FRAMEWORK]
            : [ORDINARY, CALL_OFF, FRAMEWORK];
  if (scope.recordKind === undefined) return byRole;
  const kinds: readonly RecordShape[] =
    scope.recordKind === 'framework_agreement' ? [FRAMEWORK] : [ORDINARY, CALL_OFF];
  return byRole.filter((shape) => kinds.includes(shape));
};

/** The last day of a `YYYY-MM` month. */
const monthEnd = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
};

/** The CPV prefix of the scope's one CPV level (canonical codes trimmed to their level). */
const cpvPrefixOf = (scope: AnalysisScope): string | null => {
  if (scope.cpvCode !== undefined) return scope.cpvCode.slice(0, 8);
  if (scope.cpvCategory !== undefined) return scope.cpvCategory.slice(0, 5);
  if (scope.cpvClass !== undefined) return scope.cpvClass.slice(0, 4);
  if (scope.cpvGroup !== undefined) return scope.cpvGroup.slice(0, 3);
  if (scope.cpvDivision !== undefined) return scope.cpvDivision.slice(0, 2);
  return null;
};

/** A compiled scope: the totals' filters, the value kinds read, and whether it is windowed. */
export interface CaMoneyQuery {
  readonly filters: AggregateFilters;
  readonly valueKinds: readonly ValueKind[];
  /** The fact shapes (contract kind × value kind) the scope counts. */
  readonly shapes: readonly RecordShape[];
  readonly bounded: boolean;
}

export const compileCaMoneyScope = (scope: AnalysisScope): Result<CaMoneyQuery, ApiError> => {
  const excluded = caMoneyExclusion(scope);
  if (excluded !== undefined) return err(invalidInput(excluded, 'scope'));
  const shapes = recordShapesOf(scope);
  const window = scopeWindow(scope);
  const contractKinds = [...new Set(shapes.map((shape) => shape.contractKind))];
  return ok({
    filters: {
      procurementKinds: ['contract_award'],
      contractKinds,
      from: window?.from === undefined ? null : `${window.from}-01`,
      to: window?.to === undefined ? null : monthEnd(window.to),
      buyerCode: scope.authorityCui ?? null,
      supplierCode: scope.supplierCui ?? null,
      cpvPrefix: cpvPrefixOf(scope),
      countyCode: null,
      siruta: null,
      vatBases: null,
      q: null,
    },
    valueKinds: [...new Set(shapes.map((shape) => shape.valueKind))],
    shapes,
    bounded: window !== undefined,
  });
};

/** A fact row as the shell reads it, with its contract kind and (series) month. */
export interface CaMoneyRow extends FactAggregate {
  readonly contractKind: ContractKind | null;
  /** `YYYY-MM` of award_day; null when undated. */
  readonly month: string | null;
}

const isShape = (row: CaMoneyRow, query: CaMoneyQuery): boolean =>
  query.shapes.some(
    (shape) => shape.contractKind === row.contractKind && shape.valueKind === row.valueKind
  );

/** The totals rule for this scope: null when the fact counts. */
const countsAsTotals = (row: CaMoneyRow, query: CaMoneyQuery): boolean => {
  const filters: TotalsFilters = { ...query.filters, statuses: COUNTED_STATUSES };
  return exclusionOf(row, { filters }) === null;
};

interface Tally {
  rows: bigint;
  withValue: bigint;
  sumBani: bigint;
  summed: boolean;
  jointBani: bigint;
  jointSummed: boolean;
}

const emptyTally = (): Tally => ({
  rows: 0n,
  withValue: 0n,
  sumBani: 0n,
  summed: false,
  jointBani: 0n,
  jointSummed: false,
});

const add = (tally: Tally, row: CaMoneyRow, query: CaMoneyQuery): void => {
  tally.rows += row.count;
  if (countsAsTotals(row, query)) {
    tally.withValue += row.count;
    tally.sumBani += row.sumBani;
    tally.summed = true;
    return;
  }
  // A supplier scope's joint wins that would otherwise count: the unattributed money.
  if (query.filters.supplierCode !== null && row.jointWin) {
    const solo = exclusionOf(row, {
      filters: { ...query.filters, supplierCode: null, statuses: COUNTED_STATUSES },
    });
    if (solo === null) {
      tally.jointBani += row.sumBani;
      tally.jointSummed = true;
    }
  }
};

const lei = (summed: boolean, bani: bigint): string | null => (summed ? baniToLei(bani) : null);

/**
 * The stats of a scope from its per-month rows. A windowed scope counts dated facts in the
 * window (undated ones are `undatedCount`); an unwindowed scope counts every fact.
 */
export const caMoneyStats = (
  rows: readonly CaMoneyRow[],
  query: CaMoneyQuery
): AnalysisStatsRead => {
  const scope = emptyTally();
  const undated = emptyTally();
  // The undated bucket's money is what would count were it dated (the window cannot apply).
  const undatedQuery: CaMoneyQuery = {
    ...query,
    filters: { ...query.filters, from: null, to: null },
  };
  let min: string | null = null;
  let max: string | null = null;
  for (const row of rows) {
    if (!isShape(row, query)) continue;
    if (!row.dated) add(undated, row, undatedQuery);
    if (query.bounded && !row.dated) continue;
    add(scope, row, query);
    const month = row.month ?? null;
    if (row.dated && month !== null && row.count > 0n) {
      if (min === null || month < min) min = month;
      if (max === null || month > max) max = month;
    }
  }
  const supplierScoped = query.filters.supplierCode !== null;
  return {
    rows: scope.rows.toString(),
    withValue: scope.withValue.toString(),
    withEstimated: '0',
    valueAwardedSum: lei(scope.summed, scope.sumBani),
    valueEstimatedSum: null,
    valueCeilingSum: null,
    valueModAdjustedSum: null,
    valueAwardedMatchedSum: null,
    minMonth: min,
    maxMonth: max,
    undatedCount: undated.rows.toString(),
    undatedValueRon: lei(undated.summed, undated.sumBani),
    valueWithheldAssociationSum: supplierScoped
      ? scope.jointSummed
        ? baniToLei(scope.jointBani)
        : null
      : null,
  };
};

/** The series measures this source serves (the anchor ones, as the DA grain does). */
const SERIES_MEASURES: ReadonlySet<MeasureId> = new Set([
  'recordCount',
  'withValueCount',
  'valueAwardedSum',
]);

export const caMoneySeriesMeasureServed = (measure: MeasureId): boolean =>
  SERIES_MEASURES.has(measure);

/** Monthly series rows from per-month rows; `month: null` is the undated bucket. */
export const caMoneySeries = (
  rows: readonly CaMoneyRow[],
  query: CaMoneyQuery,
  measure: MeasureId
): readonly AnalysisSeriesRow[] => {
  const byMonth = new Map<string | null, Tally>();
  for (const row of rows) {
    if (!isShape(row, query)) continue;
    const month = row.month;
    const tally = byMonth.get(month) ?? emptyTally();
    add(tally, row, query);
    byMonth.set(month, tally);
  }
  const months = [...byMonth.keys()].sort((a, b) =>
    a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0
  );
  return months.map((month) => {
    const tally = byMonth.get(month) ?? emptyTally();
    const awarded = lei(tally.summed, tally.sumBani);
    const value =
      month === null
        ? measure === 'valueAwardedSum'
          ? null
          : '0'
        : measure === 'recordCount'
          ? tally.rows.toString()
          : measure === 'withValueCount'
            ? tally.withValue.toString()
            : (awarded ?? '0.00');
    return {
      month,
      value,
      recordCount: tally.rows.toString(),
      withValue: tally.withValue.toString(),
      valueAwardedSum: awarded,
    };
  });
};

/** The money build's contract-award coverage, under the build's floor (counts as digit strings). */
export interface CaMoneyCoverage {
  /** Contract-award records (awarded and framework_ceiling facts), any status. */
  readonly total: string;
  readonly dated: string;
  /** Status awarded and additive. */
  readonly counted: string;
  /** Counted with a lei amount. */
  readonly valued: string;
  readonly withCpv: string;
  /** With the buyer's county. */
  readonly withGeo: string;
  /** Σ bani of the valued facts, and of those dated / placed. */
  readonly moneyBani: string;
  readonly moneyDatedBani: string;
  readonly moneyGeoBani: string;
}

/** The reads the money-build contract grain needs (the totals reader implements them). */
export interface CaMoneyPort {
  activeBuild(): Promise<Result<string | null, ApiError>>;
  caFloor(build: string): Promise<Result<string | null, ApiError>>;
  supplierRef(build: string, supplierCode: string): Promise<Result<string | null, ApiError>>;
  /** The totals' grouped read, also grouped by contract kind and award month. */
  contractRows(
    build: string,
    filters: AggregateFilters,
    supplierRef: string | null,
    valueKinds: readonly ValueKind[],
    caFloor: string
  ): Promise<Result<readonly CaMoneyRow[], ApiError>>;
  contractCoverage(build: string, caFloor: string): Promise<Result<CaMoneyCoverage, ApiError>>;
}

const ratio = (part: string, whole: string): number => {
  const w = BigInt(whole);
  if (w === 0n) return 0;
  // Four decimal places, exact integer math (ratios are never money).
  return Number((BigInt(part) * 10000n) / w) / 10000;
};

/**
 * The contract grain's quality verdict from the build's coverage. Money is the data platform's
 * counting rule (the same facts totals sum), so spend is served; time and geo follow the floors
 * the other grains use.
 */
export const caMoneyVerdict = (coverage: CaMoneyCoverage): GrainQualityVerdict => {
  const date = ratio(coverage.dated, coverage.total);
  const geo = ratio(coverage.withGeo, coverage.total);
  const cls = (value: number): 'allow' | 'degraded' | 'abstain' =>
    value >= BASIS_ALLOW_FLOOR
      ? 'allow'
      : value >= COUNT_TIME_DEGRADE_FLOOR
        ? 'degraded'
        : 'abstain';
  return {
    coverage: {
      date,
      value: ratio(coverage.valued, coverage.counted),
      geo,
      cpv: ratio(coverage.withCpv, coverage.total),
    },
    coverage_money: {
      date: ratio(coverage.moneyDatedBani, coverage.moneyBani),
      geo: ratio(coverage.moneyGeoBani, coverage.moneyBani),
    },
    classes: { spend: 'allow', time: cls(date), geo: cls(geo) },
  };
};

/**
 * The contract grain's build id: the money build followed by its floor day (YYYYMMDD), so a
 * floor that moves under one money build (a column grant, a republished floor) is a new build
 * for every cache and pin.
 */
export const caMoneyBuildId = (build: string, floor: string): string =>
  `${build}${floor.replace(/-/gu, '')}`;
