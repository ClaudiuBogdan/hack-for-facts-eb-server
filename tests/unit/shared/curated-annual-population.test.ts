import { describe, expect, it } from 'vitest';

import {
  publicPopulationLocator,
  readCuratedPopulation,
} from '@/modules/shared/shell/population/curated-annual-population.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

describe('published annual population', () => {
  it('preserves carried source year, zero and absent cells without runtime fallback', async () => {
    const captured: CapturedQuery[] = [];
    const db = makeCapturingDb(captured, {
      respond: () => [
        {
          territory_id: 10,
          applied_year: 2026,
          population: '0',
          calculation: 'SOURCE',
          source_year_min: 2020,
          source_year_max: 2020,
          carried_count: 1,
          provisional_count: 1,
          constituent_count: 1,
          source_code: 'INS_BUCHAREST_PUBLICATION',
          source_url: 'https://example.org/source',
          source_sha256: 'a'.repeat(64),
          publication_status: 'PROVISIONAL',
          source_locator: { sheet: 'page 1', cell: 'Sector 1' },
          load_run_id: '12',
          input_sha256: 'b'.repeat(64),
        },
      ],
    });
    const result = await readCuratedPopulation(db, [10, 11], [2026]);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value[0]).toMatchObject({
      territoryId: 10,
      year: 2026,
      population: '0',
      metadata: {
        sourceYearMin: 2020,
        maxCarryAge: 6,
        carriedCount: 1,
        publicationStatus: 'PROVISIONAL',
        loadRunId: '12',
      },
    });
    expect(result.value[1]).toEqual({
      territoryId: 11,
      year: 2026,
      population: null,
      metadata: null,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toContain("r.status='succeeded'");
    expect(captured[0]?.sql).toContain("r.source_id='core_reference_population_annual'");
    expect(captured[0]?.sql).toContain("t.privacy_class='public'");
    expect(captured[0]?.parameters).toEqual([[10, 11], [2026]]);
  });
  it('rejects invalid anchors and years without issuing a query', async () => {
    const queries: CapturedQuery[] = [];
    const db = makeCapturingDb(queries);
    expect((await readCuratedPopulation(db, [-1], [2026])).isErr()).toBe(true);
    expect((await readCuratedPopulation(db, [1], [0])).isErr()).toBe(true);
    expect(queries).toEqual([]);
  });
  it('publishes only bounded public locator fields', () => {
    expect(
      publicPopulationLocator({
        sheet: 'page 1',
        cell: 'Sector 1',
        artifact: { bucket: 'private' },
        notes: 'internal',
      })
    ).toEqual({ sheet: 'page 1', cell: 'Sector 1' });
    expect(publicPopulationLocator({ cell: 'x'.repeat(513) })).toBeNull();
    expect(
      publicPopulationLocator({
        geoPairs: [
          [2, 3064],
          [3, 112],
        ],
      })
    ).toEqual({
      geoPairs: [
        [2, 3064],
        [3, 112],
      ],
    });
  });
});
