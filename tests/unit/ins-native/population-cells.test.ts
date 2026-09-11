/**
 * The INS module's snapshot-bound population cells (`readNativePopulation`) and
 * the Bucharest sector supplement (`readAdmittedSectorPopulation`), over a
 * capturing transaction for the kernel reads and the fake INS repo for the
 * publication (codebase plan §WP3, T-13):
 *  - canonical identities are read in the caller's transaction (public rows
 *    only), resolved to INS nodes, and the admitted annual read fills one cell
 *    per requested (territory, year) in request order; a territory without an
 *    INS node or a year the publication lacks is a null cell, never borrowed;
 *  - the sector admission is validated whole (shape, rows, digest, six public
 *    sectors, no competing native node) and its rows override the cells.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  BUCHAREST_SECTOR_SIRUTAS,
  sectorRowsDigestInput,
  type SectorPopulationAdmission,
} from '@/modules/ins-native/core/population-admission.js';
import { NATIVE_MAP_POPULATION_ADMISSION } from '@/modules/ins-native/shell/population/admissions.js';
import { readNativePopulation } from '@/modules/ins-native/shell/population/cells.js';
import { readAdmittedSectorPopulation } from '@/modules/ins-native/shell/population/sector.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';
import { CJ, makeFakeRepo } from '../../fixtures/ins-native/fake-repo.js';

import type { AnnualPopulationAdmission } from '@/modules/ins-native/core/annual-population.js';
import type { InsRepo } from '@/modules/ins-native/core/ports.js';
import type { TerritoryPopulationRow } from '@/modules/shared/index.js';

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();

/** The fake publication (POPTEST, 2019–2021) under the admission the annual test uses. */
const annual: AnnualPopulationAdmission = {
  datasetCode: 'POPTEST',
  revisionId: '1',
  custodySha256: 'a'.repeat(64),
  transformContractSha256: 'b'.repeat(64),
  ageDimension: 0,
  allAgesMember: 1,
  sexDimension: 1,
  allSexesMember: 105,
  personsUnit: 9685,
};

/** A patched fake whose snapshot is itself, so every read goes through the patch. */
const bind = (patch: Partial<InsRepo>, base: InsRepo = makeFakeRepo()): InsRepo => {
  const self: InsRepo = { ...base, ...patch, withSnapshot: (fn) => fn(self) };
  return self;
};

/**
 * The fake serves labels as values; this makes them persons, `<node id><year>`,
 * so a cell proves WHICH INS node was read (CJ/25 -> '252019'), not just a year.
 */
const numericRepo = (): InsRepo => {
  const fake = makeFakeRepo();
  return bind(
    {
      readDefaultSeries: async (...args) => {
        const result = await fake.readDefaultSeries(...args);
        return result.map((rows) =>
          rows.map((row) =>
            row.status !== 'SERIES'
              ? row
              : {
                  ...row,
                  observations: row.observations.map((observation) => ({
                    ...observation,
                    value: `${String(observation.territory?.territoryId ?? 0)}${observation.period.periodStart.slice(0, 4)}`,
                  })),
                }
          )
        );
      },
    },
    fake
  );
};

const territoryRow = (over: Record<string, unknown>) => ({
  id: 0,
  level: null,
  kind: null,
  territory_key: null,
  parent_id: null,
  nuts_code: null,
  territorial_siruta_code: null,
  siruta_code: null,
  county_siruta_code: null,
  uat_code: null,
  name: 'x',
  county_code: null,
  county_name: null,
  region: null,
  population: null,
  ...over,
});

/** Kernel id 42 = county Cluj (INS node CJ/25 in the fake); 99 = a commune without an INS node. */
const CLUJ_COUNTY = territoryRow({
  id: 42,
  level: 'county',
  kind: 'county',
  territory_key: 'county:CJ',
  county_code: 'CJ',
  name: 'Cluj',
});
const UNBRIDGED_COMMUNE = territoryRow({
  id: 99,
  level: 'uat',
  kind: 'commune',
  territory_key: 'siruta:99999',
  territorial_siruta_code: '99999',
  siruta_code: '99999',
  name: 'Nowhere',
});

const SECTOR_IDS = [101, 102, 103, 104, 105, 106] as const;
const sectorTerritories = () =>
  BUCHAREST_SECTOR_SIRUTAS.map((siruta, index) =>
    territoryRow({
      id: SECTOR_IDS[index],
      level: 'locality',
      kind: 'sector',
      territory_key: `siruta:${siruta}`,
      territorial_siruta_code: siruta,
      siruta_code: siruta,
      county_code: 'B',
      name: `Sector ${String(index + 1)}`,
    })
  );

const source = (year: number): string =>
  `ins-bucharest-domicile-jan1:${String(year)}:${'c'.repeat(64)}`;
