/**
 * E2E — the INS native repository over the REAL scrapper DDL (PostgreSQL 18):
 * the eight `ins` prod migrations (content-pinned) + the lane's identity index,
 * seeded with the same small world the unit-test fake models, then driven
 * through the usecases exactly as the resolvers do.
 *
 * What reaches outside the implementation:
 *  - the fact rows a resolved query returns are asserted by VALUE (the seed
 *    encodes territory/year in the value), computed by hand, not by the repo;
 *  - EXPLAIN proves a fully pinned series probes `observations_source_coordinate`
 *    and prunes to one partition, and a mixed-territory comparison never
 *    reads a cross-product row;
 *  - the diacritic-insensitive searches and the `limit + 1` page contract are
 *    exercised against real SQL, not the fake.
 *
 * Connection: `E2E_INS_PG_URL` (else `E2E_BUDGET_PG_URL`): a throwaway Postgres
 * on a loopback host (an SSH tunnel to the zeus docker host in practice), else a
 * local testcontainer. Skips locally without either; FAILS under `CI` /
 * `TEST_E2E_REQUIRED=1`. The scrapper checkout is `SCRAPPER_REPO_ROOT` or the
 * sibling checkout; the eight migrations must match `MIGRATION_SHA256`.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import {
  listDatasets,
  listDimensionValues,
  listLatestValues,
  listObservations,
  listTerritories,
  uatDashboard,
} from '@/modules/ins-native/core/usecases.js';
import { makeInsRepo } from '@/modules/ins-native/shell/repo/ins-repo.js';
import {
  INS_SUPPORTED_TRANSFORMS,
  INS_GEO_FLAG_KINDS,
  INS_SUPPORTED_GEO_FLAGS,
} from '@/modules/ins-native/shell/repo/publication.js';
import {
  INS_OPERATION_TIMEOUT_MS,
  makeInsReadSession,
} from '@/modules/ins-native/shell/repo/read-session.js';
import { createProdDb } from '@/modules/shared/shell/db/pool.js';

import { registerInsDefaultSeriesCases } from './ins-native-default-series-cases.js';
import { registerInsEntityBridgeCases } from './ins-native-entity-bridge-cases.js';
import { registerInsGeographyCases } from './ins-native-geography-cases.js';
import { registerInsPublicationCases } from './ins-native-publication-cases.js';

import type { InsRepo } from '@/modules/ins-native/core/ports.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

const dockerCliUp = (): boolean => {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

const resolveScrapperRoot = (): string | undefined => {
  const explicit = process.env['SCRAPPER_REPO_ROOT'];
  const candidates = [
    ...(explicit !== undefined && explicit !== '' ? [explicit] : []),
    path.resolve(process.cwd(), '..', 'hack-for-facts-eb-scrapper'),
    path.resolve(process.cwd(), '..', '..', '..', '..', 'hack-for-facts-eb-scrapper'),
  ];
  return candidates.find((c) => fs.existsSync(path.join(c, 'src', 'db', 'prod-migrations')));
};

/** Content pins of the INS prod migrations, including complete geography (669746b5). */
const MIGRATION_SHA256: Readonly<Record<string, string>> = {
  '20260811T140000__ins_prod_schema.ts':
    '7a4c6bf0a386e68f3485773e8252ace9651a45da93daeabb698b34aa4d2961d2',
  '20260811T141000__ins_pivot_custody.ts':
    '6f0b96cdab5904e2cde4c1f4641c46c604f632a33b99692401ab849d5a5bd4b3',
  '20260811T142000__ins_chunk_request_key_deferrable.ts':
    '7525f0990a7be74a98ca4f418a3bb220af5865a4bc6ae2bca140febb4f166ff1',
  '20260815T100000__ins_logical_counters.ts':
    '1ffc7dc9ec1050cd9fbe132093db9fdc1ae746fb31aab21aa1c448d046be0002',
  '20260815T101000__ins_member_territory.ts':
    'fcb4bd8f8cba80a2b6ba43c2e49eda64e1695e7d4a18c5b379e72087ebf24ee1',
  '20260818T170000__ins_dataset_revisions.ts':
    '39e1bebe29cdb0657d2c4d7e21eeeb29dd783e8a24f5c7582934a0960917cced',
  '20260903T100000__ins_serving_catalogs.ts':
    '2e8038b5430817b06cdf99d925572556ae4b701747c950ad1bd3be857df60df4',
  '20260905T120000__ins_geographic_coordinates.ts':
    '74d4bb4c13cfc840146810b0f2b5858b20c8d5c7d3f667a350c6b6cec85c7966',
};
const MIGRATIONS = Object.keys(MIGRATION_SHA256);

const REQUIRED =
  (process.env['CI'] !== undefined && process.env['CI'] !== '' && process.env['CI'] !== 'false') ||
  process.env['TEST_E2E_REQUIRED'] === '1';

let container: StartedPostgreSqlContainer | undefined;
let pgClient: pg.Client | undefined;
let db: Kysely<ProdDatabase> | undefined;
let repo: InsRepo | undefined;
let ready = false;
let unavailableReason: string | undefined;

const unavailable = (reason: string): void => {
  unavailableReason = reason;
  if (REQUIRED) throw new Error(`ins-native e2e is REQUIRED but cannot run: ${reason}`);
  console.warn(`${reason} — ins-native e2e SKIPPED.`);
};

const it = (name: string, fn: () => Promise<void>, timeout?: number): void => {
  vitestIt(
    name,
    async () => {
      if (!ready) {
        console.warn(`skipped (${unavailableReason ?? 'not ready'}): ${name}`);
        return;
      }
      await fn();
    },
    timeout
  );
};

const assertScrapperMigrations = (scrapperRoot: string): void => {
  const dir = path.join(scrapperRoot, 'src', 'db', 'prod-migrations');
  for (const [file, expected] of Object.entries(MIGRATION_SHA256)) {
    const actual = createHash('sha256')
      .update(fs.readFileSync(path.join(dir, file)))
      .digest('hex');
    if (actual !== expected) {
      throw new Error(
        `scrapper migration content drift: ${file} sha256 ${actual} != pinned ${expected}`
      );
    }
  }
};

