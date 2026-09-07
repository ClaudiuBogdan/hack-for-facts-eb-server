/** Native map composition: no legacy source repositories or numeric cache. */
import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import { GQL_TO_DB_REPORT_TYPE, isExecutionGqlReportType } from '@/common/types/report-types.js';
import {
  budgetMapGroupValues,
  budgetMapValues,
  type BudgetMapDeps,
  type BudgetMapResult,
} from '@/modules/budget/index.js';

import { extractNativeInsSeries } from './native-ins-series.js';
import {
  createInvalidInputError,
  createNotFoundError,
  createProviderError,
} from '../../core/errors.js';

import type { GroupedSeriesProvider } from '../../core/ports.js';
import type {
  CommitmentsMapSeries,
  FinancialMapGroupValue,
  GroupedSeriesWarning,
  MapGranularity,
  MapSeriesVector,
} from '../../core/types.js';
import type { MapTerritoryLookup } from '@/common/ports/map-territory-lookup.js';
import type { AdvancedMapDatasetRepository } from '@/modules/advanced-map-datasets/index.js';
import type { InsReadSession } from '@/modules/ins-native/index.js';
import type { ApiError } from '@/modules/shared/index.js';

export interface NativeMapSeriesProviderDeps {
  readonly territoryLookup: (granularity: MapGranularity) => MapTerritoryLookup;
  readonly budget: BudgetMapDeps;
  readonly readCommitments: (
    series: CommitmentsMapSeries,
    granularity: MapGranularity
  ) => Promise<Result<BudgetMapResult, ApiError>>;
  readonly createInsReadSession: () => InsReadSession;
  readonly datasetRepo: Pick<AdvancedMapDatasetRepository, 'getAccessibleDataset'>;
}

