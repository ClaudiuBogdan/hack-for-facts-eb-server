/** Adapter from saved map selections to the native INS publication reader. */
import { err, ok, type Result } from 'neverthrow';

import { Frequency, generatePeriodLabels } from '@/common/types/temporal.js';
import {
  readInsMapData,
  parseMemberCode,
  type InsMapDataInput,
  type InsReadSession,
} from '@/modules/ins-native/index.js';

import {
  createInvalidInputError,
  createProviderError,
  type GroupedSeriesError,
} from '../../core/errors.js';

import type { GroupedSeriesWarning, InsMapSeries, MapSeriesVector } from '../../core/types.js';

const MAX_MAP_PERIODS = 1000;
const PERIOD_PATTERNS = {
  YEAR: /^\d{4}$/u,
  QUARTER: /^\d{4}-Q[1-4]$/u,
  MONTH: /^\d{4}-(?:0[1-9]|1[0-2])$/u,
};
const PERIODICITIES = { YEAR: 'ANNUAL', QUARTER: 'QUARTERLY', MONTH: 'MONTHLY' } as const;

/** Expand only validated, bounded intervals; never drop dates to broaden a read. */
function intervalTokens(
  period: NonNullable<InsMapSeries['period']>
): Result<string[], GroupedSeriesError> {
  const valid = (token: string): boolean =>
    PERIOD_PATTERNS[period.type].test(token) && !token.startsWith('0000');
  const interval = period.selection.interval;
  if (interval === undefined) {
    const dates = period.selection.dates;
    if (
      dates.length === 0 ||
      dates.length > MAX_MAP_PERIODS ||
      new Set(dates).size !== dates.length ||
      !dates.every(valid)
    )
      return err(
        createInvalidInputError('Choose 1 to 1000 unique INS periods of the selected frequency')
      );
    return ok([...dates]);
  }
  if (!valid(interval.start) || !valid(interval.end) || interval.start > interval.end)
    return err(createInvalidInputError('Choose a valid INS date interval'));
  const startYear = Number(interval.start.slice(0, 4));
  const endYear = Number(interval.end.slice(0, 4));
  const periodsPerYear =
    period.type === Frequency.MONTH ? 12 : period.type === Frequency.QUARTER ? 4 : 1;
  // Bound allocation before expanding. Boundary years contribute at most two partial years.
  if ((endYear - startYear - 1) * periodsPerYear > MAX_MAP_PERIODS)
    return err(createInvalidInputError('Choose at most 1000 INS periods'));
  const tokens = generatePeriodLabels(startYear, endYear, period.type)
    .map((token) => {
      const [year, suffix] = token.split('-');
      return `${(year ?? '').padStart(4, '0')}${suffix === undefined ? '' : `-${suffix}`}`;
    })
    .filter((token) => token >= interval.start && token <= interval.end);
  return tokens.length > MAX_MAP_PERIODS
    ? err(createInvalidInputError('Choose at most 1000 INS periods'))
    : ok(tokens);
}

