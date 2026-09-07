/** Fixed-membership financial groups reuse annual normalization, never sums of ratios. */
import { err, ok, type Result } from 'neverthrow';

import { legacyDecimal } from './decimal.js';
import { groupedYears } from './grouped-usecase.js';
import { normalizeBudgetMapYears, type BudgetMapDeps } from './map-usecase.js';
import { resolveNormalizationPlan } from './normalize.js';
import { planPeriod } from './period.js';

import type { BudgetMapResult, BudgetMapYear } from './map-types.js';
import type { LegacyAnalyticsFilter } from './types.js';
import type { ApiError } from '@/modules/shared/index.js';

export interface BudgetMapGroup {
  readonly key: string;
  readonly members: readonly string[];
}
export interface BudgetMapGroupValue {
  readonly key: string;
  readonly value: string | null;
  readonly unit: string;
  readonly missingYears: readonly number[];
  readonly unavailableReason?:
    'source_filtered_member' | 'source_unavailable_member' | 'normalization_unavailable';
}
export async function budgetMapGroupValues(
  deps: Pick<BudgetMapDeps, 'factors' | 'population'>,
  input: {
    readonly source: BudgetMapResult;
    readonly filter: LegacyAnalyticsFilter;
    readonly groups: readonly BudgetMapGroup[];
  }
): Promise<Result<readonly BudgetMapGroupValue[], ApiError>> {
  const period = planPeriod(input.filter.report_period.selection, input.filter.report_period.type);
  if (period.isErr()) return err(period.error);
  const requestedYears = groupedYears(period.value);
  const annualCoverage = new Set(
    input.source.years
      .filter((row) => row.coverage === 'mapped')
      .map((row) => JSON.stringify([row.territoryCode, row.year]))
  );
  const rowsByMember = new Map<string, BudgetMapYear[]>();
  for (const row of input.source.years) {
    if (row.coverage !== 'mapped' || row.territoryCode === null) continue;
    const rows = rowsByMember.get(row.territoryCode) ?? [];
    rows.push(row);
    rowsByMember.set(row.territoryCode, rows);
  }
  const sourceValues = new Map(input.source.values.map((value) => [value.territoryCode, value]));
  const unavailable = new Map<string, BudgetMapGroupValue>();
  const years: BudgetMapYear[] = [];
  for (const group of input.groups) {
    const members = new Set(group.members);
    const memberCodes = [...members];
    const cells = memberCodes.map((code) => sourceValues.get(code));
    const missingMoneyYears = requestedYears.filter((year) =>
      memberCodes.some((code) => !annualCoverage.has(JSON.stringify([code, year])))
    );
    if (
      members.size === 0 ||
      missingMoneyYears.length > 0 ||
      cells.some((cell) => cell?.status !== 'available')
    ) {
      unavailable.set(group.key, {
        key: group.key,
        value: null,
        unit: input.source.unit,
        missingYears: [
          ...new Set([...missingMoneyYears, ...cells.flatMap((cell) => cell?.missingYears ?? [])]),
        ].sort((a, b) => a - b),
        unavailableReason: cells.some((cell) => cell?.status === 'outside_bounds')
          ? 'source_filtered_member'
          : 'source_unavailable_member',
      });
      continue;
    }
    const rowsByYear = new Map<number, BudgetMapYear>();
    const anchorsByYear = new Map<number, Set<number>>();
    for (const row of memberCodes.flatMap((code) => rowsByMember.get(code) ?? [])) {
      const previous = rowsByYear.get(row.year);
      const anchors = anchorsByYear.get(row.year) ?? new Set<number>();
      for (const id of row.territoryIds) anchors.add(id);
      anchorsByYear.set(row.year, anchors);
      rowsByYear.set(row.year, {
        ...row,
        territoryCode: group.key,
        nominalAmount: legacyDecimal(previous?.nominalAmount ?? '0')
          .plus(row.nominalAmount)
          .toFixed(),
        observationCount: (
          BigInt(previous?.observationCount ?? '0') + BigInt(row.observationCount)
        ).toString(),
        territoryIds: [],
      });
    }
    for (const row of rowsByYear.values())
      years.push({ ...row, territoryIds: [...(anchorsByYear.get(row.year) ?? [])] });
  }
  if (years.length === 0)
    return ok(
      input.groups.map(
        (group) =>
          unavailable.get(group.key) ?? {
            key: group.key,
            value: null,
            unit: input.source.unit,
            missingYears: [],
            unavailableReason: 'source_unavailable_member' as const,
          }
      )
    );
  const normalized = await normalizeBudgetMapYears(deps, {
    rows: years,
    plan: resolveNormalizationPlan(input.filter),
  });
  if (normalized.isErr()) return err(normalized.error);
  const values = new Map(normalized.value.values.map((value) => [value.territoryCode, value]));
  return ok(
    input.groups.map((group) => {
      const missing = unavailable.get(group.key);
      if (missing !== undefined) return missing;
      const cell = values.get(group.key);
      return {
        key: group.key,
        value: cell?.value ?? null,
        unit: normalized.value.unit,
        missingYears: cell?.missingYears ?? [],
        ...(cell?.status === 'available'
          ? {}
          : { unavailableReason: 'normalization_unavailable' as const }),
      };
    })
  );
}