const SHA = 'b'.repeat(64);

// ── seed: the same world as tests/unit/ins-native/fake-repo.ts ───────────────

const seed = async (client: pg.Client): Promise<void> => {
  await client.query(`
    -- the lane's identity index (built by run-lane constrain, not by a migration)
    create unique index if not exists observations_source_coordinate
      on ins.observations (dataset_code, dim1_member_id, dim2_member_id, dim3_member_id,
                           dim4_member_id, dim5_member_id, dim6_member_id, dim7_member_id,
                           time_nom_item_id, unit_nom_item_id) nulls not distinct;
    create table ins.observations_poptest partition of ins.observations for values in ('POPTEST');

    insert into ins.territory_nodes (territory_id, code, siruta_code, level, name_ro, name_search, parent_id, source_url) values
      (1, 'RO', null, 'NATIONAL', 'TOTAL', 'total', null, 'http://x/nuts'),
      (2, 'RO1', null, 'NUTS1', 'MACROREGIUNEA UNU', 'macroregiunea unu', 1, 'http://x/nuts'),
      (6, 'RO11', null, 'NUTS2', 'Nord-Vest', 'nord-vest', 2, 'http://x/nuts'),
      (25, 'CJ', null, 'NUTS3', 'Cluj', 'cluj', 6, 'http://x/nuts'),
      (14, 'AB', null, 'NUTS3', 'Alba', 'alba', 6, 'http://x/nuts'),
      (931, '54975', '54975', 'LAU', 'MUNICIPIUL CLUJ-NAPOCA', 'municipiul cluj-napoca', 25, 'http://x/siruta'),
      (56, '1017', '1017', 'LAU', 'MUNICIPIUL ALBA IULIA', 'municipiul alba iulia', 14, 'http://x/siruta'),
      (57, '1213', '1213', 'LAU', 'MUNICIPIUL AIUD', 'municipiul aiud', 14, 'http://x/siruta');

    insert into ins.contexts (context_code, parent_code, level, name_ro, name_en, name_search, path, ordinal, source_url) values
      ('1', null, 0, 'A. STATISTICA SOCIALA', 'A. SOCIAL STATISTICS', 'a. statistica sociala', 'A. STATISTICA SOCIALA', 1, 'http://x/ctx'),
      ('10', '1', 1, 'POPULAȚIE', 'POPULATION', 'populatie', 'A. STATISTICA SOCIALA > POPULATIE', 1, 'http://x/ctx');

    insert into ins.harvest_generations (generation_id, matrix_code, metadata_sha256, dimension_fingerprint, source_url) values
      (1, 'POPTEST', '${SHA}', '${SHA}', 'http://x/matrix/POPTEST'),
      (2, 'CNTTEST', '${SHA}', '${SHA}', 'http://x/matrix/CNTTEST'),
      (3, 'EMPTYTEST', '${SHA}', '${SHA}', 'http://x/matrix/EMPTYTEST');

    insert into ins.nomenclature_items (nom_item_id, label_ro, label_en, label_normalised, first_seen_generation) values
      (1, 'Total', 'Total', 'TOTAL', 1), (2, '0-4 ani', '0-4 years', '0-4 ANI', 1), (3, '5-9 ani', '5-9 years', '5-9 ANI', 1),
      (105, 'Total', 'Total', 'TOTAL', 1), (106, 'Masculin', 'Male', 'MASCULIN', 1), (107, 'Feminin', 'Female', 'FEMININ', 1),
      (3064, 'TOTAL', 'TOTAL', 'TOTAL', 1), (3075, 'Cluj', 'Cluj', 'CLUJ', 1), (3065, 'Alba', 'Alba', 'ALBA', 1),
      (112, 'TOTAL', 'TOTAL', 'TOTAL', 1), (931, '54975 MUNICIPIUL CLUJ-NAPOCA', null, '54975 MUNICIPIUL CLUJ-NAPOCA', 1),
      (113, '1017 MUNICIPIUL ALBA IULIA', null, '1017 MUNICIPIUL ALBA IULIA', 1),
      (4399, 'Anul 2019', 'Year 2019', 'ANUL 2019', 1), (4418, 'Anul 2020', 'Year 2020', 'ANUL 2020', 1), (4437, 'Anul 2021', 'Year 2021', 'ANUL 2021', 1),
      (9685, 'Numar persoane', 'Number of persons', 'NUMAR PERSOANE', 1),
      (8000, 'TOTAL', 'TOTAL', 'TOTAL', 2), (8001, 'Regiunea NORD-VEST', null, 'REGIUNEA NORD-VEST', 2), (8002, 'Cluj', 'Cluj', 'CLUJ', 2),
      (9507, 'Lei', 'Lei', 'LEI', 2), (9508, 'Euro', 'Euro', 'EURO', 2),
      (7001, 'Tip A', null, 'TIP A', 3), (7002, 'Tip B', null, 'TIP B', 3);

    insert into ins.periods (period_id, periodicity, period_start, period_end, label_ro) overriding system value values
      (28, 'ANNUAL', '2019-01-01', '2019-12-31', 'Anul 2019'),
      (29, 'ANNUAL', '2020-01-01', '2020-12-31', 'Anul 2020'),
      (30, 'ANNUAL', '2021-01-01', '2021-12-31', 'Anul 2021');

    insert into ins.datasets (dataset_code, generation_id, matrix_name_ro, matrix_name_en, name_lang, context_code, context_path,
      dimension_count, classification_dim_count, time_dim_index, unit_dim_index, periodicities, unit_option_count,
      ultima_actualizare_date, load_status, rows_loaded, source_url, pivot_custody_sha256, pivot_custody_algo,
      pivot_custody_requests, pivot_custody_applied_rows, pivot_custody_applied_generation, territory_dim_index, territory_resolution) values
      ('POPTEST', 1, 'Populația după domiciliu', 'Population by domicile', 'en', '10', 'A. STATISTICA SOCIALA > POPULATIE',
        6, 4, 4, 5, '{ANNUAL}', 1, '2026-08-04', 'loaded', 135, 'http://x/matrix/POPTEST', '${SHA}', 2, 1, 135, 1, 3, 'RESOLVED'),
      ('CNTTEST', 2, 'Cifra de afaceri pe județe', 'Turnover by county', 'en', '10', 'A. STATISTICA SOCIALA > POPULATIE',
        3, 1, 1, 2, '{ANNUAL}', 2, '2026-08-04', 'loaded', 12, 'http://x/matrix/CNTTEST', '${SHA}', 2, 1, 12, 2, 0, 'RESOLVED'),
      ('EMPTYTEST', 3, 'Set fără date', 'Empty set', 'en', '10', 'A. STATISTICA SOCIALA > POPULATIE',
        3, 1, 1, 2, '{ANNUAL}', 1, '2026-08-04', 'loaded', 0, 'http://x/matrix/EMPTYTEST', null, null, null, null, null, null, null);

    insert into ins.dataset_dimensions (dataset_code, dim_index, slot_index, semantic_role, label_ro, label_en, option_count) values
      ('POPTEST', 0, 1, 'classification', 'Varste si grupe de varsta', 'Age groups', 3),
      ('POPTEST', 1, 2, 'classification', 'Sexe', 'Sex', 3),
      ('POPTEST', 2, 3, 'classification', 'Judete', 'Counties', 3),
      ('POPTEST', 3, 4, 'classification', 'Localitati', 'Localities', 3),
      ('POPTEST', 4, null, 'time', 'Ani', 'Years', 3),
      ('POPTEST', 5, null, 'unit', 'UM: Numar persoane', 'UM', 1),
      ('CNTTEST', 0, 1, 'classification', 'Macroregiuni, regiuni de dezvoltare si judete', null, 3),
      ('CNTTEST', 1, null, 'time', 'Ani', null, 2),
      ('CNTTEST', 2, null, 'unit', 'UM', null, 2),
      ('EMPTYTEST', 0, 1, 'classification', 'Tipuri', null, 2),
      ('EMPTYTEST', 1, null, 'time', 'Ani', null, 1),
      ('EMPTYTEST', 2, null, 'unit', 'UM', null, 1);

    insert into ins.dataset_dimension_members (dataset_code, dim_index, nom_item_id, ordinal, member_role, role_signals) values
      ('POPTEST', 0, 1, 1, 'TOTAL', '{label_total}'), ('POPTEST', 0, 2, 2, 'LEAF', '{}'), ('POPTEST', 0, 3, 3, 'LEAF', '{}'),
      ('POPTEST', 1, 105, 1, 'TOTAL', '{label_total}'), ('POPTEST', 1, 106, 2, 'LEAF', '{}'), ('POPTEST', 1, 107, 3, 'LEAF', '{}'),
      ('POPTEST', 2, 3064, 1, 'TOTAL', '{label_total}'), ('POPTEST', 2, 3075, 2, 'LEAF', '{}'), ('POPTEST', 2, 3065, 3, 'LEAF', '{}'),
      ('POPTEST', 3, 112, 1, 'TOTAL', '{label_total}'), ('POPTEST', 3, 931, 2, 'LEAF', '{}'), ('POPTEST', 3, 113, 3, 'LEAF', '{}'),
      ('POPTEST', 4, 4399, 1, 'UNKNOWN', '{}'), ('POPTEST', 4, 4418, 2, 'UNKNOWN', '{}'), ('POPTEST', 4, 4437, 3, 'UNKNOWN', '{}'),
      ('POPTEST', 5, 9685, 1, 'UNKNOWN', '{}'),
      ('CNTTEST', 0, 8000, 1, 'TOTAL', '{label_total}'), ('CNTTEST', 0, 8001, 2, 'LEAF', '{}'), ('CNTTEST', 0, 8002, 3, 'LEAF', '{}'),
      ('CNTTEST', 1, 4399, 1, 'UNKNOWN', '{}'), ('CNTTEST', 1, 4418, 2, 'UNKNOWN', '{}'),
      ('CNTTEST', 2, 9507, 1, 'UNKNOWN', '{}'), ('CNTTEST', 2, 9508, 2, 'UNKNOWN', '{}'),
      ('EMPTYTEST', 0, 7001, 1, 'LEAF', '{}'), ('EMPTYTEST', 0, 7002, 2, 'LEAF', '{}'),
      ('EMPTYTEST', 1, 4399, 1, 'UNKNOWN', '{}'), ('EMPTYTEST', 2, 9685, 1, 'UNKNOWN', '{}');

    insert into ins.member_territory (dataset_code, dim_index, nom_item_id, territory_id, territory_level, siruta_code, territory_code, method, resolution) values
      ('POPTEST', 2, 3064, null, null, null, null, 'county-name', 'TOTAL_MEMBER'),
      ('POPTEST', 2, 3075, 25, 'NUTS3', null, 'CJ', 'county-name', 'RESOLVED'),
      ('POPTEST', 2, 3065, 14, 'NUTS3', null, 'AB', 'county-name', 'RESOLVED'),
      ('POPTEST', 3, 112, null, null, null, null, 'locality-prefix', 'TOTAL_MEMBER'),
      ('POPTEST', 3, 931, 931, 'LAU', '54975', '54975', 'locality-prefix', 'RESOLVED'),
      ('POPTEST', 3, 113, 56, 'LAU', '1017', '1017', 'locality-prefix', 'RESOLVED'),
      ('CNTTEST', 0, 8000, null, null, null, null, 'reg-j-name', 'TOTAL_MEMBER'),
      ('CNTTEST', 0, 8001, 6, 'NUTS2', null, 'RO11', 'reg-j-name', 'RESOLVED'),
      ('CNTTEST', 0, 8002, 25, 'NUTS3', null, 'CJ', 'reg-j-name', 'RESOLVED');

    insert into ins.measures (dataset_code, unit_nom_item_id, unit_label_ro, scale_factor, base_unit, unit_kind) values
      ('POPTEST', 9685, 'Numar persoane', 1, 'persons', 'non-monetary'),
      ('CNTTEST', 9507, 'Lei', 1, 'currency', 'monetary'), ('CNTTEST', 9508, 'Euro', 1, 'currency', 'monetary'),
      ('EMPTYTEST', 9685, 'Numar', 1, null, 'non-monetary');
    insert into ins.currency_regimes (dataset_code, unit_nom_item_id, regime, evidence_method, confidence, ruleset_version) values
      ('CNTTEST', 9507, 'RON', 'label', 'label', 'r6'), ('CNTTEST', 9508, 'EUR', 'label', 'label', 'r6');

    insert into ins.dataset_coverage (dataset_code, custody_sha256, observation_count, first_period_start, last_period_end,
      periodicities_observed, has_lau, has_county, has_region, has_national, definition_ro, name_search) values
      ('POPTEST', '${SHA}', 135, '2019-01-01', '2021-12-31', '{ANNUAL}', true, true, false, true, 'Numarul persoanelor cu domiciliul', 'populatia dupa domiciliu population by domicile poptest'),
      ('CNTTEST', '${SHA}', 12, '2019-01-01', '2020-12-31', '{ANNUAL}', false, true, true, true, null, 'cifra de afaceri pe judete turnover by county cnttest');

    insert into ins.dataset_revisions (dataset_code,to_custody_sha256,to_custody_algo,
      to_custody_requests,to_applied_generation,transform_contract_sha256,rows_before,rows_after,
      coordinates_added,coordinates_removed,coordinates_changed,after_fact_digest_sha256,load_run_id)
    select dataset_code,pivot_custody_sha256,2,1,generation_id,'${INS_SUPPORTED_TRANSFORMS[0]}',
      0,rows_loaded,rows_loaded,0,0,'${SHA}',1 from ins.datasets where dataset_code <> 'EMPTYTEST';
    insert into ins.dataset_geo_dimensions
      (dataset_code,dim_index,slot_index,role,method,contract_version,custody_sha256) values
      ('POPTEST',2,3,'nested_parent','county-name','ins-geography-v1','${SHA}'),
      ('POPTEST',3,4,'nested_child','locality-prefix','ins-geography-v1','${SHA}'),
      ('CNTTEST',0,1,'single','reg-j-name','ins-geography-v1','${SHA}');
    insert into ins.dataset_geo_tuples
      (dataset_code,geo_pairs,resolution,territory_id,flags,has_modern_facts,
       has_qualified_facts,has_incoherent_facts,contract_version,custody_sha256) values
      ('POPTEST','[[2,3064],[3,112]]','EXACT',1,'{}',true,false,false,'ins-geography-v1','${SHA}'),
      ('POPTEST','[[2,3075],[3,112]]','EXACT',25,'{}',true,false,false,'ins-geography-v1','${SHA}'),
      ('POPTEST','[[2,3065],[3,112]]','EXACT',14,'{}',true,false,false,'ins-geography-v1','${SHA}'),
      ('POPTEST','[[2,3075],[3,931]]','EXACT',931,'{}',true,false,false,'ins-geography-v1','${SHA}'),
      ('POPTEST','[[2,3065],[3,113]]','EXACT',56,'{}',true,false,false,'ins-geography-v1','${SHA}'),
      ('CNTTEST','[[0,8000]]','EXACT',1,'{}',true,false,false,'ins-geography-v1','${SHA}'),
      ('CNTTEST','[[0,8001]]','EXACT',6,'{}',true,false,false,'ins-geography-v1','${SHA}'),
      ('CNTTEST','[[0,8002]]','EXACT',25,'{}',true,false,false,'ins-geography-v1','${SHA}');
    update ins.dataset_coverage set geo_contract_version='ins-geography-v1',
      geo_dimension_count=case dataset_code when 'POPTEST' then 2 else 1 end,
      geo_tuple_count=case dataset_code when 'POPTEST' then 5 else 3 end,geo_rule_count=0;

    insert into ins.default_series (dataset_code, dim_index, nom_item_id, policy, manifest_version) values
      ('POPTEST', 0, 1, 'TOTAL_MEMBER', 'v1'), ('POPTEST', 1, 105, 'TOTAL_MEMBER', 'v1'),
      ('POPTEST', 2, 3064, 'TOTAL_MEMBER', 'v1'), ('POPTEST', 3, 112, 'TOTAL_MEMBER', 'v1'),
      ('POPTEST', 5, 9685, 'SINGLE_UNIT', 'v1'),
      ('CNTTEST', 0, 8000, 'TOTAL_MEMBER', 'v1');

    insert into ins.observation_chunks (response_id, dataset_code, generation_id, request_key, enc_query, source_url, physical_row_count, parsed_at) values
      (1, 'POPTEST', 1, 'ins:pivot:POPTEST:1', '1', 'http://x/pivot', 135, now()),
      (2, 'CNTTEST', 2, 'ins:pivot:CNTTEST:1', '1', 'http://x/pivot', 12, now());
  `);

  // Facts: value encodes territory tag / age / sex / year, as in the fake.
  const rows: string[] = [];
  const years: [number, number][] = [
    [4399, 28],
    [4418, 29],
    [4437, 30],
  ];
  for (const [time, period] of years) {
    const y = String(2019 + (period - 28));
    for (const age of [1, 2, 3]) {
      for (const sex of [105, 106, 107]) {
        const add = (county: number, loc: number, tag: string, siruta: string | null): void => {
          rows.push(
            `('POPTEST', ${String(age)}, ${String(sex)}, ${String(county)}, ${String(loc)}, ${String(time)}, 9685, ${String(period)}, '${y}-01-01', '${y}-12-31', ${siruta === null ? 'null' : `'${siruta}'`}, ${String(period * 10000 + age * 1000 + sex)}, 1)`
          );
          void tag;
        };
        add(3064, 112, 'RO', null);
        add(3075, 112, 'CJ', null);
        add(3065, 112, 'AB', null);
        add(3075, 931, 'CLJ', '54975');
        add(3065, 113, 'ALB', '1017');
      }
    }
  }
  await client.query(`
    insert into ins.observations (dataset_code, dim1_member_id, dim2_member_id, dim3_member_id, dim4_member_id,
      time_nom_item_id, unit_nom_item_id, period_id, period_start, period_end, territory_siruta_code, value, response_id)
    values ${rows.join(',\n')};
    insert into ins.observations (dataset_code, dim1_member_id, time_nom_item_id, unit_nom_item_id, period_id, period_start, period_end, value, response_id) values
      ('CNTTEST', 8000, 4399, 9507, 28, '2019-01-01', '2019-12-31', 100, 2), ('CNTTEST', 8000, 4418, 9507, 29, '2020-01-01', '2020-12-31', 110, 2),
      ('CNTTEST', 8001, 4399, 9507, 28, '2019-01-01', '2019-12-31', 20, 2), ('CNTTEST', 8001, 4418, 9507, 29, '2020-01-01', '2020-12-31', 22, 2),
      ('CNTTEST', 8002, 4399, 9507, 28, '2019-01-01', '2019-12-31', 5, 2), ('CNTTEST', 8002, 4418, 9507, 29, '2020-01-01', '2020-12-31', 6, 2),
      ('CNTTEST', 8000, 4399, 9508, 28, '2019-01-01', '2019-12-31', 21, 2), ('CNTTEST', 8000, 4418, 9508, 29, '2020-01-01', '2020-12-31', 23, 2),
      ('CNTTEST', 8001, 4399, 9508, 28, '2019-01-01', '2019-12-31', 4, 2), ('CNTTEST', 8001, 4418, 9508, 29, '2020-01-01', '2020-12-31', 5, 2),
      ('CNTTEST', 8002, 4399, 9508, 28, '2019-01-01', '2019-12-31', 1, 2), ('CNTTEST', 8002, 4418, 9508, 29, '2020-01-01', '2020-12-31', 2, 2);
    analyze ins.observations_poptest; analyze ins.observations_default;
  `);
};

