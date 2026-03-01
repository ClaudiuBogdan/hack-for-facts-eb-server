/**
 * Experimental Map - Mock Map Series Provider
 *
 * Deterministic mock data for phase 1 contract validation.
 */

import { createHash } from 'node:crypto';

import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import { createProviderError } from '../../core/errors.js';

import type { MapSeriesProvider } from '../../core/ports.js';
import type {
  CommitmentsMapSeries,
  ExecutionMapSeries,
  GroupedSeriesDataRequest,
  MapRequestSeries,
  MapSeriesProviderOutput,
} from '../../core/types.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

interface SirutaRow {
  siruta_code: string;
}

function toDeterministicFactor(seed: string): Decimal {
  const hash = createHash('sha256').update(seed).digest('hex');
  const parsed = Number.parseInt(hash.slice(0, 8), 16);
  const maxUInt32 = new Decimal(0xffffffff);

  if (!Number.isFinite(parsed)) {
    return new Decimal(0);
  }

  return new Decimal(parsed).div(maxUInt32);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBooleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === true;
}

function resolveSeriesUnit(series: MapRequestSeries): string | undefined {
  if (series.unit !== undefined && series.unit.trim().length > 0) {
    return series.unit.trim();
  }

  if (series.type !== 'line-items-aggregated-yearly' && series.type !== 'commitments-analytics') {
    return undefined;
  }

  const normalization = readStringField(series.filter, 'normalization') ?? 'total';
  const currency = readStringField(series.filter, 'currency') ?? 'RON';
  const showPeriodGrowth = readBooleanField(series.filter, 'show_period_growth');

  if (showPeriodGrowth || normalization === 'percent_gdp') {
    return '%';
  }

  if (normalization === 'per_capita') {
    return `${currency}/capita`;
  }

  return currency;
}

function shouldSkipValue(series: MapRequestSeries, sirutaCode: string): boolean {
  const missingFactor = toDeterministicFactor(`${series.id}::${sirutaCode}::missing`);

  if (series.type === 'ins-series') {
    return missingFactor.lessThan(0.35);
  }

  if (series.type === 'commitments-analytics') {
    return missingFactor.lessThan(0.08);
  }

  return missingFactor.lessThan(0.03);
}

function resolveExecutionMockValue(series: ExecutionMapSeries, factor: Decimal): number {
  const normalization = readStringField(series.filter, 'normalization') ?? 'total';
  const accountCategory = readStringField(series.filter, 'account_category');

  let baseMagnitude: Decimal;
  if (normalization === 'percent_gdp') {
    baseMagnitude = new Decimal(0.1).plus(factor.mul(18));
  } else if (normalization === 'per_capita') {
    baseMagnitude = new Decimal(100).plus(factor.mul(9000));
  } else {
    baseMagnitude = new Decimal(100000).plus(factor.mul(8_000_000));
  }

  const categoryMultiplier = accountCategory === 'vn' ? new Decimal(1.15) : new Decimal(1);
  return baseMagnitude.mul(categoryMultiplier).toDecimalPlaces(2).toNumber();
}

function resolveCommitmentsMockValue(series: CommitmentsMapSeries, factor: Decimal): number {
  const normalization = readStringField(series.filter, 'normalization') ?? 'total';

  if (normalization === 'percent_gdp') {
    return new Decimal(0.05).plus(factor.mul(9)).toDecimalPlaces(2).toNumber();
  }

  if (normalization === 'per_capita') {
    return new Decimal(60).plus(factor.mul(4500)).toDecimalPlaces(2).toNumber();
  }

  return new Decimal(50000).plus(factor.mul(4_500_000)).toDecimalPlaces(2).toNumber();
}

function resolveMockValue(series: MapRequestSeries, sirutaCode: string): number {
  const valueFactor = toDeterministicFactor(`${series.id}::${sirutaCode}::value`);

  if (series.type === 'line-items-aggregated-yearly') {
    return resolveExecutionMockValue(series, valueFactor);
  }

  if (series.type === 'commitments-analytics') {
    return resolveCommitmentsMockValue(series, valueFactor);
  }

  return new Decimal(1).plus(valueFactor.mul(500)).toDecimalPlaces(2).toNumber();
}

async function loadNonCountySirutaCodes(db: BudgetDbClient): Promise<string[]> {
  const nonCountyCondition = sql<boolean>`NOT (
    u.siruta_code = u.county_code
    OR (u.county_code = 'B' AND u.siruta_code = '179132')
  )`;

  const rows: SirutaRow[] = await db
    .selectFrom('uats as u')
    .select(['u.siruta_code'])
    .where(nonCountyCondition)
    .orderBy('u.siruta_code', 'asc')
    .execute();

  return rows.map((row) => row.siruta_code);
}

export function makeMockMapSeriesProvider(db: BudgetDbClient): MapSeriesProvider {
  return {
    async fetchGroupedSeriesVectors(
      request: GroupedSeriesDataRequest
    ): ReturnType<MapSeriesProvider['fetchGroupedSeriesVectors']> {
      try {
        const sirutaCodes = await loadNonCountySirutaCodes(db);

        const vectors: MapSeriesProviderOutput['vectors'] = request.series.map((series) => {
          const valuesBySirutaCode = new Map<string, number | undefined>();
          const unit = resolveSeriesUnit(series);

          for (const sirutaCode of sirutaCodes) {
            if (shouldSkipValue(series, sirutaCode)) {
              continue;
            }

            const value = resolveMockValue(series, sirutaCode);
            valuesBySirutaCode.set(sirutaCode, value);
          }

          return {
            seriesId: series.id,
            ...(unit !== undefined ? { unit } : {}),
            valuesBySirutaCode,
          };
        });

        return ok({
          sirutaUniverse: sirutaCodes,
          vectors,
          warnings: [],
        });
      } catch (error) {
        return err(createProviderError('Failed to build experimental map mock data', error));
      }
    },
  };
}
