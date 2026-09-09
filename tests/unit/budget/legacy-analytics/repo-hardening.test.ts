/**
 * Kernel hardening of the legacy budget repos and resolvers (review B/F13,
 * B/F14, B/F16, B/F19): static error messages, the driver's timeout code, the
 * grouped resolvers' `field` extension, and a mapping defect that is not a
 * database failure.
 */
import { Decimal } from 'decimal.js';
import { GraphQLError } from 'graphql';
import { err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { cleanFilter } from '@/modules/budget/core/legacy-analytics/clean.js';
import { makeBudgetGroupedResolvers } from '@/modules/budget/shell/graphql/legacy/grouped-resolvers.js';
import { makeCommitmentsMapRepo } from '@/modules/budget/shell/repo/commitments-map-repo.js';
import { buildFundingSourceMap } from '@/modules/budget/shell/repo/funding-source-map.js';
import { makeGroupedAnalyticsRepo } from '@/modules/budget/shell/repo/grouped-analytics-repo.js';
import { makeLegacyAnalyticsRepo } from '@/modules/budget/shell/repo/legacy-analytics-repo.js';
import { invalidInput } from '@/modules/shared/index.js';

import { makeCapturingDb, type CapturedQuery } from '../../../fixtures/capturing-db.js';

import type { GroupedQuery } from '@/modules/budget/core/legacy-analytics/grouped-types.js';
import type { LegacyAnalyticsFilter } from '@/modules/budget/core/legacy-analytics/types.js';

const COMPAT = buildFundingSourceMap([
  { sourceId: 0, sourceCode: null, sourceDescription: 'Unknown', internalSourceId: 0 },
]);
const fundingSourceMap = { load: () => Promise.resolve(COMPAT) };
const legacyFilter = (): LegacyAnalyticsFilter => ({
  account_category: 'ch',
  report_period: { type: 'YEAR', selection: { interval: { start: '2022', end: '2023' } } },
});
const DRIVER_TEXT = 'connection to server at "10.0.0.7" failed: password authentication failed';

describe('legacy analytics repo — error hardening', () => {
  it('never forwards the driver message; the cause keeps it for the log (B/F13)', async () => {
    const repo = makeLegacyAnalyticsRepo(
      makeCapturingDb([], {
        respond: () => {
          throw new Error(DRIVER_TEXT);
        },
      }),
      { fundingSourceMap }
    );
    const result = await repo.legacyExecutionAggregate(cleanFilter(legacyFilter())._unsafeUnwrap());
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('Database');
    expect(error.message).toBe('Analytics query failed');
    expect(error.message).not.toContain('10.0.0.7');
  });

  it.each([
    ['the driver code 57014', Object.assign(new Error('query cancelled'), { code: '57014' })],
    ['the statement-timeout text', new Error('canceling statement due to statement timeout')],
  ])('maps %s to Timeout (B/F14)', async (_label, thrown) => {
    const repo = makeLegacyAnalyticsRepo(
      makeCapturingDb([], {
        respond: () => {
          throw thrown;
        },
      }),
      { fundingSourceMap }
    );
    const result = await repo.legacyExecutionAggregate(cleanFilter(legacyFilter())._unsafeUnwrap());
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
  });

  it('does not treat a cancel text without the timeout code as a timeout', async () => {
    const repo = makeLegacyAnalyticsRepo(
      makeCapturingDb([], {
        respond: () => {
          throw new Error('canceling statement due to user request');
        },
      }),
      { fundingSourceMap }
    );
    const result = await repo.legacyExecutionAggregate(cleanFilter(legacyFilter())._unsafeUnwrap());
    expect(result._unsafeUnwrapErr().type).toBe('Database');
  });
});

describe('commitments map repo — the driver timeout is a Timeout (B/F14)', () => {
  it('maps the driver code 57014 to Timeout like the execution map repo', async () => {
    const repo = makeCommitmentsMapRepo(
      makeCapturingDb([], {
        respond: () => {
          throw Object.assign(new Error('query cancelled'), { code: '57014' });
        },
      })
    );
    const result = await repo.yearlyAmounts(
      cleanFilter(legacyFilter())._unsafeUnwrap(),
      'UAT',
      'CREDITE_ANGAJAMENT',
      false
    );
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
  });
});

describe('grouped analytics repo — an incomplete row is a mapping defect (B/F19)', () => {
  const query = (): GroupedQuery => ({
    filter: cleanFilter(legacyFilter())._unsafeUnwrap(),
    // Nominal: a multiplier of 1 for each selected year (an empty map short-circuits to no years).
    moneyMultipliers: new Map([
      [2022, new Decimal('1')],
      [2023, new Decimal('1')],
    ]),
    mode: 'total',
    requirePopulation: false,
    limit: 10,
    offset: 0,
    sort: { by: 'TOTAL_AMOUNT', order: 'DESC' },
  });

  it('reports the NULL column as ServiceUnavailable, not as a database failure', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeGroupedAnalyticsRepo(
      makeCapturingDb(captured, {
        respond: (sql) =>
          // Every statement but the timeout `set local` returns the one row.
          !sql.trimStart().toLowerCase().startsWith('set')
            ? [
                {
                  entity_cui: '4305857',
                  entity_name: null, // promised NOT NULL by the SQL contract
                  entity_type: 'uat',
                  uat_id: null,
                  county_code: 'CJ',
                  county_name: 'Cluj',
                  population: null,
                  total_amount: '10',
                  per_capita_amount: null,
                  amount: '10',
                  functional_code: null,
                  functional_name: null,
                  economic_code: null,
                  economic_name: null,
                  count: '1',
                  total_count: '1',
                  missing_coverage: false,
                },
              ]
            : [],
      }),
      { fundingSourceMap }
    );
    const result = await repo.entities(query());
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('ServiceUnavailable');
    expect(error.message).toBe('Grouped analytics row is incomplete: entity_name is null');
  });
});

describe('grouped resolvers — the error envelope carries `field` (B/F16)', () => {
  it('forwards code, type and field for an InvalidInput', async () => {
    const resolvers = makeBudgetGroupedResolvers({
      entityAnalytics: async () =>
        err(invalidInput('year is out of range', 'filter.report_period')),
    } as unknown as Parameters<typeof makeBudgetGroupedResolvers>[0]);
    const query = resolvers['Query'] as {
      entityAnalytics: (root: unknown, args: unknown) => Promise<unknown>;
    };
    await expect(query.entityAnalytics(undefined, {})).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GraphQLError);
      expect((error as GraphQLError).extensions).toEqual({
        code: 'INVALID_INPUT',
        type: 'InvalidInput',
        field: 'filter.report_period',
      });
      return true;
    });
  });
});