const sectorRows = (years: readonly number[]): TerritoryPopulationRow[] =>
  years.flatMap((year) =>
    BUCHAREST_SECTOR_SIRUTAS.map((siruta, index) => ({
      territoryId: SECTOR_IDS[index] ?? 0,
      siruta,
      year,
      population: 200_000 + index + (year - 2024),
      source: source(year),
      sourceUrl: `https://example.invalid/${String(year)}`,
      canonicalSector: true,
    }))
  );
const sectorAdmission = (
  rows: readonly TerritoryPopulationRow[],
  ins: SectorPopulationAdmission['ins'] = annual
): SectorPopulationAdmission => ({
  ins,
  years: [2024, 2025],
  sources: [source(2024), source(2025)],
  rowsSha256: createHash('sha256').update(sectorRowsDigestInput(rows)).digest('hex'),
});

/** Which kernel relation a statement reads; unknown statements fail the test. */
const kind = (sql: string): 'identities' | 'sources' => {
  const f = flat(sql);
  if (f.includes('from "core"."territories"')) return 'identities';
  if (f.includes('from core.territory_population p')) return 'sources';
  throw new Error(`unexpected statement: ${f.slice(0, 80)}`);
};

/** A capturing transaction answering the two kernel reads from scripted rows (identities by id). */
const kernel = (
  territories: readonly { readonly id: number }[],
  population: readonly unknown[] = []
) => {
  const captured: CapturedQuery[] = [];
  const trx = makeCapturingDb(captured, {
    respond: (sql, parameters) => {
      if (kind(sql) === 'sources') return population;
      const ids = (String(parameters[0]).match(/\d+/gu) ?? []).map(Number);
      return territories.filter((row) => ids.includes(row.id));
    },
  });
  return { captured, trx };
};

