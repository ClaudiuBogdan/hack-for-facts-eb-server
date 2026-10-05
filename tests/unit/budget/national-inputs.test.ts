import { readFileSync } from 'node:fs';

import { buildSchema, coerceInputValue, isInputObjectType } from 'graphql';
import { describe, expect, it } from 'vitest';

import {
  validateApprovedRecordsInput,
  validateApprovedSeriesInput,
  validateApprovedTotalsInput,
} from '@/modules/budget/core/national/approved-inputs.js';
import {
  validateExecutionObservationsInput,
  validateExecutionReleasesInput,
  validateExpectedSnapshot,
  validateFirst,
  validateNationalExecutionSeriesInput,
} from '@/modules/budget/core/national/execution-inputs.js';
import { validateReportPeriod } from '@/modules/budget/core/national/periods.js';
import { budgetLegacyTypeDefs } from '@/modules/budget/shell/graphql/legacy/typedefs.js';
import { budgetSeriesCommonTypeDefs } from '@/modules/budget/shell/graphql/series-common.js';
import { budgetTypeDefs } from '@/modules/budget/shell/graphql/typedefs.js';
import { baseTypeDefs, mergeGraphqlSlices, type ApiError } from '@/modules/shared/index.js';

import type { Result } from 'neverthrow';

const E2025 = '2025:law_2025_as_sent_to_monitorul_oficial';
const S1 = '0cda5d3a-09d1-4c3a-b794-455670ae0ec2';
const S2 = '6110a784-1f51-4bee-8add-cf8bacf8455a';
const E2024 = '2024:law_2024_as_sent_to_monitorul_oficial';
const years = (start: string, end: string) => ({
  type: 'YEAR',
  selection: { interval: { start, end } },
});
const months = (...dates: string[]) => ({ type: 'MONTH', selection: { dates } });

const refusedField = <T>(result: Result<T, ApiError>): string | undefined => {
  expect(result.isErr()).toBe(true);
  return result.isErr() && result.error.type === 'InvalidInput' ? result.error.field : undefined;
};

