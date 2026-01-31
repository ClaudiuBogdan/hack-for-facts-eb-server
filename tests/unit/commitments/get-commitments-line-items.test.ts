import { Decimal } from 'decimal.js';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import { createDatabaseError } from '@/modules/commitments/core/errors.js';
import { getCommitmentsLineItems } from '@/modules/commitments/core/usecases/get-commitments-line-items.js';

import type { CommitmentsRepository } from '@/modules/commitments/core/ports.js';
import type { CommitmentsFilter, CommitmentsLineItem } from '@/modules/commitments/core/types.js';
import type { NormalizationFactors } from '@/modules/normalization/index.js';

const emptyFactors = (): NormalizationFactors => ({
  cpi: new Map(),
  eur: new Map(),
  usd: new Map(),
  gdp: new Map(),
  population: new Map(),
});

const makeBaseFilter = (overrides?: Partial<CommitmentsFilter>): CommitmentsFilter => ({
  report_period: { type: Frequency.MONTH, selection: { dates: ['2024-01'] } },
  report_type: 'Executie - Angajamente bugetare agregat principal',
  normalization: 'total',
  currency: 'RON',
  inflation_adjusted: false,
  show_period_growth: true,
  exclude_transfers: true,
  ...overrides,
});

const makeLineItem = (overrides?: Partial<CommitmentsLineItem>): CommitmentsLineItem => ({
  line_item_id: 'li-1',
  year: 2024,
  month: 1,
  report_type: 'Executie - Angajamente bugetare agregat principal',

  entity_cui: 'CUI-1',
  entity_name: 'Test Entity',
  main_creditor_cui: null,
  population: 100,

  budget_sector_id: 1,
  budget_sector_name: 'Sector',

  funding_source_id: 2,
  funding_source_name: 'Source',

  functional_code: '11.00.00',
  functional_name: 'Functional',

  economic_code: null,
  economic_name: null,

  credite_angajament: new Decimal(100),
  limita_credit_angajament: new Decimal(0),
  credite_bugetare: new Decimal(0),
  credite_angajament_initiale: new Decimal(0),
  credite_bugetare_initiale: new Decimal(0),
  credite_angajament_definitive: new Decimal(0),
  credite_bugetare_definitive: new Decimal(0),
  credite_angajament_disponibile: new Decimal(0),
  credite_bugetare_disponibile: new Decimal(0),
  receptii_totale: new Decimal(0),
  plati_trezor: new Decimal(50),
  plati_non_trezor: new Decimal(10),
  receptii_neplatite: new Decimal(0),

  monthly_plati_trezor: new Decimal(5),
  monthly_plati_non_trezor: new Decimal(1),
  monthly_receptii_totale: new Decimal(0),
  monthly_receptii_neplatite_change: new Decimal(0),
  monthly_credite_angajament: new Decimal(10),

  is_quarterly: false,
  quarter: null,
  is_yearly: false,

  anomaly: null,

  ...overrides,
});

describe('getCommitmentsLineItems', () => {
  it("returns ValidationError when 'report_type' is missing", async () => {
    const repo: CommitmentsRepository = {
      listSummary: async () => err(createDatabaseError('not used')),
      getAnalyticsSeries: async () => err(createDatabaseError('not used')),
      getAggregated: async () => err(createDatabaseError('not used')),
      getCommitmentVsExecutionMonthData: async () => err(createDatabaseError('not used')),
      listLineItems: async () => err(createDatabaseError('not used')),
    };

    const { report_type: reportType, ...filterWithoutReportType } = makeBaseFilter();
    void reportType;

    const result = await getCommitmentsLineItems(
      { repo, normalization: { generateFactors: async () => emptyFactors() } },
      { filter: filterWithoutReportType, limit: 50, offset: 0 }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ValidationError');
    }
  });

  it('ignores show_period_growth and avoids normalization calls when no transforms are requested', async () => {
    let normalizationCalls = 0;
    let repoSawShowPeriodGrowth = true;

    const repo: CommitmentsRepository = {
      listSummary: async () => err(createDatabaseError('not used')),
      getAnalyticsSeries: async () => err(createDatabaseError('not used')),
      getAggregated: async () => err(createDatabaseError('not used')),
      getCommitmentVsExecutionMonthData: async () => err(createDatabaseError('not used')),
      listLineItems: async (filter, _limit, _offset) => {
        repoSawShowPeriodGrowth = filter.show_period_growth;
        return ok({
          nodes: [makeLineItem()],
          pageInfo: { totalCount: 120, hasNextPage: false, hasPreviousPage: false },
        });
      },
    };

    const result = await getCommitmentsLineItems(
      {
        repo,
        normalization: {
          generateFactors: async () => {
            normalizationCalls += 1;
            return emptyFactors();
          },
        },
      },
      { filter: makeBaseFilter({ show_period_growth: true }), limit: 50, offset: 0 }
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(repoSawShowPeriodGrowth).toBe(false);
    expect(normalizationCalls).toBe(0);

    expect(result.value.pageInfo.hasNextPage).toBe(true);
    expect(result.value.pageInfo.hasPreviousPage).toBe(false);
  });

  it('applies per_capita scaling using the entity population (TODO(review) behavior)', async () => {
    const repo: CommitmentsRepository = {
      listSummary: async () => err(createDatabaseError('not used')),
      getAnalyticsSeries: async () => err(createDatabaseError('not used')),
      getAggregated: async () => err(createDatabaseError('not used')),
      getCommitmentVsExecutionMonthData: async () => err(createDatabaseError('not used')),
      listLineItems: async () =>
        ok({
          nodes: [makeLineItem({ population: 100 })],
          pageInfo: { totalCount: 1, hasNextPage: false, hasPreviousPage: false },
        }),
    };

    const result = await getCommitmentsLineItems(
      { repo, normalization: { generateFactors: async () => emptyFactors() } },
      {
        filter: makeBaseFilter({ normalization: 'per_capita', show_period_growth: true }),
        limit: 50,
        offset: 0,
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    const out = result.value.nodes[0];
    expect(out?.plati_trezor.toNumber()).toBe(0.5);
    expect(out?.monthly_plati_trezor.toNumber()).toBe(0.05);
  });
});