describe('readNativePopulation', () => {
  it('reads public identities in the caller transaction and fills one cell per (territory, year) in request order', async () => {
    const { captured, trx } = kernel([CLUJ_COUNTY, UNBRIDGED_COMMUNE]);
    const cells = (
      await readNativePopulation(
        { trx, repo: numericRepo() },
        annual,
        [99, 42, 42],
        [2021, 2019, 2018]
      )
    )._unsafeUnwrap();
    expect(cells).toEqual([
      { territoryId: 99, year: 2021, population: null },
      { territoryId: 99, year: 2019, population: null },
      { territoryId: 99, year: 2018, population: null },
      { territoryId: 42, year: 2021, population: '252021' },
      { territoryId: 42, year: 2019, population: '252019' },
      // 2018 is outside the publication: absent, not borrowed from 2019.
      { territoryId: 42, year: 2018, population: null },
    ]);
    // The kernel's public-territory read (its column list is pinned in the shared suite).
    expect(captured).toHaveLength(1);
    expect(flat(captured[0]?.sql ?? '')).toContain(
      'from "core"."territories" where id in (select value::int from jsonb_array_elements_text($1::jsonb)) and "privacy_class" = $2'
    );
    expect(captured[0]?.parameters).toEqual(['[99,42]', 'public']);
  });

  it('refuses invalid anchors before any read, and reports a changed publication', async () => {
    for (const ids of [[0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) {
      const { captured, trx } = kernel([]);
      expect(
        (
          await readNativePopulation({ trx, repo: numericRepo() }, annual, ids, [2019])
        )._unsafeUnwrapErr()
      ).toEqual({ type: 'ServiceUnavailable', message: 'Population anchors are invalid' });
      expect(captured).toEqual([]);
    }
    const { trx } = kernel([CLUJ_COUNTY]);
    expect(
      (
        await readNativePopulation(
          { trx, repo: numericRepo() },
          { ...annual, revisionId: '2' },
          [42],
          [2019]
        )
      )._unsafeUnwrapErr()
    ).toEqual({
      type: 'ServiceUnavailable',
      message: 'Annual population publication is not admitted or is inconsistent',
    });
  });

  it('the resolved INS node is CJ/25, and a kernel row the fake links elsewhere fails the bridge', async () => {
    const fake = numericRepo();
    // The INS side claims kernel 42 is bound to another node: contradictory, not silently CJ.
    const linked = bind(
      {
        territoriesByCoreIds: () =>
          fake
            .territoriesByCodes(['AB'], ['NUTS3'])
            .then((r) => r.map((nodes) => nodes.map((node) => ({ ...node, coreTerritoryId: 42 })))),
      },
      fake
    );
    const ok = await readNativePopulation(
      { trx: kernel([CLUJ_COUNTY]).trx, repo: fake },
      annual,
      [42],
      [2019]
    );
    expect(ok._unsafeUnwrap()).toEqual([{ territoryId: 42, year: 2019, population: '252019' }]);
    expect(CJ.territoryId).toBe(25);
    const bad = await readNativePopulation(
      { trx: kernel([CLUJ_COUNTY]).trx, repo: linked },
      annual,
      [42],
      [2019]
    );
    expect(bad._unsafeUnwrapErr()).toEqual({
      type: 'ServiceUnavailable',
      message: 'INS territory bridge is inconsistent',
    });
  });

  it('with a sector admission, the admitted sector rows override the cells of the six sectors', async () => {
    const rows = sectorRows([2024, 2025]);
    const { captured, trx } = kernel([CLUJ_COUNTY, ...sectorTerritories()], rows);
    const cells = (
      await readNativePopulation(
        { trx, repo: numericRepo() },
        annual,
        [42, 101, 106],
        [2024, 2025],
        sectorAdmission(rows)
      )
    )._unsafeUnwrap();
    expect(cells).toEqual([
      // The publication ends in 2021: Cluj has no native cell for these years.
      { territoryId: 42, year: 2024, population: null },
      { territoryId: 42, year: 2025, population: null },
      { territoryId: 101, year: 2024, population: '200000' },
      { territoryId: 101, year: 2025, population: '200001' },
      { territoryId: 106, year: 2024, population: '200005' },
      { territoryId: 106, year: 2025, population: '200006' },
    ]);
    // Identities for the request, then the sector sources, then the six sector identities.
    expect(captured.map((c) => kind(c.sql))).toEqual(['identities', 'sources', 'identities']);
    expect(captured[1]?.parameters).toEqual([JSON.stringify([source(2024), source(2025)])]);
    expect(captured[2]?.parameters).toEqual([JSON.stringify([...SECTOR_IDS]), 'public']);
  });
});

describe('readAdmittedSectorPopulation', () => {
  it('admits the complete, digest-matching, publicly identified sector rows', async () => {
    const rows = sectorRows([2024, 2025]);
    const { trx } = kernel(sectorTerritories(), rows);
    const result = await readAdmittedSectorPopulation(
      trx,
      numericRepo(),
      annual,
      sectorAdmission(rows)
    );
    expect(result._unsafeUnwrap()).toEqual(rows);
  });

  const unavailable = {
    type: 'ServiceUnavailable',
    message: 'Sector population admission is missing or inconsistent',
  };

  it('refuses a malformed admission before reading anything', async () => {
    const rows = sectorRows([2024, 2025]);
    const { captured, trx } = kernel(sectorTerritories(), rows);
    for (const admission of [
      sectorAdmission(rows, NATIVE_MAP_POPULATION_ADMISSION),
      { ...sectorAdmission(rows), years: [2023, 2024] },
      { ...sectorAdmission(rows), rowsSha256: 'nope' },
    ]) {
      expect(
        (
          await readAdmittedSectorPopulation(trx, numericRepo(), annual, admission)
        )._unsafeUnwrapErr()
      ).toEqual(unavailable);
    }
    expect(captured).toEqual([]);
  });

  it('refuses rows that are not admissible, a digest that does not match, or fewer than six public sectors', async () => {
    const rows = sectorRows([2024, 2025]);
    const cases: [
      string,
      readonly { readonly id: number }[],
      readonly unknown[],
      SectorPopulationAdmission,
    ][] = [
      ['a missing sector row', sectorTerritories(), rows.slice(1), sectorAdmission(rows)],
      [
        'a non-canonical row',
        sectorTerritories(),
        rows.map((r, i) => (i === 0 ? { ...r, canonicalSector: false } : r)),
        sectorAdmission(rows),
      ],
      [
        'a digest recorded for other rows',
        sectorTerritories(),
        rows,
        sectorAdmission(rows.map((r, i) => (i === 0 ? { ...r, population: r.population + 1 } : r))),
      ],
      ['a sector that is not public', sectorTerritories().slice(1), rows, sectorAdmission(rows)],
      [
        'rows on five territories',
        sectorTerritories(),
        rows.map((r) => (r.territoryId === 106 ? { ...r, territoryId: 105 } : r)),
        sectorAdmission(rows.map((r) => (r.territoryId === 106 ? { ...r, territoryId: 105 } : r))),
      ],
    ];
    for (const [name, territories, population, admission] of cases) {
      const { trx } = kernel(territories, population);
      const result = await readAdmittedSectorPopulation(trx, numericRepo(), annual, admission);
      expect(result._unsafeUnwrapErr(), name).toEqual(unavailable);
    }
  });

  it('refuses a sector that the INS side already serves natively (reconciliation, never precedence)', async () => {
    const rows = sectorRows([2024, 2025]);
    const fake = numericRepo();
    const native = bind(
      {
        territoriesByCodes: (codes, levels) =>
          fake
            .territoriesByCodes(['54975'], levels)
            .then((r) =>
              r.map((nodes) =>
                codes.includes('179141')
                  ? nodes.map((node) => ({ ...node, code: '179141', sirutaCode: '179141' }))
                  : []
              )
            ),
      },
      fake
    );
    const { trx } = kernel(sectorTerritories(), rows);
    expect(
      (
        await readAdmittedSectorPopulation(trx, native, annual, sectorAdmission(rows))
      )._unsafeUnwrapErr()
    ).toEqual(unavailable);
  });
});