describe('budgetApprovedTotals input', () => {
  const base = { totals: ['EXPENDITURE_5001_STATE_BUDGET'], creditTypes: ['BUDGET_CREDITS'] };

  it('keeps omitted filters as explicit null scopes and applies only the SDL unit default', () => {
    const query = validateApprovedTotalsInput(base)._unsafeUnwrap();
    expect(query).toEqual({
      totals: ['EXPENDITURE_5001_STATE_BUDGET'],
      creditTypes: ['BUDGET_CREDITS'],
      editionIds: null,
      funds: null,
      measureYears: null,
      measures: null,
      authorityCodes: null,
      unit: 'THOUSAND_LEI',
    });
  });

  it('requires creditTypes iff a credit total is requested and forbids them revenue-only', () => {
    expect(
      refusedField(validateApprovedTotalsInput({ totals: ['EXPENDITURE_5000_TOTAL_GENERAL'] }))
    ).toBe('input.creditTypes');
    expect(
      refusedField(
        validateApprovedTotalsInput({ totals: ['REVENUE_TOTAL'], creditTypes: ['BUDGET_CREDITS'] })
      )
    ).toBe('input.creditTypes');
    expect(validateApprovedTotalsInput({ totals: ['REVENUE_TOTAL'] }).isOk()).toBe(true);
    const mixed = validateApprovedTotalsInput({
      totals: ['EXPENDITURE_5005_CHELTUIELI_TOTAL', 'REVENUE_TOTAL'],
      creditTypes: ['COMMITMENT_CREDITS', 'BUDGET_CREDITS'],
    })._unsafeUnwrap();
    expect(mixed.totals).toEqual(['REVENUE_TOTAL', 'EXPENDITURE_5005_CHELTUIELI_TOTAL']);
    expect(mixed.creditTypes).toEqual(['BUDGET_CREDITS', 'COMMITMENT_CREDITS']);
  });

  it('refuses empty, duplicate, oversized and incompatible filters naming the field', () => {
    expect(refusedField(validateApprovedTotalsInput({ ...base, totals: [] }))).toBe('input.totals');
    expect(refusedField(validateApprovedTotalsInput({ ...base, editionIds: [] }))).toBe(
      'input.editionIds'
    );
    expect(refusedField(validateApprovedTotalsInput({ ...base, editionIds: [E2025, E2025] }))).toBe(
      'input.editionIds'
    );
    expect(refusedField(validateApprovedTotalsInput({ ...base, editionIds: ['2025'] }))).toBe(
      'input.editionIds[0]'
    );
    expect(
      refusedField(
        validateApprovedTotalsInput({
          ...base,
          measureYears: Array.from({ length: 11 }, (_, i) => 2020 + i),
        })
      )
    ).toBe('input.measureYears');
    expect(refusedField(validateApprovedTotalsInput({ ...base, measureYears: [1989] }))).toBe(
      'input.measureYears[0]'
    );
    expect(
      refusedField(validateApprovedTotalsInput({ ...base, funds: ['HEALTH_INSURANCE'] }))
    ).toBe('input.funds');
    expect(refusedField(validateApprovedTotalsInput({ ...base, authorityCodes: ['01'] }))).toBe(
      'input.authorityCodes'
    );
    expect(refusedField(validateApprovedTotalsInput({ ...base, unit: 'EUR' }))).toBe('input.unit');
    expect(refusedField(validateApprovedTotalsInput({ ...base, extra: true }))).toBe('input.extra');
  });

  it('accepts authority codes only with the authority total and never code 999', () => {
    const authorityInput = {
      totals: ['AUTHORITY_EXPENDITURE_5001'],
      creditTypes: ['BUDGET_CREDITS'],
    };
    expect(
      validateApprovedTotalsInput({
        ...authorityInput,
        authorityCodes: ['02', '01'],
      })._unsafeUnwrap().authorityCodes
    ).toEqual(['01', '02']);
    expect(
      refusedField(validateApprovedTotalsInput({ ...authorityInput, authorityCodes: ['999'] }))
    ).toBe('input.authorityCodes[0]');
    expect(
      refusedField(
        validateApprovedTotalsInput({ ...authorityInput, authorityCodes: ['0123456789'] })
      )
    ).toBe('input.authorityCodes[0]');
  });
});

