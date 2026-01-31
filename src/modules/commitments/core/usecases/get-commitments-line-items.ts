import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import { Frequency, extractYearRangeFromSelection } from '@/common/types/temporal.js';

import { createDatabaseError, createValidationError, type CommitmentsError } from '../errors.js';
import { computeMultiplier, needsNormalization } from '../normalization.js';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type CommitmentsFilter,
  type CommitmentsLineItem,
  type CommitmentsLineItemConnection,
} from '../types.js';

import type { CommitmentsRepository } from '../ports.js';
import type { NormalizationFactors } from '@/modules/normalization/index.js';

export interface NormalizationFactorProvider {
  generateFactors(
    frequency: Frequency,
    startYear: number,
    endYear: number
  ): Promise<NormalizationFactors>;
}

export interface GetCommitmentsLineItemsDeps {
  repo: CommitmentsRepository;
  normalization: NormalizationFactorProvider;
}

export interface GetCommitmentsLineItemsInput {
  filter: CommitmentsFilter;
  limit?: number | undefined;
  offset?: number | undefined;
}

const applyMultiplierToYtdMetrics = (
  item: CommitmentsLineItem,
  mult: Decimal
): CommitmentsLineItem => {
  return {
    ...item,
    credite_angajament: item.credite_angajament.mul(mult),
    limita_credit_angajament: item.limita_credit_angajament.mul(mult),
    credite_bugetare: item.credite_bugetare.mul(mult),
    credite_angajament_initiale: item.credite_angajament_initiale.mul(mult),
    credite_bugetare_initiale: item.credite_bugetare_initiale.mul(mult),
    credite_angajament_definitive: item.credite_angajament_definitive.mul(mult),
    credite_bugetare_definitive: item.credite_bugetare_definitive.mul(mult),
    credite_angajament_disponibile: item.credite_angajament_disponibile.mul(mult),
    credite_bugetare_disponibile: item.credite_bugetare_disponibile.mul(mult),
    receptii_totale: item.receptii_totale.mul(mult),
    plati_trezor: item.plati_trezor.mul(mult),
    plati_non_trezor: item.plati_non_trezor.mul(mult),
    receptii_neplatite: item.receptii_neplatite.mul(mult),
  };
};

const applyMultiplierToMonthlyMetrics = (
  item: CommitmentsLineItem,
  mult: Decimal
): CommitmentsLineItem => {
  return {
    ...item,
    monthly_plati_trezor: item.monthly_plati_trezor.mul(mult),
    monthly_plati_non_trezor: item.monthly_plati_non_trezor.mul(mult),
    monthly_receptii_totale: item.monthly_receptii_totale.mul(mult),
    monthly_receptii_neplatite_change: item.monthly_receptii_neplatite_change.mul(mult),
    monthly_credite_angajament: item.monthly_credite_angajament.mul(mult),
  };
};

export async function getCommitmentsLineItems(
  deps: GetCommitmentsLineItemsDeps,
  input: GetCommitmentsLineItemsInput
): Promise<Result<CommitmentsLineItemConnection, CommitmentsError>> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(input.offset ?? 0, 0);

  // NOTE: show_period_growth is ignored for line items by spec decision.
  const filter: CommitmentsFilter = { ...input.filter, show_period_growth: false };

  if (filter.report_type === undefined) {
    return err(
      createValidationError("Required field 'report_type' is missing", 'report_type', null)
    );
  }

  const res = await deps.repo.listLineItems(filter, limit, offset);
  if (res.isErr()) return err(res.error);

  const connection = res.value;
  if (connection.nodes.length === 0) return ok(connection);

  const config = {
    normalization: filter.normalization,
    currency: filter.currency,
    inflation_adjusted: filter.inflation_adjusted,
  } as const;

  const needsFactors = needsNormalization(config);

  if (!needsFactors && filter.normalization !== 'per_capita') {
    return ok({
      ...connection,
      pageInfo: {
        ...connection.pageInfo,
        hasNextPage: offset + limit < connection.pageInfo.totalCount,
        hasPreviousPage: offset > 0,
      },
    });
  }

  const { startYear, endYear } = extractYearRangeFromSelection(filter.report_period.selection);

  let factorsYear: NormalizationFactors;
  let factorsMonth: NormalizationFactors;

  try {
    factorsYear = needsFactors
      ? await deps.normalization.generateFactors(Frequency.YEAR, startYear, endYear)
      : { cpi: new Map(), eur: new Map(), usd: new Map(), gdp: new Map(), population: new Map() };

    factorsMonth = needsFactors
      ? await deps.normalization.generateFactors(Frequency.MONTH, startYear, endYear)
      : { cpi: new Map(), eur: new Map(), usd: new Map(), gdp: new Map(), population: new Map() };
  } catch (error) {
    return err(createDatabaseError('Failed to generate normalization factors', error));
  }

  const normalizedNodes = connection.nodes.map((item) => {
    // TODO(review): For commitmentsLineItems we treat per_capita as per-entity using the entity's population.
    const popDenom =
      filter.normalization === 'per_capita'
        ? item.population !== undefined && item.population !== null && item.population > 0
          ? new Decimal(item.population)
          : undefined
        : undefined;

    const yearKey = String(item.year);
    const monthKey = `${String(item.year)}-${String(item.month).padStart(2, '0')}`;

    const ytdMult =
      filter.normalization === 'per_capita' && (popDenom === undefined || popDenom.isZero())
        ? new Decimal(0)
        : computeMultiplier(yearKey, config, factorsYear, popDenom);

    const monthMult =
      filter.normalization === 'per_capita' && (popDenom === undefined || popDenom.isZero())
        ? new Decimal(0)
        : computeMultiplier(monthKey, config, factorsMonth, popDenom);

    // TODO(review): We normalize YTD metrics using YEAR factors and monthly deltas using MONTH factors,
    // mirroring executionLineItems behavior. A more "as-of-month" approach would normalize all fields
    // using MONTH factors for each row.
    const ytdScaled = applyMultiplierToYtdMetrics(item, ytdMult);
    return applyMultiplierToMonthlyMetrics(ytdScaled, monthMult);
  });

  return ok({
    ...connection,
    nodes: normalizedNodes,
    pageInfo: {
      ...connection.pageInfo,
      hasNextPage: offset + limit < connection.pageInfo.totalCount,
      hasPreviousPage: offset > 0,
    },
  });
}