/** value = period*10000 + age*1000 + sex → "year/age/sex" for readable assertions. */
const decode = (value: string | null): string => {
  const n = Number(value);
  const period = Math.floor(n / 10000);
  const age = Math.floor((n % 10000) / 1000);
  const sex = n % 1000;
  return `${String(2019 + (period - 28))}/${String(age)}/${String(sex)}`;
};

beforeAll(async () => {
  const url = process.env['E2E_INS_PG_URL'] ?? process.env['E2E_BUDGET_PG_URL'];
  let connectionString: string;
  if (url !== undefined && url !== '') {
    connectionString = url;
  } else if (dockerCliUp()) {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18').start();
    connectionString = container.getConnectionUri();
  } else {
    unavailable('no E2E_INS_PG_URL and no docker daemon');
    return;
  }
  const scrapperRoot = resolveScrapperRoot();
  if (scrapperRoot === undefined) {
    unavailable('scrapper checkout not found (SCRAPPER_REPO_ROOT)');
    return;
  }
  assertScrapperMigrations(scrapperRoot);
  const producer = (await import(
    pathToFileURL(path.join(scrapperRoot, 'src/sources/ins/prod/geography-manifest.ts')).href
  )) as Record<'INS_GEOGRAPHY_FLAG_KINDS', readonly { flag: string; kind: string }[]>;
  expect(INS_GEO_FLAG_KINDS).toEqual(
    Object.fromEntries(
      producer.INS_GEOGRAPHY_FLAG_KINDS.filter((f) => f.kind !== 'defect').map((f) => [
        f.flag,
        f.kind,
      ])
    )
  );
  expect([...INS_SUPPORTED_GEO_FLAGS].sort()).toEqual(
    producer.INS_GEOGRAPHY_FLAG_KINDS.filter((f) => f.kind !== 'defect')
      .map((f) => f.flag)
      .sort()
  );

  const target = new URL(connectionString);
  if (
    !new Set(['localhost', '127.0.0.1', '::1']).has(target.hostname) ||
    target.pathname.includes('transparenta_prod')
  ) {
    throw new Error(
      `refusing to run destructive e2e DDL against ${target.hostname}${target.pathname}`
    );
  }

  pgClient = new pg.Client({ connectionString });
  await pgClient.connect();
  await pgClient.query(
    'drop schema if exists ins cascade; create extension if not exists unaccent;'
  );
  // The kernel pool: int8/date/timestamp come back as wire strings, as in production.
  db = createProdDb({ connectionString, max: 4 }).db;
  for (const file of MIGRATIONS) {
    const mod = (await import(
      pathToFileURL(path.join(scrapperRoot, 'src', 'db', 'prod-migrations', file)).href
    )) as {
      up: (db: Kysely<unknown>) => Promise<void>;
    };
    await mod.up(db as Kysely<unknown>);
  }
  await seed(pgClient);
  repo = makeInsRepo(db);
  ready = true;
}, 240_000);

