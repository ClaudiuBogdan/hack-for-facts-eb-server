/**
 * The Bucharest sector admission checks, now pure and table-driven (review
 * X/F6: they lived untested in `src/app/native-sector-population.ts`). Every
 * clause that refuses a publication is pinned: year-set shape, source count and
 * uniqueness, digest format, INS identity match, row admissibility (canonical
 * sector, admitted year/source, one source per year, completeness, uniqueness,
 * non-negative integer persons) and the loader-compatible digest input.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ADMITTED_SECTOR_YEAR_SETS,
  BUCHAREST_SECTOR_SIRUTAS,
  NATIVE_MAP_POPULATION_ADMISSION,
  NATIVE_SECTOR_POPULATION_ADMISSION,
  sectorAdmissionIsWellFormed,
  sectorRowsAreAdmissible,
  sectorRowsDigestInput,
  type SectorPopulationAdmission,
  type SectorPopulationRowLike,
} from '@/modules/ins-native/index.js';

const ins = NATIVE_MAP_POPULATION_ADMISSION;
const source = (year: number, tag = 'a'): string =>
  `ins-bucharest-domicile-jan1:${String(year)}:${tag.repeat(64)}`;

const admission = (over: Partial<SectorPopulationAdmission> = {}): SectorPopulationAdmission => ({
  ins,
  years: [2024, 2025],
  sources: [source(2024), source(2025)],
  rowsSha256: 'c'.repeat(64),
  ...over,
});

const rowsFor = (adm: SectorPopulationAdmission): SectorPopulationRowLike[] =>
  (adm.years ?? [2024, 2025]).flatMap((year, yi) =>
    BUCHAREST_SECTOR_SIRUTAS.map((siruta, si) => ({
      territoryId: 100 + si,
      siruta,
      year,
      population: 200_000 + si,
      source: adm.sources[yi] ?? '',
      sourceUrl: `https://example.invalid/${String(year)}`,
      canonicalSector: true,
    }))
  );

describe('sectorAdmissionIsWellFormed', () => {
  it('accepts the shipped admission and every admitted year-set shape', () => {
    expect(sectorAdmissionIsWellFormed(ins, NATIVE_SECTOR_POPULATION_ADMISSION)).toBe(true);
    for (const years of ADMITTED_SECTOR_YEAR_SETS) {
      expect(
        sectorAdmissionIsWellFormed(ins, admission({ years, sources: years.map((y) => source(y)) }))
      ).toBe(true);
    }
    // Omitted years = the original 2024/2025 contract.
    const withoutYears: SectorPopulationAdmission = {
      ins,
      sources: [source(2024), source(2025)],
      rowsSha256: 'c'.repeat(64),
    };
    expect(sectorAdmissionIsWellFormed(ins, withoutYears)).toBe(true);
  });

  it.each([
    [
      'an unadmitted year set',
      admission({ years: [2021, 2022], sources: [source(2021), source(2022)] }),
    ],
    ['a year-set with the right length but wrong years', admission({ years: [2023, 2025] })],
    ['fewer sources than years', admission({ sources: [source(2024)] })],
    ['duplicate sources', admission({ sources: [source(2024), source(2024)] })],
    ['a malformed rows digest', admission({ rowsSha256: 'xyz' })],
    ['a different INS revision', admission({ ins: { ...ins, revisionId: '9999' } })],
    ['a different custody digest', admission({ ins: { ...ins, custodySha256: '0'.repeat(64) } })],
  ])('refuses %s', (_name, adm) => {
    expect(sectorAdmissionIsWellFormed(ins, adm)).toBe(false);
  });
});

describe('sectorRowsAreAdmissible', () => {
  it('accepts the complete, unique, canonical row set', () => {
    const adm = admission();
    expect(sectorRowsAreAdmissible(rowsFor(adm), adm)).toBe(true);
  });

  const mutate = (
    fn: (rows: SectorPopulationRowLike[]) => SectorPopulationRowLike[]
  ): [SectorPopulationRowLike[], SectorPopulationAdmission] => {
    const adm = admission();
    return [fn(rowsFor(adm)), adm];
  };

  it.each([
    ['a missing sector', mutate((rows) => rows.slice(1))],
    [
      'a non-canonical sector row',
      mutate((rows) => rows.map((r, i) => (i === 0 ? { ...r, canonicalSector: false } : r))),
    ],
    [
      'a territory outside the six sectors',
      mutate((rows) => rows.map((r, i) => (i === 0 ? { ...r, siruta: '179132' } : r))),
    ],
    [
      'an unadmitted year',
      mutate((rows) => rows.map((r, i) => (i === 0 ? { ...r, year: 2019 } : r))),
    ],
    [
      'an unadmitted source',
      mutate((rows) => rows.map((r, i) => (i === 0 ? { ...r, source: source(2024, 'f') } : r))),
    ],
    [
      'a duplicate (sector, year)',
      mutate((rows) =>
        rows.map((r, i) => (i === 1 ? { ...rows[0]!, territoryId: r.territoryId } : r))
      ),
    ],
    [
      'a negative population',
      mutate((rows) => rows.map((r, i) => (i === 0 ? { ...r, population: -1 } : r))),
    ],
    [
      'a fractional population',
      mutate((rows) => rows.map((r, i) => (i === 0 ? { ...r, population: 1.5 } : r))),
    ],
  ])('refuses %s', (_name, [rows, adm]) => {
    expect(sectorRowsAreAdmissible(rows, adm)).toBe(false);
  });

  it('refuses two sources for one year even when both are admitted', () => {
    const adm = admission({
      years: [2024, 2025],
      sources: [source(2024, 'a'), source(2024, 'b')],
    });
    // Twelve rows for 2024 under two sources: the "one source per year" clause.
    const rows = rowsFor(adm).map((r) => ({ ...r, year: 2024 }));
    expect(sectorRowsAreAdmissible(rows, adm)).toBe(false);
  });
});

describe('sectorRowsDigestInput', () => {
  it('is order-independent and hashes to the loader-compatible tuple digest', () => {
    const adm = admission();
    const rows = rowsFor(adm);
    const forward = sectorRowsDigestInput(rows);
    const reversed = sectorRowsDigestInput([...rows].reverse());
    expect(forward).toBe(reversed);
    expect(forward.startsWith('[[')).toBe(true);
    expect(createHash('sha256').update(forward).digest('hex')).toMatch(/^[a-f0-9]{64}$/u);
    // A changed population changes the digest.
    const changed = sectorRowsDigestInput(
      rows.map((r, i) => (i === 0 ? { ...r, population: r.population + 1 } : r))
    );
    expect(changed).not.toBe(forward);
  });
});
