import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import { Frequency, extractYearRangeFromSelection } from '@/common/types/temporal.js';

import { createDatabaseError, type CommitmentsError } from '../errors.js';
import { computeMultiplier, needsNormalization, periodLabelFromParts } from '../normalization.js';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type CommitmentsFilter,
  type CommitmentsSummaryConnection,
  type CommitmentsSummaryResult,
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

export interface GetCommitmentsSummaryDeps {
  repo: CommitmentsRepository;
  normalization: NormalizationFactorProvider;
}

export interface GetCommitmentsSummaryInput {
  filter: CommitmentsFilter;
  limit?: number | undefined;
  offset?: number | undefined;
}

const safeRate = (num: Decimal, denom: Decimal): Decimal | null => {
  if (denom.isZero()) return null;
  return num.div(denom).mul(100);
};

const recomputeDerivedFields = (row: CommitmentsSummaryResult): CommitmentsSummaryResult => {
  if (row.__typename === 'CommitmentsMonthlySummary') {
    return {
      ...row,
      total_plati: row.plati_trezor.add(row.plati_non_trezor),
    };
  }

  if (row.__typename === 'CommitmentsQuarterlySummary') {
    return {
      ...row,
      total_plati: row.plati_trezor.add(row.plati_non_trezor),
      execution_rate: safeRate(row.plati_trezor, row.credite_bugetare_definitive),
      commitment_rate: safeRate(row.credite_angajament, row.credite_angajament_definitive),
    };
  }

  return {
    ...row,
    total_plati: row.plati_trezor.add(row.plati_non_trezor),
    execution_rate: safeRate(row.plati_trezor, row.credite_bugetare_definitive),
    commitment_rate: safeRate(row.credite_angajament, row.credite_angajament_definitive),
  };
};

const applyNormalizationToSummaryRow = (
  row: CommitmentsSummaryResult,
  mult: Decimal
): CommitmentsSummaryResult => {
  if (row.__typename === 'CommitmentsMonthlySummary') {
    return {
      ...row,
      credite_angajament: row.credite_angajament.mul(mult),
      plati_trezor: row.plati_trezor.mul(mult),
      plati_non_trezor: row.plati_non_trezor.mul(mult),
      receptii_totale: row.receptii_totale.mul(mult),
      receptii_neplatite_change: row.receptii_neplatite_change.mul(mult),
    };
  }

  if (row.__typename === 'CommitmentsQuarterlySummary') {
    return {
      ...row,
      credite_angajament: row.credite_angajament.mul(mult),
      limita_credit_angajament: row.limita_credit_angajament.mul(mult),
      credite_bugetare: row.credite_bugetare.mul(mult),
      credite_angajament_initiale: row.credite_angajament_initiale.mul(mult),
      credite_bugetare_initiale: row.credite_bugetare_initiale.mul(mult),
      credite_angajament_definitive: row.credite_angajament_definitive.mul(mult),
      credite_bugetare_definitive: row.credite_bugetare_definitive.mul(mult),
      credite_angajament_disponibile: row.credite_angajament_disponibile.mul(mult),
      credite_bugetare_disponibile: row.credite_bugetare_disponibile.mul(mult),
      receptii_totale: row.receptii_totale.mul(mult),
      plati_trezor: row.plati_trezor.mul(mult),
      plati_non_trezor: row.plati_non_trezor.mul(mult),
      receptii_neplatite: row.receptii_neplatite.mul(mult),
    };
  }

  return {
    ...row,
    credite_angajament: row.credite_angajament.mul(mult),
    limita_credit_angajament: row.limita_credit_angajament.mul(mult),
    credite_bugetare: row.credite_bugetare.mul(mult),
    credite_angajament_initiale: row.credite_angajament_initiale.mul(mult),
    credite_bugetare_initiale: row.credite_bugetare_initiale.mul(mult),
    credite_angajament_definitive: row.credite_angajament_definitive.mul(mult),
    credite_bugetare_definitive: row.credite_bugetare_definitive.mul(mult),
    credite_angajament_disponibile: row.credite_angajament_disponibile.mul(mult),
    credite_bugetare_disponibile: row.credite_bugetare_disponibile.mul(mult),
    receptii_totale: row.receptii_totale.mul(mult),
    plati_trezor: row.plati_trezor.mul(mult),
    plati_non_trezor: row.plati_non_trezor.mul(mult),
    receptii_neplatite: row.receptii_neplatite.mul(mult),
  };
};