afterAll(async () => {
  if (db !== undefined) await db.destroy();
  if (pgClient !== undefined) await pgClient.end();
  if (container !== undefined) await container.stop();
});

const r = (): InsRepo => {
  if (repo === undefined) throw new Error('repo not ready');
  return repo;
};

/** Independent lock-state witness, bounded to this fixture's database. */
const waitForBlockedInsRead = async (writer: pg.Client): Promise<number> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await writer.query<{ pid: number }>(`
      select distinct locks.pid from pg_locks locks
      where locks.database = (select oid from pg_database where datname = current_database())
        and locks.relation = 'ins.datasets'::regclass and not locks.granted
        and pg_backend_pid() = any(pg_blocking_pids(locks.pid))
    `);
    if (state.rows.length === 1 && state.rows[0] !== undefined) return state.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('INS reader did not reach the fixture table lock within 100 polls');
};

describe('ins-native repository over the real scrapper DDL (e2e)', () => {
  registerInsEntityBridgeCases(it, () => {
    if (db === undefined) throw new Error('fixture not ready');
    return db;
  });
  registerInsGeographyCases(it, () => {
    if (db === undefined) throw new Error('fixture not ready');
    return db;
  });
  registerInsDefaultSeriesCases(it, () => {
    if (db === undefined) throw new Error('fixture not ready');
    return db;
  });
  registerInsPublicationCases(it, () => {
    if (db === undefined) throw new Error('fixture not ready');
    return db;
  });
  it('nested reads retain the publication snapshot while another connection publishes', async () => {
    if (pgClient === undefined) throw new Error('writer not ready');
    const writer = pgClient;
    const original = (await r().getDataset('POPTEST'))._unsafeUnwrap();
    if (original === null) throw new Error('seed dataset missing');
    const publishedName = 'A newer publication';
    try {
      const result = await r().withSnapshot(async (snapshot) => {
        const before = await snapshot.getDataset('POPTEST');
        expect(before._unsafeUnwrap()?.nameRo).toBe(original.nameRo);
        await writer.query('update ins.datasets set matrix_name_ro = $1 where dataset_code = $2', [
          publishedName,
          'POPTEST',
        ]);
        return snapshot.withSnapshot((nested) => nested.getDataset('POPTEST'));
      });
      expect(result._unsafeUnwrap()?.nameRo).toBe(original.nameRo);
      expect((await r().getDataset('POPTEST'))._unsafeUnwrap()?.nameRo).toBe(publishedName);
    } finally {
      await writer.query('update ins.datasets set matrix_name_ro = $1 where dataset_code = $2', [
        original.nameRo,
        'POPTEST',
      ]);
    }
  });

  it('operation sessions share one snapshot across parallel callers and reject reads after closing', async () => {
    if (db === undefined || pgClient === undefined) throw new Error('fixture not ready');
    const writer = pgClient;
    const original = (await r().getDataset('POPTEST'))._unsafeUnwrap();
    if (original === null) throw new Error('seed dataset missing');
    const session = makeInsReadSession(db);
    try {
      const [first, second] = await Promise.all([session.getRepo(), session.getRepo()]);
      const scoped = first._unsafeUnwrap();
      expect(second._unsafeUnwrap()).toBe(scoped);
      expect((await scoped.getDataset('POPTEST'))._unsafeUnwrap()?.nameRo).toBe(original.nameRo);
      await writer.query('update ins.datasets set matrix_name_ro = $1 where dataset_code = $2', [
        'Published after session read',
        'POPTEST',
      ]);
      const again = await second
        ._unsafeUnwrap()
        .withSnapshot((nested) => nested.getDataset('POPTEST'));
      expect(again._unsafeUnwrap()?.nameRo).toBe(original.nameRo);
      const closing = session.close();
      expect(session.close()).toBe(closing);
      expect((await closing).isOk()).toBe(true);
      expect((await session.getRepo())._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
      expect((await scoped.getDataset('POPTEST'))._unsafeUnwrapErr().type).toBe(
        'ServiceUnavailable'
      );
      expect((await r().getDataset('POPTEST'))._unsafeUnwrap()?.nameRo).toBe(
        'Published after session read'
      );
    } finally {
      await session.close();
      await writer.query('update ins.datasets set matrix_name_ro = $1 where dataset_code = $2', [
        original.nameRo,
        'POPTEST',
      ]);
    }
  });

  it('setup failure settles readiness and cleanup without reopening', async () => {
    const unavailable = createProdDb({
      connectionString: 'postgres://unused@127.0.0.1:1/unavailable',
      connectionTimeoutMillis: 500,
      max: 1,
    });
    const session = makeInsReadSession(unavailable.db);
    try {
      const failed = await session.getRepo();
      expect(failed.isErr()).toBe(true);
      expect((await session.getRepo())._unsafeUnwrapErr()).toEqual(failed._unsafeUnwrapErr());
      expect((await session.close())._unsafeUnwrapErr()).toEqual(failed._unsafeUnwrapErr());
    } finally {
      await session.close();
      await unavailable.db.destroy();
    }
  });

  it(
    'the operation deadline closes admission and releases the snapshot connection',
    async () => {
      if (db === undefined) throw new Error('fixture not ready');
      const session = makeInsReadSession(db);
      try {
        const scoped = (await session.getRepo())._unsafeUnwrap();
        expect((await scoped.getDataset('POPTEST')).isOk()).toBe(true);
        // Exercise the real production deadline; no timer or SQL cancellation mocks.
        await new Promise((resolve) => setTimeout(resolve, INS_OPERATION_TIMEOUT_MS + 100));
        expect((await session.getRepo())._unsafeUnwrapErr().type).toBe('Timeout');
        expect((await scoped.getDataset('POPTEST'))._unsafeUnwrapErr().type).toBe('Timeout');
        expect((await session.close()).isOk()).toBe(true);
      } finally {
        await session.close();
      }
      expect((await r().getDataset('POPTEST'))._unsafeUnwrap()?.code).toBe('POPTEST');
    },
    INS_OPERATION_TIMEOUT_MS + 15_000
  );

  it('closing while pool acquisition is pending releases the eventual connection', async () => {
    if (db === undefined) throw new Error('fixture not ready');
    const database = db;
    let releaseHolders!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHolders = resolve;
    });
    let signalAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    let holders = 0;
    // Occupy the fixture's four connections without a transaction or table lock.
    const leases = Array.from({ length: 4 }, () =>
      database.connection().execute(async () => {
        holders += 1;
        if (holders === 4) signalAcquired();
        await held;
      })
    );
    const session = makeInsReadSession(database);
    try {
      await acquired;
      const opening = session.getRepo();
      const closing = session.close();
      expect((await opening)._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
      releaseHolders();
      await Promise.all(leases);
      expect((await closing).isOk()).toBe(true);
      expect((await session.getRepo()).isErr()).toBe(true);
    } finally {
      releaseHolders();
      await Promise.all(leases);
      await session.close();
    }
    expect((await r().getDataset('POPTEST'))._unsafeUnwrap()?.code).toBe('POPTEST');
  });

  it('a failed read does not poison another field in the same operation snapshot', async () => {
    if (db === undefined) throw new Error('fixture not ready');
    const session = makeInsReadSession(db);
    try {
      const scoped = (await session.getRepo())._unsafeUnwrap();
      // Deliberately exercise PostgreSQL's negative-LIMIT error through the real
      // repository, below the usecase input guard, while another field is queued.
      const [failed, sibling] = await Promise.all([
        scoped.listDatasets({}, -1, 0),
        scoped.getDataset('POPTEST'),
      ]);
      expect(failed.isErr()).toBe(true);
      expect(sibling._unsafeUnwrap()?.code).toBe('POPTEST');
    } finally {
      expect((await session.close()).isOk()).toBe(true);
    }
  });

  it('failed savepoint recovery closes the session and settles queued fields', async () => {
    if (db === undefined || pgClient === undefined) throw new Error('fixture not ready');
    const writer = pgClient;
    const session = makeInsReadSession(db);
    const scoped = (await session.getRepo())._unsafeUnwrap();
    await writer.query('begin');
    try {
      await writer.query('lock table ins.datasets in access exclusive mode');
      const active = scoped.getDataset('POPTEST');
      const pid = await waitForBlockedInsRead(writer);
      const queued = scoped.getDataset('CNTTEST');
      // Only terminate the reader in this uniquely named throwaway database.
      await writer.query('select pg_terminate_backend($1)', [pid]);
      const [first, second] = await Promise.all([active, queued]);
      expect(first.isErr()).toBe(true);
      expect(second._unsafeUnwrapErr()).toEqual(first._unsafeUnwrapErr());
      expect((await session.close()).isErr()).toBe(true);
      expect((await session.getRepo()).isErr()).toBe(true);
    } finally {
      await writer.query('rollback');
      await session.close();
    }
    // The dead connection is released; a new operation can still serve data.
    expect((await r().getDataset('POPTEST'))._unsafeUnwrap()?.code).toBe('POPTEST');
  });

  it('closing an operation drains admitted reads before returning its connection', async () => {
    if (db === undefined || pgClient === undefined) throw new Error('fixture not ready');
    const writer = pgClient;
    const session = makeInsReadSession(db);
    const scoped = (await session.getRepo())._unsafeUnwrap();
    await writer.query('begin');
    try {
      await writer.query('lock table ins.datasets in access exclusive mode');
      const admitted = scoped.getDataset('POPTEST');
      await waitForBlockedInsRead(writer);
      const queued = scoped.getDataset('CNTTEST');
      let closed = false;
      const closing = session.close().then((result) => {
        closed = true;
        return result;
      });
      // A writer holds the table lock: the admitted read cannot finish yet.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(closed).toBe(false);
      expect((await scoped.getDataset('POPTEST')).isErr()).toBe(true);
      await writer.query('rollback');
      expect((await admitted)._unsafeUnwrap()?.code).toBe('POPTEST');
      expect((await queued)._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
      expect((await closing).isOk()).toBe(true);
    } finally {
      await writer.query('rollback');
      await session.close();
    }
  });

  it('catalog: datasets list loaded-only by default, the full catalog on demand, diacritic-insensitive search', async () => {
    const loaded = await listDatasets(r(), {}, 50, 0);
    expect(loaded._unsafeUnwrap().nodes.map((d) => d.code)).toEqual(['CNTTEST', 'POPTEST']);
    expect(loaded._unsafeUnwrap().totalCount).toBe(2);
    const all = await listDatasets(r(), { dataStatus: [] }, 50, 0);
    expect(all._unsafeUnwrap().nodes.map((d) => [d.code, d.dataStatus])).toEqual([
      ['CNTTEST', 'AVAILABLE'],
      ['EMPTYTEST', 'CATALOG_ONLY'],
      ['POPTEST', 'AVAILABLE'],
    ]);
    const search = await listDatasets(r(), { search: 'Populația' }, 50, 0);
    expect(search._unsafeUnwrap().nodes.map((d) => d.code)).toEqual(['POPTEST']);
    const pop = search._unsafeUnwrap().nodes[0];
    expect(pop?.yearRange).toEqual([2019, 2021]);
    expect(pop?.hasLau).toBe(true);
    expect(pop?.contextNameRo).toBe('POPULAȚIE');
    expect(pop?.definitionRo).toBe('Numarul persoanelor cu domiciliul');
  });

  it('catalog: territories search without diacritics, by SIRUTA, by level; parents are populated', async () => {
    const cluj = await listTerritories(r(), { search: 'cluj-napoca' }, 20, 0);
    expect(
      cluj._unsafeUnwrap().nodes.map((n) => [n.code, n.level, n.parentCode, n.parentNameRo])
    ).toEqual([['54975', 'LAU', 'CJ', 'Cluj']]);
    const counties = await listTerritories(r(), { levels: ['NUTS3'] }, 60, 0);
    expect(counties._unsafeUnwrap().nodes.map((n) => n.code)).toEqual(['AB', 'CJ']);
    const bySiruta = await listTerritories(r(), { sirutaCodes: ['1017'] }, 1, 0);
    expect(bySiruta._unsafeUnwrap().nodes[0]?.nameRo).toBe('MUNICIPIUL ALBA IULIA');
  });

  it('catalog: dimension values carry the bound territory, the period for time members, the unit for unit members', async () => {
    const loc = await listDimensionValues(r(), 'POPTEST', 3, undefined, 50, 0);
    expect(
      loc
        ._unsafeUnwrap()
        .nodes.map((m) => [m.nomItemId, m.territory?.code ?? null, m.territoryResolution])
    ).toEqual([
      [112, null, 'TOTAL_MEMBER'],
      [931, '54975', 'RESOLVED'],
      [113, '1017', 'RESOLVED'],
    ]);
    const time = await listDimensionValues(r(), 'POPTEST', 4, 'anul 2020', 50, 0);
    expect(time._unsafeUnwrap().nodes.map((m) => m.nomItemId)).toEqual([4418]);
    const periods = await r().periodsByLabels(['Anul 2020']);
    expect(periods._unsafeUnwrap()[0]?.periodStart).toBe('2020-01-01');
  });

  it('facts: the landing comparison (RO, CJ, 54975 with TOTAL on age/sex) returns exactly the nine intended rows, newest first', async () => {
    const page = await listObservations(r(), 'POPTEST', {
      territoryCodes: ['RO', 'CJ', '54975'],
      classificationValueCodes: ['TOTAL'],
      classificationTypeCodes: ['D0', 'D1'],
    });
    const rows = page._unsafeUnwrap();
    expect(rows.totalCount).toBe(9);
    expect(rows.nodes.map((o) => [o.territory?.code ?? 'RO', decode(o.value)])).toEqual([
      ['RO', '2021/1/105'],
      ['CJ', '2021/1/105'],
      ['54975', '2021/1/105'],
      ['RO', '2020/1/105'],
      ['CJ', '2020/1/105'],
      ['54975', '2020/1/105'],
      ['RO', '2019/1/105'],
      ['CJ', '2019/1/105'],
      ['54975', '2019/1/105'],
    ]);
    // hydration: classification members and the unit come from the catalogs
    expect(
      rows.nodes[0]?.members.map((m) => `D${String(m.dimIndex)}=${String(m.nomItemId)}`)
    ).toEqual(['D0=1', 'D1=105', 'D2=3064', 'D3=112']);
    expect(rows.nodes[0]?.unit.labelRo).toBe('Numar persoane');
  });

  it('facts: a LAU history via sirutaCodes with a period window, and limit+1 paging', async () => {
    const win = await listObservations(r(), 'POPTEST', {
      sirutaCodes: ['54975'],
      territoryLevels: ['LAU'],
      classificationValueCodes: ['TOTAL'],
      period: { periodicity: 'ANNUAL', start: '2020', end: '2021' },
    });
    expect(win._unsafeUnwrap().nodes.map((o) => decode(o.value))).toEqual([
      '2021/1/105',
      '2020/1/105',
    ]);
    const first = await listObservations(r(), 'POPTEST', { territoryCodes: ['CJ'] }, 10, 0);
    expect(first._unsafeUnwrap().hasNextPage).toBe(true);
    expect(first._unsafeUnwrap().totalCount).toBeNull();
    const last = await listObservations(r(), 'POPTEST', { territoryCodes: ['CJ'] }, 10, 20);
    expect(last._unsafeUnwrap().totalCount).toBe(27);
  });

  it('facts: mixed AB/CJ requests never return a cross-product row', async () => {
    const page = await listObservations(r(), 'POPTEST', {
      territoryCodes: ['1017', 'CJ'],
      classificationValueCodes: ['TOTAL'],
    });
    const tags = page._unsafeUnwrap().nodes.map((o) => o.territory?.code);
    expect(new Set(tags)).toEqual(new Set(['1017', 'CJ']));
    expect(tags).toHaveLength(6);
  });

  it('latest values and dashboard: one batched read; NO_DATA for the two-unit dataset and the empty one', async () => {
    const latest = await listLatestValues(
      r(),
      { sirutaCode: '54975' },
      ['POPTEST', 'CNTTEST', 'EMPTYTEST'],
      ['TOTAL']
    );
    expect(latest.isOk(), JSON.stringify(latest.isErr() ? latest.error : null)).toBe(true);
    expect(
      latest
        ._unsafeUnwrap()
        .map((v) => [
          v.dataset.code,
          v.matchStrategy,
          v.observation === null ? null : decode(v.observation.value),
        ])
    ).toEqual([
      ['POPTEST', 'TOTAL_FALLBACK', '2021/1/105'],
      ['CNTTEST', 'NO_DATA', null],
      ['EMPTYTEST', 'NO_DATA', null],
    ]);
    const county = await listLatestValues(r(), { territoryCode: 'CJ', territoryLevel: 'NUTS3' }, [
      'POPTEST',
    ]);
    expect(county._unsafeUnwrap()[0]?.observation?.territory?.code).toBe('CJ');
    const dash = await uatDashboard(r(), '54975', undefined, undefined);
    expect(
      dash._unsafeUnwrap().map((g) => [g.dataset.code, g.observations.length, g.truncated])
    ).toEqual([['POPTEST', 3, false]]);
  });

  it('a county-only dataset answers a region and a county, and refuses nothing silently for a LAU (empty page)', async () => {
    const region = await listObservations(r(), 'CNTTEST', {
      territoryCodes: ['RO11'],
      unitCodes: ['9507'],
    });
    expect(region._unsafeUnwrap().nodes.map((o) => o.value)).toEqual(['22', '20']);
    const lau = await listObservations(r(), 'CNTTEST', { sirutaCodes: ['54975'] });
    expect(lau._unsafeUnwrap().nodes).toEqual([]);
  });

  it('territoryLevels alone reads every county through a level semi-join; a diacritic needle finds members', async () => {
    const page = await listObservations(r(), 'POPTEST', {
      territoryLevels: ['NUTS3'],
      classificationValueCodes: ['TOTAL'],
      classificationTypeCodes: ['D0', 'D1'],
    });
    expect(new Set(page._unsafeUnwrap().nodes.map((o) => o.territory?.code))).toEqual(
      new Set(['CJ', 'AB'])
    );
    const members = await listDimensionValues(r(), 'POPTEST', 3, 'cluj-napoca', 50, 0);
    expect(members._unsafeUnwrap().nodes.map((m) => m.nomItemId)).toEqual([931]);
    const beyond = await listObservations(r(), 'POPTEST', { territoryCodes: ['CJ'] }, 10, 100);
    expect(beyond._unsafeUnwrap().totalCount).toBeNull();
  });

  it('plan: a fully pinned series probes the identity index on the pruned partition', async () => {
    if (db === undefined) throw new Error('db');
    // 135 rows: the planner rightly prefers a seq scan, so prove the index is the
    // chosen path once sequential scans are discouraged (the production leaf has 34M rows).
    const plan = await db.transaction().execute(async (trx) => {
      await sql`set local enable_seqscan = off`.execute(trx);
      return sql<Record<string, string>>`
      explain (format text) select o.value from ins.observations o
      where o.dataset_code = 'POPTEST' and o.dim1_member_id = 1 and o.dim2_member_id = 105
        and o.dim3_member_id = 3075 and o.dim4_member_id = 931 and o.unit_nom_item_id = 9685
      order by o.period_end desc limit 5`.execute(trx);
    });
    const text = plan.rows.map((x) => Object.values(x).join(' ')).join('\n');
    expect(text).toContain('observations_poptest');
    expect(text).not.toContain('observations_default');
    expect(text).toMatch(
      /observations_source_coordinate|observations_poptest_dataset_code_dim1_member_id/u
    );
  });
});
