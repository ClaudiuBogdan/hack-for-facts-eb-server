/**
 * Admission of the reviewed Bucharest sector publications that supplement the
 * native POP107D gaps (moved from `src/app/native-sector-population.ts`,
 * review X/F6). Pure: the checks that need no database live here, table-tested;
 * the shell reads the admitted rows and re-validates them with `validateSectorRows`.
 *
 * Every admitted year is validated even for one sector; partial publications
 * are never mixed.
 */
import type { AnnualPopulationAdmission } from './annual-population.js';

export interface SectorPopulationAdmission {
  readonly ins: Pick<
    AnnualPopulationAdmission,
    'datasetCode' | 'revisionId' | 'custodySha256' | 'transformContractSha256'
  >;
  /** Omitted preserves the original 2024/2025 admission contract. */
  readonly years?: readonly number[];
  readonly sources: readonly string[];
  readonly rowsSha256: string;
}

/** The six Bucharest sectors (SIRUTA), the only territories a sector admission may name. */
export const BUCHAREST_SECTOR_SIRUTAS = [
  '179141',
  '179150',
  '179169',
  '179178',
  '179187',
  '179196',
] as const;

/** Exactly the year-set shapes ever admitted; anything else is a new publication to review. */
export const ADMITTED_SECTOR_YEAR_SETS: readonly (readonly number[])[] = [
  [2024, 2025],
  [2017, 2018, 2019, 2022, 2023, 2024, 2025],
  [2017, 2018, 2019, 2020, 2022, 2023, 2024, 2025],
];

export const DEFAULT_SECTOR_YEARS: readonly number[] = [2024, 2025];

export const sectorAdmissionYears = (admission: SectorPopulationAdmission): readonly number[] =>
  admission.years ?? DEFAULT_SECTOR_YEARS;

const SHA256_RE = /^[a-f0-9]{64}$/u;

/** Checks that need no database: year-set shape, sources, digest format, INS identity match. */
export const sectorAdmissionIsWellFormed = (
  annual: Pick<
    AnnualPopulationAdmission,
    'datasetCode' | 'revisionId' | 'custodySha256' | 'transformContractSha256'
  >,
  admission: SectorPopulationAdmission
): boolean => {
  const years = sectorAdmissionYears(admission);
  const orderedYears = [...years].sort((a, b) => a - b);
  return (
    ADMITTED_SECTOR_YEAR_SETS.some(
      (allowed) =>
        allowed.length === orderedYears.length &&
        allowed.every((year, index) => year === orderedYears[index])
    ) &&
    admission.sources.length === years.length &&
    new Set(admission.sources).size === years.length &&
    SHA256_RE.test(admission.rowsSha256) &&
    annual.datasetCode === admission.ins.datasetCode &&
    annual.revisionId === admission.ins.revisionId &&
    annual.custodySha256 === admission.ins.custodySha256 &&
    annual.transformContractSha256 === admission.ins.transformContractSha256
  );
};

export interface SectorPopulationRowLike {
  readonly territoryId: number;
  readonly siruta: string;
  readonly year: number;
  readonly population: number;
  readonly source: string;
  readonly sourceUrl: string;
  readonly canonicalSector: boolean;
}

/** Every row is a canonical sector, an admitted year and source, one source per year, complete and unique. */
export const sectorRowsAreAdmissible = (
  rows: readonly SectorPopulationRowLike[],
  admission: SectorPopulationAdmission
): boolean => {
  const years = sectorAdmissionYears(admission);
  const expectedRows = years.length * BUCHAREST_SECTOR_SIRUTAS.length;
  return (
    rows.length === expectedRows &&
    new Set(rows.map((row) => row.source)).size === years.length &&
    !rows.some(
      (row) =>
        !row.canonicalSector ||
        !BUCHAREST_SECTOR_SIRUTAS.some((siruta) => siruta === row.siruta) ||
        !years.includes(row.year) ||
        !admission.sources.includes(row.source) ||
        !new RegExp(`^ins-bucharest-domicile-jan1:${String(row.year)}:[a-f0-9]{64}$`, 'u').test(
          row.source
        ) ||
        !Number.isSafeInteger(row.population) ||
        row.population < 0
    ) &&
    new Set(rows.map((row) => JSON.stringify([row.siruta, row.year]))).size === expectedRows &&
    !years.some(
      (year) => new Set(rows.filter((row) => row.year === year).map((row) => row.source)).size !== 1
    )
  );
};

/**
 * Byte-compatible with the loader's stable tuple digest: the sorted JSON of
 * `[siruta, year, population, source, sourceUrl]` tuples (the source URL
 * carries the object version). Hashing is the shell's job; this is the input.
 */
export const sectorRowsDigestInput = (rows: readonly SectorPopulationRowLike[]): string => {
  const tuples = rows.map((row) => [
    row.siruta,
    row.year,
    row.population,
    row.source,
    row.sourceUrl,
  ]);
  tuples.sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return JSON.stringify(tuples);
};
