import { Decimal } from 'decimal.js';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import { createDatabaseError } from '@/modules/commitments/core/errors.js';
import { getCommitmentsSummary } from '@/modules/commitments/core/usecases/get-commitments-summary.js';

import type { CommitmentsRepository } from '@/modules/commitments/core/ports.js';
import type {
  CommitmentsFilter,
  CommitmentsQuarterlySummary,
} from '@/modules/commitments/core/types.js';
import type { NormalizationFactors } from '@/modules/normalization/index.js';

const emptyFactors = (): NormalizationFactors => ({
  cpi: new Map(),
  eur: new Map(),
  usd: new Map(),
  gdp: new Map(),
  population: new Map(),
});

describe('getCommitmentsSummary', () => {
  it('computes total_plati and rates for QUARTER (NULL on division by zero)', async () => {
    const row: CommitmentsQuarterlySummary = {
      __typename: 'CommitmentsQuarterlySummary',
      year: 2024,
      quarter: 1,
      entity_cui: 'CUI-1',
      entity_name: 'Test Entity',
      main_creditor_cui: null,
      report_type: 'Executie - Angajamente bugetare agregat principal',
      population: null,

      credite_angajament: new Decimal(20),
      limita_credit_angajament: new Decimal(0),
      credite_bugetare: new Decimal(0),
      credite_angajament_initiale: new Decimal(0),
      credite_bugetare_initiale: new Decimal(0),
      credite_angajament_definitive: new Decimal(0),
      credite_bugetare_definitive: new Decimal(100),
      credite_angajament_disponibile: new Decimal(0),
      credite_bugetare_disponibile: new Decimal(0),
      receptii_totale: new Decimal(0),
      plati_trezor: new Decimal(50),
      plati_non_trezor: new Decimal(10),
      receptii_neplatite: new Decimal(0),

      total_plati: new Decimal(0),
      execution_rate: null,
      commitment_rate: null,
    };

    const repo: CommitmentsRepository = {
      listLineItems: async () => err(createDatabaseError('not used')),
      getAnalyticsSeries: async () => err(createDatabaseError('not used')),
      getAggregated: async () => err(createDatabaseError('not used')),
      getCommitmentVsExecutionMonthData: async () => err(createDatabaseError('not used')),
      listSummary: async () =>
        ok({
          nodes: [row],
          pageInfo: { totalCount: 1, hasNextPage: false, hasPreviousPage: false },
        }),
    };

    const filter: CommitmentsFilter = {
      report_period: { type: Frequency.QUARTER, selection: { dates: ['2024-Q1'] } },
      report_type: 'Executie - Angajamente bugetare agregat principal',
      normalization: 'total',
      currency: 'RON',
      inflation_adjusted: false,
      show_period_growth: true,
      exclude_transfers: true,
    };

    const result = await getCommitmentsSummary(
      { repo, normalization: { generateFactors: async () => emptyFactors() } },
      { filter, limit: 50, offset: 0 }
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.nodes).toHaveLength(1);
    const out = result.value.nodes[0];

    expect(out?.__typename).toBe('CommitmentsQuarterlySummary');
    if (out?.__typename !== 'CommitmentsQuarterlySummary') return;

    expect(out.total_plati.toNumber()).toBe(60);
    expect(out.execution_rate?.toNumber()).toBe(50);
    expect(out.commitment_rate).toBeNull();
  });
});
