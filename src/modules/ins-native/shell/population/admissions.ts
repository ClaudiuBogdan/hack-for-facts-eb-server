/**
 * The admitted population publications the kernel build serves (moved from
 * `src/app/native-map-population.ts`, review X/F6). Pins stay in code by owner
 * decision (N/N3): a scrapper re-publication fails closed until re-admitted here.
 */
import type { AnnualPopulationAdmission } from '../../core/annual-population.js';
import type { SectorPopulationAdmission } from '../../core/population-admission.js';

/** POP107D publication verified against original INS responses on 2026-09-07.
 * All 24 source samples match, including the canonical county union against
 * national totals. Exact-year coverage is checked on every read; missing
 * historical cells stay unavailable. Municipal sector coverage is separately admitted. A new publication must be re-admitted.
 * Source: https://statistici.insse.ro/tempoins/index.jsp?ind=POP107D&lang=ro&page=tempo3
 */
export const NATIVE_MAP_POPULATION_ADMISSION: AnnualPopulationAdmission = {
  datasetCode: 'POP107D',
  revisionId: '1051',
  custodySha256: '429008f7bdb642aff655a0b1c93cdf6db54f0a04433eb0a2db6fed0183555ad6',
  transformContractSha256: 'bddc45cd6e97a8f93f0c0d6f33fe82d6dad5597cb5b29336c2069147d27a4d2d',
  ageDimension: 0,
  allAgesMember: 1,
  sexDimension: 1,
  allSexesMember: 105,
  personsUnit: 9685,
};

/** Forty-two definitive cells plus six provisional 2020 cells from immutable INS originals.
 * Provisional manifest SHA256 e2226757910160657247d48946246026f62411aefdd4706932f700758970f5b2.
 * Status is disclosed in shared population methodology; result schemas are unchanged.
 * Historical manifest SHA256 a58dac6ccaa695b3caa6709aa1496437bef96ac1b496ef630af91e57a23449f0;
 * prior 2024/2025 manifest SHA256 b3d2063f4b8bebe13e3638c13bfd97cc1feeccbf273be060babd9c20b0e5ea72.
 * Historical sector totals may differ from the native city publication: both
 * remain unchanged by explicit user decision. Unsupported years stay unavailable.
 */
export const NATIVE_SECTOR_POPULATION_ADMISSION: SectorPopulationAdmission = {
  ins: NATIVE_MAP_POPULATION_ADMISSION,
  years: [2017, 2018, 2019, 2020, 2022, 2023, 2024, 2025],
  sources: [
    'ins-bucharest-domicile-jan1:2017:6144e8983c33c87c43aa6ec1af314be5c8e49150f44d16b5e545fdae83abf7f7',
    'ins-bucharest-domicile-jan1:2018:348cfa49fc76c5ce22725975c4103b9501fe2dfcdc7ddc65b09224d57dd49165',
    'ins-bucharest-domicile-jan1:2019:2ad9bca6b0594a72488dbc5be178833cca05f1b0758d00ab89db3a32fe8011e3',
    'ins-bucharest-domicile-jan1:2020:2ad9bca6b0594a72488dbc5be178833cca05f1b0758d00ab89db3a32fe8011e3',
    'ins-bucharest-domicile-jan1:2022:3a1a9a88e9bad46abf70d3068186ca58509c48512abe818251f2cb0e93559cc5',
    'ins-bucharest-domicile-jan1:2023:e33aecd82cfe69772e28c4c6c1217a4f90abcde428d6db77405e4885e6003b16',
    'ins-bucharest-domicile-jan1:2024:1c987ddd6c399f144aa4cbec60c1cb8c679c28a9096aca279dbc861c97438796',
    'ins-bucharest-domicile-jan1:2025:a630961aa07668b72e93bd71b4a0ea1f533c816547254aa758270534d38c5501',
  ],
  rowsSha256: '653ac8066d10e729c22a33a30feba97bba52068d45e0509e94f070b473b5da18',
};
