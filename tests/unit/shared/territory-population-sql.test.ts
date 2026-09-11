/**
 * The kernel's admitted-source population read (`readTerritoryPopulationSources`),
 * pinned at the SQL layer (capturing driver, no DB; codebase plan §WP3, T-13):
 * the canonical-sector predicate is computed in SQL against the Bucharest
 * constants, the source keyset is bound as one JSON parameter, rows pass
 * through as returned (the caller owns admission), an empty keyset issues no
 * statement, and a driver failure is a Database error, never an empty success.
 */

import { describe, expect, it } from 'vitest';

import { readTerritoryPopulationSources } from '@/modules/shared/shell/repo/territory-population.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();

describe('readTerritoryPopulationSources', () => {
  it('reads the complete keyset of the given sources with the canonical-sector proof in SQL', async () => {
    const captured: CapturedQuery[] = [];
    const row = {
      territoryId: 101,
      siruta: '179141',
      year: 2024,
      population: 200_000,
      source: 'ins-bucharest-domicile-jan1:2024:' + 'a'.repeat(64),
      sourceUrl: 'https://example.invalid/2024',
      canonicalSector: true,
    };
    const db = makeCapturingDb(captured, { respond: () => [row] });
    const result = await readTerritoryPopulationSources(db, [row.source, 'other']);
    expect(result._unsafeUnwrap()).toEqual([row]);
    expect(captured).toHaveLength(1);
    expect(flat(captured[0]?.sql ?? '')).toBe(
      'select p.territory_id as "territoryId", t.territorial_siruta_code as siruta, p.year, p.population, p.source, p.source_url as "sourceUrl", ' +
        "(t.level='locality' and t.kind='sector' and t.county_code='B' and t.territory_key='siruta:'||t.territorial_siruta_code " +
        'and (t.siruta_code is null or t.siruta_code=t.territorial_siruta_code) ' +
        "and t.privacy_class='public' and parent.privacy_class='public' " +
        "and parent.territory_key='siruta:179132' and parent.level='uat' and parent.kind='municipality' " +
        'and exists(select 1 from core.territory_identifiers i where i.territory_id=t.id and i.scheme=\'siruta\' and i.value=t.territorial_siruta_code)) is true as "canonicalSector" ' +
        'from core.territory_population p ' +
        'left join core.territories t on t.id=p.territory_id ' +
        'left join core.territories parent on parent.id=t.parent_id ' +
        'where p.source in (select value from jsonb_array_elements_text($1::jsonb))'
    );
    expect(captured[0]?.parameters).toEqual([JSON.stringify([row.source, 'other'])]);
  });

  it('issues no statement for an empty keyset', async () => {
    const captured: CapturedQuery[] = [];
    const result = await readTerritoryPopulationSources(makeCapturingDb(captured), []);
    expect(result._unsafeUnwrap()).toEqual([]);
    expect(captured).toEqual([]);
  });

  it('reports a driver failure as a Database error with the cause', async () => {
    const cause = new Error('connection reset');
    const db = makeCapturingDb([], {
      respond: () => {
        throw cause;
      },
    });
    expect((await readTerritoryPopulationSources(db, ['s']))._unsafeUnwrapErr()).toEqual({
      type: 'Database',
      message: 'readTerritoryPopulationSources failed',
      cause,
    });
  });
});