describe('budgetApprovedSeries input', () => {
  const base = {
    axis: { editionsForTarget: { targetYear: 2025 } },
    fund: 'STATE_BUDGET',
    total: 'EXPENDITURE_5001_STATE_BUDGET',
    creditType: 'BUDGET_CREDITS',
    period: years('2022', '2025'),
  };

  it('validates the three axes as exclusive @oneOf members', () => {
    const target = validateApprovedSeriesInput(base)._unsafeUnwrap();
    expect(target.axis).toEqual({
      kind: 'EDITIONS_FOR_TARGET',
      targetYear: 2025,
      editionIds: null,
    });
    expect(target.unit).toBe('THOUSAND_LEI');
    const fixed = validateApprovedSeriesInput({ ...base, axis: { targetYearsOfEdition: E2025 } });
    expect(fixed._unsafeUnwrap().axis).toEqual({
      kind: 'TARGET_YEARS_OF_EDITION',
      edition: { id: E2025, budgetYear: 2025 },
    });
    const own = validateApprovedSeriesInput({ ...base, axis: { ownYearApprovals: {} } });
    expect(own._unsafeUnwrap().axis).toEqual({ kind: 'OWN_YEAR_APPROVALS', editionIds: null });
    expect(
      refusedField(
        validateApprovedSeriesInput({
          ...base,
          axis: { targetYearsOfEdition: E2025, ownYearApprovals: {} },
        })
      )
    ).toBe('input.axis');
    expect(refusedField(validateApprovedSeriesInput({ ...base, axis: {} }))).toBe('input.axis');
  });

  it('refuses two explicit editions for one budget year on an edition axis', () => {
    expect(
      refusedField(
        validateApprovedSeriesInput({
          ...base,
          axis: { ownYearApprovals: { editionIds: [E2025, '2025:rectified_law_2025'] } },
        })
      )
    ).toBe('input.axis.ownYearApprovals.editionIds');
    expect(
      validateApprovedSeriesInput({
        ...base,
        axis: { editionsForTarget: { targetYear: 2025, editionIds: [E2025, E2024] } },
      }).isOk()
    ).toBe(true);
  });

  it('requires creditType for credits, forbids it for revenue, and checks the fund', () => {
    expect(refusedField(validateApprovedSeriesInput({ ...base, creditType: null }))).toBe(
      'input.creditType'
    );
    expect(
      refusedField(
        validateApprovedSeriesInput({
          ...base,
          total: 'REVENUE_TOTAL',
          creditType: 'BUDGET_CREDITS',
        })
      )
    ).toBe('input.creditType');
    const revenue = validateApprovedSeriesInput({
      ...base,
      total: 'REVENUE_TOTAL',
      creditType: undefined,
    });
    expect(revenue._unsafeUnwrap().creditType).toBeNull();
    expect(refusedField(validateApprovedSeriesInput({ ...base, fund: 'HEALTH_INSURANCE' }))).toBe(
      'input.fund'
    );
  });

  it('requires an authority code only for the authority total, on the fixed-edition axis', () => {
    const authority = {
      ...base,
      axis: { targetYearsOfEdition: E2025 },
      total: 'AUTHORITY_EXPENDITURE_5001',
      authorityCode: '01',
    };
    expect(validateApprovedSeriesInput(authority)._unsafeUnwrap().authorityCode).toBe('01');
    expect(refusedField(validateApprovedSeriesInput({ ...authority, authorityCode: null }))).toBe(
      'input.authorityCode'
    );
    expect(refusedField(validateApprovedSeriesInput({ ...authority, authorityCode: '999' }))).toBe(
      'input.authorityCode'
    );
    expect(
      refusedField(
        validateApprovedSeriesInput({
          ...authority,
          axis: { editionsForTarget: { targetYear: 2025 } },
        })
      )
    ).toBe('input.axis');
    expect(refusedField(validateApprovedSeriesInput({ ...base, authorityCode: '01' }))).toBe(
      'input.authorityCode'
    );
  });

  it('accepts YEAR periods of at most 20 labels only', () => {
    expect(refusedField(validateApprovedSeriesInput({ ...base, period: months('2025-01') }))).toBe(
      'input.period.type'
    );
    expect(
      refusedField(validateApprovedSeriesInput({ ...base, period: years('2000', '2020') }))
    ).toBe('input.period.selection.interval');
  });
});

describe('budgetApprovedRecords input', () => {
  const edition = { edition: { editionId: E2025, form: 'STATE_BUDGET_AUTHORITY_DETAIL' } };

  it('is always native thousand lei and has no unit override', () => {
    const query = validateApprovedRecordsInput({ source: edition })._unsafeUnwrap();
    expect(query.unit).toBe('THOUSAND_LEI');
    expect(query.source).toEqual({
      kind: 'EDITION',
      edition: { id: E2025, budgetYear: 2025 },
      form: 'STATE_BUDGET_AUTHORITY_DETAIL',
    });
    expect(refusedField(validateApprovedRecordsInput({ source: edition, unit: 'RON' }))).toBe(
      'input.unit'
    );
  });

  it('enforces the source @oneOf and filter compatibility', () => {
    expect(
      validateApprovedRecordsInput({ source: { interpretationId: 'interp-1' } })._unsafeUnwrap()
        .source
    ).toEqual({ kind: 'INTERPRETATION', interpretationId: 'interp-1' });
    expect(
      refusedField(
        validateApprovedRecordsInput({ source: { ...edition, interpretationId: 'interp-1' } })
      )
    ).toBe('input.source');
    expect(
      refusedField(
        validateApprovedRecordsInput({
          source: { edition: { editionId: E2025, form: 'STATE_BUDGET_SYNTHESIS' } },
          authorityCode: '01',
        })
      )
    ).toBe('input.authorityCode');
    expect(
      refusedField(
        validateApprovedRecordsInput({
          source: edition,
          rowRoles: ['DESCRIPTOR'],
          creditTypes: ['BUDGET_CREDITS'],
        })
      )
    ).toBe('input.creditTypes');
    expect(refusedField(validateApprovedRecordsInput({ source: edition, capitols: [] }))).toBe(
      'input.capitols'
    );
    expect(
      validateApprovedRecordsInput({ source: edition, authorityCode: '999' })._unsafeUnwrap()
        .authorityCode
    ).toBe('999');
  });
});

