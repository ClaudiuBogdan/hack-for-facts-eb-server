import { describe, expect, it } from 'vitest';

import { commitmentsMapSql } from '@/modules/budget/shell/repo/commitments-map-repo.js';
import { mapAnalyticsSql } from '@/modules/budget/shell/repo/map-analytics-repo.js';

import { makeCapturingDb } from '../../fixtures/capturing-db.js';

import type { LegacyAggregateQuery } from '@/modules/budget/core/legacy-analytics/types.js';

const query: LegacyAggregateQuery = {
  frequency: 'YEAR',
  accountCategory: 'ch',
  reportType: null,
  period: { years: { from: 2020, to: 2025 }, yearList: [2021, 2024] },
  minPopulation: 260000,
  maxPopulation: 270000,
};
describe('annual map population predicates', () => {
  it.each(['execution', 'commitments'])(
    'uses the latest selected year in the actual %s statement',
    (stream) => {
      const db = makeCapturingDb([]);
      const statement =
        stream === 'execution'
          ? mapAnalyticsSql(query, 'UAT', () => undefined)
          : commitmentsMapSql(
              query,
              'County',
              'CREDITE_BUGETARE_DEFINITIVE',
              false,
              () => undefined
            );
      const compiled = statement.compile(db);
      expect(compiled.sql).toContain('core.population_annual');
      expect(compiled.sql).not.toContain('"t"."population"');
      expect(compiled.sql).toContain('p.territory_id=e.territory_id');
      expect(compiled.sql).toContain("r.status='succeeded'");
      expect(compiled.parameters.slice(-3)).toEqual([2024, 260000, 270000]);
    }
  );
  it('does not join annual population when bounds are absent', () => {
    const unbounded = { ...query };
    delete unbounded.minPopulation;
    delete unbounded.maxPopulation;
    expect(
      mapAnalyticsSql(unbounded, 'County', () => undefined).compile(makeCapturingDb([])).sql
    ).not.toContain('core.population_annual');
  });
});