export function nativeInsMapInput(
  series: InsMapSeries,
  granularity: 'UAT' | 'County',
  territoryCodes: readonly string[]
): Result<InsMapDataInput, GroupedSeriesError> {
  const datasetCode = series.datasetCode?.trim();
  if (datasetCode === undefined || datasetCode === '')
    return err(createInvalidInputError('Choose an INS map dataset'));
  if (series.aggregation === 'first')
    return err(
      createInvalidInputError('Reselect this legacy INS series; first is not a time operation')
    );
  if (series.hasValue === false)
    return err(createInvalidInputError('Null-only INS selections cannot produce map values'));
  if ((series.unitCodes?.length ?? 0) > 1)
    return err(createInvalidInputError('Choose one INS source unit'));
  const sourcePins: { dimensionIndex: number; memberCode: string }[] = [];
  for (const [dimension, members] of Object.entries(series.classificationSelections ?? {})) {
    const member = members[0];
    if (
      !/^D(?:0|[1-9]\d*)$/u.test(dimension) ||
      members.length !== 1 ||
      member === undefined ||
      parseMemberCode(member) === null ||
      String(parseMemberCode(member)) !== member
    )
      return err(
        createInvalidInputError(
          'Reselect INS classifications using one source member per dimension'
        )
      );
    const dimensionIndex = Number(dimension.slice(1));
    if (!Number.isSafeInteger(dimensionIndex))
      return err(createInvalidInputError('INS source dimension is invalid'));
    sourcePins.push({ dimensionIndex, memberCode: member });
  }
  const periodicity =
    series.period === undefined ? series.periodicity : PERIODICITIES[series.period.type];
  if (series.periodicity !== undefined && periodicity !== series.periodicity)
    return err(createInvalidInputError('INS period and selected frequency disagree'));
  const base: InsMapDataInput = {
    datasetCode,
    granularity,
    territoryCodes,
    sourcePins,
    ...(series.unitCodes?.[0] === undefined ? {} : { unitCode: series.unitCodes[0] }),
    ...(periodicity === undefined ? {} : { periodicity }),
  };
  if (series.period === undefined) return ok(base);
  if (series.intervalOperation === undefined)
    return err(
      createInvalidInputError('Choose an explicit INS interval operation: sum, average or latest')
    );
  const tokens = intervalTokens(series.period);
  return tokens.isErr()
    ? err(tokens.error)
    : ok({
        ...base,
        interval: { operation: series.intervalOperation, periodTokens: tokens.value },
      });
}

export interface NativeInsSeriesOutput {
  readonly vector: MapSeriesVector;
  readonly warnings: GroupedSeriesWarning[];
}

export async function extractNativeInsSeries(
  createReadSession: () => InsReadSession,
  series: InsMapSeries,
  granularity: 'UAT' | 'County',
  territoryCodes: readonly string[]
): Promise<Result<NativeInsSeriesOutput, GroupedSeriesError>> {
  const input = nativeInsMapInput(series, granularity, territoryCodes);
  if (input.isErr()) return err(input.error);
  const universe = new Set(territoryCodes);
  const filters = [series.territoryCodes, series.sirutaCodes].filter(
    (codes): codes is string[] => codes !== undefined && codes.length > 0
  );
  if (filters.some((codes) => codes.some((code) => !universe.has(code))))
    return err(
      createInvalidInputError('INS geographic selections must match the selected map boundaries')
    );
  const selected = new Set(
    territoryCodes.filter((code) => filters.every((codes) => codes.includes(code)))
  );
  const session = createReadSession();
  let result: Awaited<ReturnType<typeof readInsMapData>>;
  try {
    const repo = await session.getRepo();
    result = repo.isErr() ? err(repo.error) : await readInsMapData(repo.value, input.value);
  } catch (cause) {
    await session.close();
    return err(createProviderError('INS map read failed', cause));
  }
  const closed = await session.close();
  if (closed.isErr())
    return err(createProviderError('INS map publication session failed', closed.error));
  if (result.isErr())
    return err(
      result.error.type === 'InvalidInput'
        ? createInvalidInputError(result.error.message)
        : createProviderError('INS map publication is unavailable', result.error)
    );
  const { selection, series: data } = result.value;
  const valuesBySirutaCode = new Map<string, string | undefined>();
  const statuses: Record<string, number> = {};
  for (const code of territoryCodes) {
    if (!selected.has(code)) continue;
    const cell = data.cells.get(code);
    const status = cell?.status ?? 'UNRESOLVED_TERRITORY';
    statuses[status] = (statuses[status] ?? 0) + 1;
    valuesBySirutaCode.set(
      code,
      cell?.status === 'VALUE'
        ? cell.value
        : cell?.status === 'OBSERVATION'
          ? (cell.observation.value ?? undefined)
          : undefined
    );
  }
  return ok({
    vector: {
      seriesId: series.id,
      unit: selection.unit.labelRo,
      valuesBySirutaCode,
    },
    warnings: [
      {
        type: 'INS_MAP_COVERAGE',
        seriesId: series.id,
        message:
          'INS values use one source selection and shared reference periods; missing observations remain unavailable.',
        details: {
          datasetCode: selection.dataset.code,
          operation: data.operation,
          statuses,
          ...(data.operation === 'latest'
            ? { referencePeriod: data.referencePeriod }
            : { periodTokens: data.periodTokens }),
        },
      },
    ],
  });
}
