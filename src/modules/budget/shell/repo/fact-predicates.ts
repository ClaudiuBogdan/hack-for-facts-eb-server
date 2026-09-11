/**
 * Budget repository — FACT-path predicates shared by the line-item and the
 * classification-aggregate reads (codebase plan §WP5): the pruning gates
 * (invariant 1 of `budget-repo.ts`), the period tuple, the amount range, the
 * transfer exclusion and the core-join decision. Pure SQL builders over the
 * filter input; moved out of the `makeBudgetRepo` closure unchanged.
 */
import { sql, type RawBuilder } from 'kysely';

import { fieldOf, intIn, type CommitmentGate, type ExecutionGate } from './filter-helpers.js';
import {
  BUDGET_TRANSFER_EXCLUSIONS,
  EXECUTION_AMOUNT_COLUMN,
  FREQUENCY_FLAG_COLUMN,
  type BudgetFrequency,
} from '../../core/constants.js';

import type { FilterInput } from '@/modules/shared/index.js';

export const execGatePredicates = (gate: ExecutionGate, alias: string): RawBuilder<unknown>[] => {
  const yr = sql.ref(`${alias}.reporting_year`);
  const conds: RawBuilder<unknown>[] = [];
  if (gate.years.eq !== undefined) conds.push(sql`${yr} = ${gate.years.eq}`);
  if (gate.years.in !== undefined && gate.years.in.length > 0) {
    conds.push(
      sql`${yr} in (${sql.join(
        gate.years.in.map((y) => sql`${y}`),
        sql`, `
      )})`
    );
  }
  if (gate.years.from !== undefined) conds.push(sql`${yr} >= ${gate.years.from}`);
  if (gate.years.to !== undefined) conds.push(sql`${yr} <= ${gate.years.to}`);
  conds.push(sql`${sql.ref(`${alias}.report_type`)} = ${gate.reportLabel}`);
  conds.push(sql`${sql.ref(`${alias}.account_category`)} = ${gate.accountLabel}`);
  conds.push(sql`${sql.ref(`${alias}.${FREQUENCY_FLAG_COLUMN[gate.frequency]}`)} = true`);
  return conds;
};

export const commitGatePredicates = (
  gate: CommitmentGate,
  alias: string
): RawBuilder<unknown>[] => {
  const yr = sql.ref(`${alias}.reporting_year`);
  const conds: RawBuilder<unknown>[] = [];
  if (gate.years.eq !== undefined) conds.push(sql`${yr} = ${gate.years.eq}`);
  if (gate.years.in !== undefined && gate.years.in.length > 0) {
    conds.push(
      sql`${yr} in (${sql.join(
        gate.years.in.map((y) => sql`${y}`),
        sql`, `
      )})`
    );
  }
  if (gate.years.from !== undefined) conds.push(sql`${yr} >= ${gate.years.from}`);
  if (gate.years.to !== undefined) conds.push(sql`${yr} <= ${gate.years.to}`);
  conds.push(sql`${sql.ref(`${alias}.report_type`)} = ${gate.reportLabel}`);
  conds.push(sql`${sql.ref(`${alias}.${FREQUENCY_FLAG_COLUMN[gate.frequency]}`)} = true`);
  return conds;
};

/** Period tuple (months/quarters) predicate within the year, by frequency. */
export const periodTuple = (
  input: FilterInput,
  freq: BudgetFrequency,
  alias: string
): RawBuilder<unknown> | undefined => {
  if (freq === 'MONTH') {
    const months = intIn(fieldOf(input, 'months'));
    if (months !== undefined && months.length > 0) {
      return sql`${sql.ref(`${alias}.reporting_month`)} in (${sql.join(
        months.map((m) => sql`${m}`),
        sql`, `
      )})`;
    }
  } else if (freq === 'QUARTER') {
    const quarters = intIn(fieldOf(input, 'quarters'));
    if (quarters !== undefined && quarters.length > 0) {
      return sql`${sql.ref(`${alias}.quarter`)} in (${sql.join(
        quarters.map((q) => sql`${q}`),
        sql`, `
      )})`;
    }
  }
  return undefined;
};

/** Row-level amount range on the frequency amount column (money → exact ::numeric). */
export const amountRange = (
  input: FilterInput,
  freq: BudgetFrequency,
  alias: string
): RawBuilder<unknown>[] => {
  const col = sql.ref(`${alias}.${EXECUTION_AMOUNT_COLUMN[freq]}`);
  const conds: RawBuilder<unknown>[] = [];
  const min = fieldOf(input, 'minAmount')?.['gte'];
  const max = fieldOf(input, 'maxAmount')?.['lte'];
  if (typeof min === 'string' && /^-?\d+(\.\d+)?$/u.test(min))
    conds.push(sql`${col}::numeric >= ${min}::numeric`);
  if (typeof max === 'string' && /^-?\d+(\.\d+)?$/u.test(max))
    conds.push(sql`${col}::numeric <= ${max}::numeric`);
  return conds;
};

/** Transfer exclusion (fact path opt-in; the EXACT set the MVs bake in, §3.4). */
export const transferExclusion = (alias: string): RawBuilder<unknown> => {
  const econ = BUDGET_TRANSFER_EXCLUSIONS.economicPrefixes.map(
    (p) => sql`${sql.ref(`${alias}.economic_code`)} like ${`${p}%`}`
  );
  const func = BUDGET_TRANSFER_EXCLUSIONS.functionalPrefixes.map(
    (p) => sql`${sql.ref(`${alias}.functional_code`)} like ${`${p}%`}`
  );
  // Keep rows that are NOT a transfer code (NULL-safe: a NULL code is kept).
  return sql`not coalesce(${sql.join([...econ, ...func], sql` or `)}, false)`;
};

export const wantsExcludeTransfers = (input: FilterInput): boolean => {
  const v = fieldOf(input, 'excludeTransfers')?.['eq'];
  return v === true || v === 'true';
};

/** Does the input touch a core (entity/territory) column requiring the join? */
export const needsCoreJoin = (input: FilterInput, coreFields: readonly string[]): boolean => {
  if (coreFields.some((f) => fieldOf(input, f) !== undefined)) return true;
  const ex = input.exclude;
  if (ex !== undefined && typeof ex === 'object') {
    return ['countyCodes', 'regions'].some((f) => (ex as Record<string, unknown>)[f] !== undefined);
  }
  return false;
};

export const EXEC_CORE_FIELDS = [
  'entityTypes',
  'isUat',
  'isTerritorialExecutive',
  'countyCodes',
  'regions',
  'minPopulation',
  'maxPopulation',
  'q',
];