describe('budgetExecutionReleases input', () => {
  it('defaults revisionsPerMonth to 1 and bounds months × revisions', () => {
    expect(
      validateExecutionReleasesInput({ months: months('2025-05', '2025-06') })._unsafeUnwrap()
        .revisionsPerMonth
    ).toBe(1);
    const hundred = {
      type: 'MONTH',
      selection: { interval: { start: '2018-01', end: '2026-04' } },
    };
    expect(
      refusedField(validateExecutionReleasesInput({ months: hundred, revisionsPerMonth: 4 }))
    ).toBe('input.revisionsPerMonth');
    expect(
      refusedField(
        validateExecutionReleasesInput({ months: months('2025-05'), revisionsPerMonth: 21 })
      )
    ).toBe('input.revisionsPerMonth');
    expect(refusedField(validateExecutionReleasesInput({ months: years('2025', '2025') }))).toBe(
      'input.months.type'
    );
  });
});

describe('budgetExecutionObservations input', () => {
  it('defaults dispositions to FACT and keeps other filters unfiltered', () => {
    const query = validateExecutionObservationsInput({
      source: { months: months('2025-06') },
    })._unsafeUnwrap();
    expect(query.dispositions).toEqual(['FACT']);
    expect(query.requiresSingleSelection).toBe(false);
    expect(query.itemIds).toBeNull();
  });

  it('requires exactly one selection for non-FACT dispositions', () => {
    expect(
      validateExecutionObservationsInput({
        source: { selectionIds: [S1] },
        dispositions: ['BLANK', 'FACT'],
      })._unsafeUnwrap().requiresSingleSelection
    ).toBe(true);
    expect(
      refusedField(
        validateExecutionObservationsInput({
          source: { selectionIds: [S1, S2] },
          dispositions: ['UNRESOLVED'],
        })
      )
    ).toBe('input.dispositions');
    expect(
      refusedField(
        validateExecutionObservationsInput({
          source: { months: months('2025-05', '2025-06') },
          dispositions: ['NONFINANCIAL'],
        })
      )
    ).toBe('input.dispositions');
  });

  it('bounds the source and refuses item filters on Sinteza-only reads', () => {
    expect(
      refusedField(
        validateExecutionObservationsInput({
          source: {
            selectionIds: Array.from(
              { length: 25 },
              (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
            ),
          },
        })
      )
    ).toBe('input.source.selectionIds');
    expect(
      refusedField(
        validateExecutionObservationsInput({
          source: { months: months('2025-06') },
          inputs: ['SINTEZA'],
          itemIds: ['mfin.bgc.revenue.total'],
        })
      )
    ).toBe('input.itemIds');
    expect(
      refusedField(
        validateExecutionObservationsInput({
          source: { months: months('2025-06') },
          components: [],
        })
      )
    ).toBe('input.components');
  });
});

describe('budgetNationalExecutionSeries input', () => {
  it('accepts exactly the five reviewed grids', () => {
    const ok = [
      ['MONTH', 'YTD'],
      ['MONTH', 'PERIOD_DIFFERENCE'],
      ['QUARTER', 'YTD'],
      ['QUARTER', 'PERIOD_DIFFERENCE'],
      ['YEAR', 'FULL_YEAR'],
    ];
    const label = { MONTH: '2025-06', QUARTER: '2025-Q2', YEAR: '2025' } as const;
    for (const [type, basis] of ok) {
      const period = { type, selection: { dates: [label[type as keyof typeof label]] } };
      expect(validateNationalExecutionSeriesInput({ itemIds: ['i'], period, basis }).isOk()).toBe(
        true
      );
    }
    const refused = [
      ['MONTH', 'FULL_YEAR'],
      ['QUARTER', 'FULL_YEAR'],
      ['YEAR', 'YTD'],
      ['YEAR', 'PERIOD_DIFFERENCE'],
    ];
    for (const [type, basis] of refused) {
      const period = { type, selection: { dates: [label[type as keyof typeof label]] } };
      expect(
        refusedField(validateNationalExecutionSeriesInput({ itemIds: ['i'], period, basis }))
      ).toBe('input.period.type');
    }
  });

  it('requires items, period and basis with no fallback, and bounds items', () => {
    const period = months('2025-06');
    expect(refusedField(validateNationalExecutionSeriesInput({ period, basis: 'YTD' }))).toBe(
      'input.itemIds'
    );
    expect(
      refusedField(validateNationalExecutionSeriesInput({ itemIds: ['i'], basis: 'YTD' }))
    ).toBe('input.period');
    expect(refusedField(validateNationalExecutionSeriesInput({ itemIds: ['i'], period }))).toBe(
      'input.basis'
    );
    expect(
      refusedField(
        validateNationalExecutionSeriesInput({
          itemIds: Array.from({ length: 13 }, (_, i) => `item-${String(i)}`),
          period,
          basis: 'YTD',
        })
      )
    ).toBe('input.itemIds');
  });
});

describe('execution series item order', () => {
  it('keeps the caller order of series items (only hashes/sets canonicalise)', () => {
    const period = months('2025-06');
    const query = validateNationalExecutionSeriesInput({
      itemIds: ['mfin.bgc.revenue.total', 'mfin.bgc.expenditure.total', 'mfin.bgc.balance'],
      period,
      basis: 'YTD',
    })._unsafeUnwrap();
    expect(query.itemIds).toEqual([
      'mfin.bgc.revenue.total',
      'mfin.bgc.expenditure.total',
      'mfin.bgc.balance',
    ]);
    expect(
      refusedField(
        validateNationalExecutionSeriesInput({ itemIds: ['a', 'b', 'a'], period, basis: 'YTD' })
      )
    ).toBe('input.itemIds');
  });
});

describe('selection ID domain', () => {
  it('requires UUIDs, canonicalises case and refuses case-only duplicates', () => {
    const upper = validateExecutionObservationsInput({
      source: { selectionIds: [S2.toUpperCase(), S1] },
    })._unsafeUnwrap();
    expect(upper.source).toEqual({ kind: 'SELECTIONS', selectionIds: [S1, S2] });
    expect(
      refusedField(validateExecutionObservationsInput({ source: { selectionIds: ['sel-1'] } }))
    ).toBe('input.source.selectionIds[0]');
    expect(
      refusedField(
        validateExecutionObservationsInput({ source: { selectionIds: [S1.replace(/-/gu, '')] } })
      )
    ).toBe('input.source.selectionIds[0]');
    expect(
      refusedField(
        validateExecutionObservationsInput({ source: { selectionIds: [S1, S1.toUpperCase()] } })
      )
    ).toBe('input.source.selectionIds');
  });
});

/** Approved v3 SDL (+ CONTRACT_DELTAS) composed with the budget slice that carries @oneOf. */
const nationalSchema = buildSchema(
  mergeGraphqlSlices(baseTypeDefs, [
    {
      source: 'budget',
      typeDefs: [
        budgetTypeDefs,
        budgetLegacyTypeDefs,
        budgetSeriesCommonTypeDefs,
        readFileSync(
          new URL('../../fixtures/national-budget/schema-v3.graphql', import.meta.url),
          'utf8'
        ),
      ].join('\n'),
    },
  ]).typeDefs
);

const graphqlAccepts = (typeName: string, value: unknown): boolean => {
  const type = nationalSchema.getType(typeName);
  if (!isInputObjectType(type)) throw new Error(`${typeName} is not an input type`);
  expect(type.isOneOf).toBe(true);
  let accepted = true;
  coerceInputValue(value, type, () => {
    accepted = false;
  });
  return accepted;
};

describe('@oneOf parity with GraphQL input coercion', () => {
  const seriesBase = {
    fund: 'STATE_BUDGET',
    total: 'EXPENDITURE_5001_STATE_BUDGET',
    creditType: 'BUDGET_CREDITS',
    period: years('2024', '2025'),
  };
  const selectors = [
    {
      type: 'BudgetApprovedSeriesAxisInput',
      selected: { targetYearsOfEdition: E2025 },
      other: 'ownYearApprovals',
      core: (axis: unknown) => validateApprovedSeriesInput({ ...seriesBase, axis }).isOk(),
    },
    {
      type: 'BudgetApprovedRecordSource',
      selected: { interpretationId: 'interp-1' },
      other: 'edition',
      core: (source: unknown) => validateApprovedRecordsInput({ source }).isOk(),
    },
    {
      type: 'BudgetExecutionObservationSource',
      selected: { selectionIds: [S1] },
      other: 'months',
      core: (source: unknown) => validateExecutionObservationsInput({ source }).isOk(),
    },
    {
      type: 'PeriodSelection',
      selected: { dates: ['2025'] },
      other: 'interval',
      core: (selection: unknown) =>
        validateReportPeriod({ type: 'YEAR', selection }, 'input.period', {
          allowedTypes: ['YEAR'],
          maxLabels: 20,
        }).isOk(),
    },
  ] as const;

  for (const selector of selectors) {
    it(`${selector.type}: same verdict as GraphQL for selected, selected+null, null-only and empty`, () => {
      const [selectedKey] = Object.keys(selector.selected);
      const cases: readonly [string, unknown, boolean][] = [
        ['only selected', selector.selected, true],
        ['selected + other null', { ...selector.selected, [selector.other]: null }, false],
        ['only null', { [selector.other]: null }, false],
        ['selected null', { [String(selectedKey)]: null }, false],
        ['empty', {}, false],
      ];
      for (const [label, value, expected] of cases) {
        expect([label, graphqlAccepts(selector.type, value)]).toEqual([label, expected]);
        expect([label, selector.core(value)]).toEqual([label, expected]);
      }
    });
  }

  it('keeps ordinary optional-null fields as omitted on both surfaces', () => {
    const axis = { editionsForTarget: { targetYear: 2025, editionIds: null } };
    expect(graphqlAccepts('BudgetApprovedSeriesAxisInput', axis)).toBe(true);
    expect(validateApprovedSeriesInput({ ...seriesBase, axis }).isOk()).toBe(true);
    expect(
      validateApprovedSeriesInput({ ...seriesBase, axis, authorityCode: null, unit: null }).isOk()
    ).toBe(true);
  });
});

describe('GraphQL list input coercion (shared with MCP)', () => {
  it('treats a single value as a one-element list, but never null or a missing value', () => {
    expect(validateApprovedTotalsInput({ totals: 'REVENUE_TOTAL' })._unsafeUnwrap().totals).toEqual(
      ['REVENUE_TOTAL']
    );
    expect(
      validateExecutionReleasesInput({
        months: { type: 'MONTH', selection: { dates: '2025-06' } },
      })._unsafeUnwrap().months.labels
    ).toEqual(['2025-06']);
    expect(
      validateNationalExecutionSeriesInput({
        itemIds: 'mfin.bgc.revenue.total',
        basis: 'YTD',
        period: { type: 'MONTH', selection: { dates: ['2025-06'] } },
      })._unsafeUnwrap().itemIds
    ).toEqual(['mfin.bgc.revenue.total']);
    expect(refusedField(validateApprovedTotalsInput({}))).toBe('input.totals');
    expect(refusedField(validateApprovedTotalsInput({ totals: null }))).toBe('input.totals');
    expect(refusedField(validateApprovedTotalsInput({ totals: 'NOT_A_TOTAL' }))).toBe(
      'input.totals[0]'
    );
  });
});

describe('shared paging arguments', () => {
  it('bounds first to 1–100 with default 50 and validates expectedSnapshot', () => {
    expect(validateFirst(undefined)._unsafeUnwrap()).toBe(50);
    expect(validateFirst(100)._unsafeUnwrap()).toBe(100);
    expect(refusedField(validateFirst(0))).toBe('first');
    expect(refusedField(validateFirst(101))).toBe('first');
    expect(refusedField(validateFirst(2.5))).toBe('first');
    expect(validateExpectedSnapshot(null)._unsafeUnwrap()).toBeNull();
    expect(validateExpectedSnapshot('a1.0123abcd')._unsafeUnwrap()).toBe('a1.0123abcd');
    expect(refusedField(validateExpectedSnapshot(''))).toBe('expectedSnapshot');
  });
});