export async function getCommitmentsSummary(
  deps: GetCommitmentsSummaryDeps,
  input: GetCommitmentsSummaryInput
): Promise<Result<CommitmentsSummaryConnection, CommitmentsError>> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(input.offset ?? 0, 0);

  // NOTE: show_period_growth is ignored for summary by spec decision.
  const filter: CommitmentsFilter = { ...input.filter, show_period_growth: false };

  const res = await deps.repo.listSummary(filter, limit, offset);
  if (res.isErr()) return err(res.error);

  const connection = res.value;
  if (connection.nodes.length === 0) {
    return ok(connection);
  }

  const config = {
    normalization: filter.normalization,
    currency: filter.currency,
    inflation_adjusted: filter.inflation_adjusted,
  } as const;

  const needsFactors = needsNormalization(config);

  // Optimization: if no currency/inflation/%GDP transforms and not per-capita, just recompute derived.
  if (!needsFactors && filter.normalization !== 'per_capita') {
    return ok({
      ...connection,
      nodes: connection.nodes.map(recomputeDerivedFields),
    });
  }

  const { startYear, endYear } = extractYearRangeFromSelection(filter.report_period.selection);

  let factors: NormalizationFactors;
  if (needsFactors) {
    try {
      factors = await deps.normalization.generateFactors(
        filter.report_period.type,
        startYear,
        endYear
      );
    } catch (error) {
      return err(createDatabaseError('Failed to generate normalization factors', error));
    }
  } else {
    // Per-capita only: factors are unused (no inflation/currency/%GDP).
    factors = {
      cpi: new Map(),
      eur: new Map(),
      usd: new Map(),
      gdp: new Map(),
      population: new Map(),
    };
  }

  const normalized = connection.nodes.map((node) => {
    let periodLabel: string;
    if (node.__typename === 'CommitmentsMonthlySummary') {
      periodLabel = periodLabelFromParts(node.year, node.month, Frequency.MONTH);
    } else if (node.__typename === 'CommitmentsQuarterlySummary') {
      periodLabel = periodLabelFromParts(node.year, node.quarter, Frequency.QUARTER);
    } else {
      periodLabel = periodLabelFromParts(node.year, node.year, Frequency.YEAR);
    }

    // TODO(review): For commitmentsSummary we treat per_capita as per-entity using the entity's population.
    const populationDenom =
      filter.normalization === 'per_capita'
        ? node.population !== undefined && node.population !== null && node.population > 0
          ? new Decimal(node.population)
          : undefined
        : undefined;

    const mult =
      filter.normalization === 'per_capita' &&
      (populationDenom === undefined || populationDenom.isZero())
        ? new Decimal(0)
        : computeMultiplier(periodLabel, config, factors, populationDenom);

    // Apply multiplier to metric fields then recompute derived.
    const scaled = applyNormalizationToSummaryRow(node, mult);
    return recomputeDerivedFields(scaled);
  });

  // Keep ordering/pagination from SQL; normalization is applied post-fetch.
  // TODO(review): if normalized ordering is required, we must move normalization into SQL for ordering.
  return ok({
    ...connection,
    nodes: normalized,
    pageInfo: {
      ...connection.pageInfo,
      hasNextPage: offset + limit < connection.pageInfo.totalCount,
      hasPreviousPage: offset > 0,
    },
  });
}
