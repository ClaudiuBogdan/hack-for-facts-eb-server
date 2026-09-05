import { describe, expect, it } from 'vitest';

import { cleanFilter } from '@/modules/budget/core/legacy-analytics/clean.js';
import { resolvePopulationScope } from '@/modules/budget/core/legacy-analytics/population.js';

import type { LegacyAnalyticsFilter } from '@/modules/budget/core/legacy-analytics/types.js';

const query = (scope: Partial<LegacyAnalyticsFilter>) =>
  cleanFilter({
    account_category: 'ch',
    report_period: { type: 'YEAR', selection: { interval: { start: '2023', end: '2024' } } },
    ...scope,
  })._unsafeUnwrap();

describe('executive population scope priority', () => {
  it.each([true, false])('keeps explicit geographic priority with executive=%s', (flag) => {
    expect(
      resolvePopulationScope(
        query({ is_territorial_executive: flag, uat_ids: ['123'], county_codes: ['CJ'] })
      )
    ).toEqual({ kind: 'territories', ids: [123] });
    expect(
      resolvePopulationScope(query({ is_territorial_executive: flag, county_codes: ['CJ'] }))
    ).toEqual({ kind: 'counties', codes: ['CJ'] });
    const selected = query({
      is_territorial_executive: flag,
      entity_cuis: ['111'],
      uat_ids: ['123'],
      county_codes: ['CJ'],
    });
    expect(resolvePopulationScope(selected)).toEqual({ kind: 'entityUnion', selection: selected });
  });
  it('keeps old explicit entity overlap when the executive field is absent', () => {
    expect(resolvePopulationScope(query({ entity_cuis: ['111', '444'] }))).toEqual({
      kind: 'entities',
      cuis: ['111', '444'],
    });
  });
});