export function makeNativeMapSeriesProvider(
  deps: NativeMapSeriesProviderDeps
): GroupedSeriesProvider {
  return {
    async fetchGroupedSeriesVectors(request) {
      try {
        const sirutaUniverse = [...(await deps.territoryLookup(request.granularity)())];
        const universe = new Set(sirutaUniverse);
        if (
          universe.size !== sirutaUniverse.length ||
          sirutaUniverse.some((code) => code.trim() === '' || code !== code.trim())
        )
          return err(createProviderError('Map boundaries contain invalid or duplicate identities'));
        if (
          (request.groups ?? []).some((group) =>
            group.memberTerritoryCodes.some((code) => !universe.has(code))
          )
        )
          return err(
            createInvalidInputError('Group members must belong to the selected map boundaries')
          );
        const groupValues: FinancialMapGroupValue[] = [];
        const vectors: MapSeriesVector[] = [];
        const warnings: GroupedSeriesWarning[] = [];
        for (const series of request.series) {
          if (
            series.type === 'line-items-aggregated-yearly' ||
            series.type === 'commitments-analytics'
          ) {
            const reportType = series.filter.report_type;
            const result =
              series.type === 'commitments-analytics'
                ? await deps.readCommitments(series, request.granularity)
                : await budgetMapValues(deps.budget, {
                    granularity: request.granularity,
                    filter: {
                      ...series.filter,
                      ...(reportType === undefined
                        ? {}
                        : {
                            report_type: isExecutionGqlReportType(reportType)
                              ? GQL_TO_DB_REPORT_TYPE[reportType]
                              : reportType,
                          }),
                    },
                  });
            if (result.isErr())
              return err(
                result.error.type === 'InvalidInput'
                  ? createInvalidInputError(result.error.message)
                  : createProviderError('Budget map data is unavailable', result.error)
              );
            if (
              new Set(result.value.values.map((row) => row.territoryCode)).size !==
                result.value.values.length ||
              result.value.values.some((row) => !universe.has(row.territoryCode))
            )
              return err(
                createProviderError(
                  'Budget map returned a territory outside the selected boundaries'
                )
              );
            const groups = (request.groups ?? []).filter(
              (group) => group.sourceSeriesId === series.id
            );
            if (groups.length > 0) {
              const grouped = await budgetMapGroupValues(deps.budget, {
                source: result.value,
                filter: {
                  ...series.filter,
                  account_category:
                    series.type === 'line-items-aggregated-yearly'
                      ? series.filter.account_category
                      : 'ch',
                },
                groups: groups.map((group, index) => ({
                  key: String(index),
                  members: group.memberTerritoryCodes,
                })),
              });
              if (grouped.isErr())
                return err(
                  createProviderError('Financial group data is unavailable', grouped.error)
                );
              for (const [index, group] of groups.entries()) {
                const value = grouped.value[index];
                if (value === undefined)
                  return err(createProviderError('Financial group result is incomplete'));
                groupValues.push({
                  memberTerritoryCodes: group.memberTerritoryCodes,
                  groupWorkspaceId: group.groupWorkspaceId,
                  groupId: group.groupId,
                  sourceSeriesId: group.sourceSeriesId,
                  value: value.value,
                  unit: value.unit,
                  missingYears: value.missingYears,
                  ...(value.unavailableReason === undefined
                    ? {}
                    : { unavailableReason: value.unavailableReason }),
                });
              }
            }
            vectors.push({
              seriesId: series.id,
              unit: result.value.unit,
              valuesBySirutaCode: new Map(
                result.value.values.map((row) => [row.territoryCode, row.value ?? undefined])
              ),
            });
            const omitted = result.value.years.filter((row) => row.coverage !== 'mapped');
            const unavailable = result.value.values.filter((row) => row.status === 'unavailable');
            if (omitted.length > 0 || unavailable.length > 0)
              warnings.push({
                type: 'BUDGET_MAP_COVERAGE',
                seriesId: series.id,
                message: 'Some selected budgets or normalization years have no eligible map value.',
                details: {
                  outsideViewRows: omitted.filter((row) => row.coverage === 'outside_view').length,
                  unresolvedRows: omitted.filter((row) => row.coverage === 'unresolved').length,
                  unavailableTerritories: unavailable.map((row) => ({
                    code: row.territoryCode,
                    missingYears: row.missingYears,
                  })),
                },
              });
            continue;
          }
          if (series.type === 'ins-series') {
            const result = await extractNativeInsSeries(
              deps.createInsReadSession,
              series,
              request.granularity,
              sirutaUniverse
            );
            if (result.isErr()) return err(result.error);
            vectors.push(result.value.vector);
            warnings.push(...result.value.warnings);
            continue;
          }
          // Dataset lookup enforces owner/public/unlisted access for every read.
          const datasetId = series.datasetId?.trim();
          const datasetPublicId = series.datasetPublicId?.trim();
          if (
            (datasetId === undefined || datasetId === '') ===
            (datasetPublicId === undefined || datasetPublicId === '')
          )
            return err(createInvalidInputError('Choose exactly one uploaded dataset reference'));
          const result = await deps.datasetRepo.getAccessibleDataset({
            ...(datasetId === undefined || datasetId === '' ? {} : { datasetId }),
            ...(datasetPublicId === undefined || datasetPublicId === '' ? {} : { datasetPublicId }),
            ...(request.requestUserId === undefined
              ? {}
              : { requestUserId: request.requestUserId }),
          });
          if (result.isErr())
            return err(createProviderError('Uploaded map dataset read failed', result.error));
          if (result.value === null)
            return err(createNotFoundError('Uploaded map dataset not found'));
          const valuesBySirutaCode = new Map<string, string | undefined>();
          for (const row of result.value.rows) {
            if (!universe.has(row.sirutaCode)) continue;
            if (valuesBySirutaCode.has(row.sirutaCode))
              return err(createProviderError('Uploaded dataset has duplicate territories'));
            if (
              row.valueNumber !== null &&
              (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(row.valueNumber) ||
                !new Decimal(row.valueNumber).isFinite())
            )
              return err(createProviderError('Uploaded dataset contains an invalid decimal'));
            valuesBySirutaCode.set(row.sirutaCode, row.valueNumber ?? undefined);
          }
          const excludedRows = result.value.rows.length - valuesBySirutaCode.size;
          if (excludedRows > 0)
            warnings.push({
              type: 'UPLOADED_MAP_COVERAGE',
              seriesId: series.id,
              message:
                'Uploaded rows outside the selected map boundaries are unavailable in this view.',
              details: { excludedRows, granularity: request.granularity },
            });
          const unit = result.value.unit;
          vectors.push({
            seriesId: series.id,
            ...(unit === null || unit === '' ? {} : { unit }),
            valuesBySirutaCode,
          });
        }
        return ok({
          sirutaUniverse,
          vectors,
          warnings,
          ...(request.groups === undefined ? {} : { groupValues }),
        });
      } catch (cause) {
        return err(createProviderError('Native map data is unavailable', cause));
      }
    },
  };
}
