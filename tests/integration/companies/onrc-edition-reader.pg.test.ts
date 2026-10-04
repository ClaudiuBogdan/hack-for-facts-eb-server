/**
 * Companies ONRC edition reader — real-DDL PostgreSQL proof (WRITTEN FOR THE
 * PRIMARY'S THROWAWAY PROOF; not part of the default unit runs).
 *
 * Prerequisite: `COMPANIES_ONRC_TEST_DATABASE_URL` points at a FRESH,
 * DISPOSABLE PostgreSQL database on which the scrapper's prod migration chain
 * has been applied through `20261003T172000__companies_onrc_editions` (e.g.
 * `applyProdChainTo(db, '20261003T172000__companies_onrc_editions')` in the
 * scrapper test kit). The file refuses a database that already holds ONRC
 * editions: every seeded row is append-only and stays behind. Never point it
 * at a shared or production database.
 *
 * Seeding: the edition, its five data relations and the publication events
 * are inserted in one transaction under `session_replication_role = replica`,
 * which disables the append-only/seal/publication GUARD TRIGGERS (and FK
 * triggers) for the fixture only; every CHECK constraint, the five public
 * view definitions, the publication envelope view and the module's SQL are
 * the real ones. The guard-respecting path (createEdition / seedComplete /
 * seal / publish) lives in the scrapper's
 * `tests/unit/private-companies/onrc-edition/onrc-editions.pg.test.ts` and may
 * replace this seeding without changing the assertions.
 *
 * Expected values are written by hand from the fixture below, never computed
 * by the code under test.
 *
 * Permission cases: three NOLOGIN reader roles of this disposable fixture
 * (`PROBE_ROLES`; the connecting user must be allowed to create roles) get
 * the API's read footprint minus one grant, and the real repository runs as
 * each through `set role`. They prove the capture/recheck footprint probe's
 * `where false` privilege semantics and the fiscal/financial content kept
 * without the catalog. They are fixture grants only, never runtime ones.
 * Role names carry a per-run nonce (`cprobe_<nonce>_<purpose>`); the
 * `./probe-roles.ts` ledger owns a role only after this run created it, and
 * afterAll closes this run's pools, then drops ONLY the owned roles and
 * reports any cleanup failure (a pre-existing or another run's role is never
 * touched). Role setup is the permission cases' own beforeAll.
 */

import { CompiledQuery, Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  REGISTRY_CAPABILITY_LOST_MESSAGE,
  runPinned,
  type CompanyRegistryEnvelope,
} from '@/modules/companies/core/registry.js';
import {
  makeCompanyList,
  makeCompanyProfileData,
  makeCompanyRegistrationDiff,
} from '@/modules/companies/core/usecases.js';
import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';

import { makeProbeRoleLedger, newRunNonce, probeRoleName } from './probe-roles.js';

import type { CompaniesRepository } from '@/modules/companies/core/ports.js';
import type { FlowsRepo, ProdDatabase } from '@/modules/shared/index.js';

const URL = process.env['COMPANIES_ONRC_TEST_DATABASE_URL'] ?? '';
const d = URL.length > 0 ? describe : describe.skip;

// ── fixture (hand-written) ────────────────────────────────────────────────────

/** Spine CUIs (kind company, public) and their roles in the fixture. */
const CUI = {
  conflict: '9900001', // J40/123/2000: public 1048 AND 1070 on the SAME identifier; CJ; rev2 6201
  split: '9900002', // A: 1048 + county B; B: 1084 + county CJ + rev2 6201 (separate identifiers)
  complete: '9900003', // 1084 only, complete coverage; rev0 1111 and an unknown-revision 6201
  partial: '9900004', // 1084 with hidden rows: partial coverage (unknown is not absence)
  notInEdition: '9900005', // a spine with no profile in the edition
  withdrawn: '9900006', // in edition; its core organization turns private mid-test
  oneDigit: '4', // a held one-digit token namespace: never linked to edition evidence
} as const;
const NGO = '9900007'; // a public NGO organization: not in the company directory
const SEEDED = Object.values(CUI);

/**
 * Two-edition diff cardinality: profiles and identity rows only, not on the
 * spine and not in SEEDED, so every list/facet expectation here is unchanged.
 */
const DIFF_CUI = {
  duplicates: '9900011', // e1: 1,000 identical observations; e2: one with the same values
  conflict: '9900012', // e1: 1,000 identical + a 1,001st with another name; e2: the first name
  overBound: '9900013', // e1: 1,001 distinct names (past the comparison bound); e2: one
} as const;

/**
 * A spine company with ANAF fiscal and financial rows but no ONRC profile (not
 * in SEEDED): its fiscal/financial content must survive a missing catalog grant.
 */
const FISCAL_CUI = '9900021';

/**
 * Reader roles of THIS run of the disposable fixture only (never a runtime
 * grant): the API's read footprint, minus one grant. Cluster-level names, so
 * each carries this run's nonce; only the ledger's owned roles are dropped.
 */
const RUN_NONCE = newRunNonce();
const PROBE_ROLES = {
  full: probeRoleName(RUN_NONCE, 'full'),
  noStatusView: probeRoleName(RUN_NONCE, 'nostatus'),
  noCatalog: probeRoleName(RUN_NONCE, 'nocatalog'),
} as const;
const READER_RELATIONS = [
  'core.organizations',
  'core.territories',
  'core.classification_codes',
  'companies_analytics.privacy_state',
  'companies_v2.onrc_current_publication',
  'companies_v2.onrc_published_editions',
  'companies_v2.onrc_published_profiles',
  'companies_v2.onrc_published_identifier_profiles',
  'companies_v2.onrc_published_identity_observations',
  'companies_v2.onrc_published_caen_observations',
  'companies_v2.onrc_published_status_observations',
  'companies_v2.fiscal_status',
  'companies_v2.financials',
];
/** Optional financial joins: granted when the chain created them (the reads degrade otherwise). */
const OPTIONAL_READER_RELATIONS = [
  'companies_v2.financial_qualification_active',
  'companies_v2.financial_source_resources',
];
const probeDbs: Kysely<ProdDatabase>[] = [];

const sha = (c: string): string => c.repeat(64);
const resource = (name: string) => ({
  bytes: 1000,
  data_rows: 10,
  object_uri: `s3://onrc-test/${name}.csv`,
  object_version_id: 'v1',
  sha256: sha('c'),
  source_url: `https://data.gov.ro/onrc/${name}.csv`,
});
const MANIFEST = JSON.stringify({
  resources: {
    OD_CAEN_AUTORIZAT: resource('caen'),
    OD_FIRME: resource('firme'),
    OD_STARE_FIRMA: resource('stare'),
  },
  row_hash_algorithm: 'sha256-json-stringify-csv-row-v1',
  row_number_convention: 'data_row_1_based_after_header',
});

let pool: Pool;
let db: Kysely<ProdDatabase>;
let repo: CompaniesRepository;
const editions: { e1: string; e2: string } = { e1: '', e2: '' };
let fakeRunId = 990_000;

const stubFlows = {} as FlowsRepo;

/** The client of the open fixture transaction, when one is open (one connection, one txn). */
let seeding: PoolClient | null = null;

const q = async (text: string, values: unknown[] = []): Promise<Record<string, unknown>[]> =>
  (await (seeding ?? pool).query(text, values)).rows as Record<string, unknown>[];

/**
 * Run fixture inserts on ONE client inside ONE transaction with the guard
 * triggers off (`session_replication_role = replica`, fixture only).
 */
const withReplica = async (work: () => Promise<void>): Promise<void> => {
  seeding = await pool.connect();
  try {
    await q('begin');
    await q('set local session_replication_role = replica');
    await work();
    await q('commit');
  } catch (error) {
    await q('rollback').catch(() => undefined);
    throw error;
  } finally {
    seeding.release();
    seeding = null;
  }
};

/** Insert an edition (verified, accessible) and return its id. */
const insertEdition = async (content: string, snapshot: string, published: string) =>
  String(
    (
      await q(
        `insert into companies_v2.onrc_editions
           (content_key, source_snapshot_id, source_published_at, manifest, interpretation_version,
            privacy_policy_version, dimension_policy_version, eligibility_policy_version,
            address_match_bundle_sha256, reference_bundle_sha256, state, seal)
         values ($1, $2, $3::date, $4::jsonb, 'onrc-interpretation-v1', 'onrc-privacy-v1',
                 'onrc-dimension-v1', 'public-legal-person-v1', $5, $6, 'verified', '{"fixture":true}')
         returning edition_id::text as id`,
        [sha(content), snapshot, published, MANIFEST, sha('d'), sha('e')]
      )
    )[0]?.['id']
  );

interface ProfileRow {
  cui: string;
  identifiers: number;
  name: string | null;
  nameBasis: string;
  legalForm?: [string | null, string];
  recorded?: [string | null, string];
  county?: [string | null, string];
  status?: [string | null, string];
  caenCoverage?: string;
  statusCoverage?: string;
}

const insertProfile = (e: string, p: ProfileRow) =>
  q(
    `insert into companies_v2.onrc_edition_profiles
       (edition_id, cui, identity_observations, identifier_count, unresolved_identifier_count,
        unidentified_observations, name, name_basis, legal_form, legal_form_basis, recorded_date,
        recorded_date_basis, county_code, county_basis, uat_siruta_code, uat_basis, status_code,
        status_basis, caen_coverage, status_coverage, legal_person_eligibility, eligibility_reason,
        eligibility_policy_version, privacy_class)
     values ($1::bigint, $2, $3, $3, 0, 0, $4, $5, $6, $7, $8::date, $9, $10, $11, null, 'missing',
             $12, $13, $14, $15, 'eligible', null, 'public-legal-person-v1', 'public')`,
    [
      e,
      p.cui,
      p.identifiers,
      p.name,
      p.nameBasis,
      p.legalForm?.[0] ?? 'SRL',
      p.legalForm?.[1] ?? 'single_observation',
      p.recorded?.[0] ?? null,
      p.recorded?.[1] ?? 'missing',
      p.county?.[0] ?? null,
      p.county?.[1] ?? 'missing',
      p.status?.[0] ?? null,
      p.status?.[1] ?? 'missing',
      p.caenCoverage ?? 'complete',
      p.statusCoverage ?? 'complete',
    ]
  );

const insertIdentifier = (
  e: string,
  key: string,
  cui: string,
  rows: number[],
  publicCodes: string[],
  allCodes: string[],
  counties: string[],
  summary: [string | null, string]
) =>
  q(
    `insert into companies_v2.onrc_identifier_profiles
       (edition_id, identifier_key, identity_resolution, cui, identity_row_count, identity_row_numbers,
        status_codes, public_status_codes, status_summary_code, status_summary_basis,
        status_observations, unparsed_status_observations, restricted_status_observations,
        county_codes, county_basis, caen_observations, unparsed_caen_observations,
        unknown_revision_caen_observations, restricted_caen_observations, privacy_class)
     values ($1::bigint, $2, 'resolved_cui', $3, $4, $5::int[], $6::text[], $7::text[], $8, $9,
             $10, 0, $11, $12::text[], $13, 0, 0, 0, 0, 'public')`,
    [
      e,
      key,
      cui,
      rows.length,
      rows,
      allCodes,
      publicCodes,
      summary[0],
      summary[1],
      allCodes.length,
      allCodes.length - publicCodes.length,
      counties,
      counties.length === 0
        ? 'missing'
        : counties.length === 1
          ? 'single_observation'
          : 'multiple_values',
    ]
  );

const insertIdentity = (
  e: string,
  row: number,
  cui: string,
  key: string,
  name: string,
  county: string | null,
  recorded: string | null
) =>
  q(
    `insert into companies_v2.onrc_identity_observations
       (edition_id, source_row_number, source_row_sha256, cui_token, cui_token_class, cui,
        cui_checksum, identifier_token, identifier_key, name_token, euid_token, legal_form_token,
        recorded_date_token, recorded_date_state, recorded_date, match_method, county_code,
        address_street_token, privacy_class, address_privacy_class)
     values ($1::bigint, $2, $3, $4, 'public_shape_2_10', $4, 'valid', $5, $5, $6, null, 'SRL',
             $7, $8, $9::date, $10, $11, 'STRADA PRIVATA 1', 'public', 'personal_moderate')`,
    [
      e,
      row,
      sha('a'),
      cui,
      key,
      `  ${name}  `, // display text is the ECMAScript trim of the token
      recorded ?? '',
      recorded === null ? 'blank' : 'date',
      recorded,
      county === null ? null : 'test-matcher',
      county,
    ]
  );

/**
 * `count` public, unidentified identity rows of `cui` from source row
 * `firstRow`, all named `name` (null: a distinct `DISTINCT NAME <row>` each).
 */
const insertIdentityRows = (
  e: string,
  firstRow: number,
  count: number,
  cui: string,
  name: string | null,
  county: string | null
) =>
  q(
    `insert into companies_v2.onrc_identity_observations
       (edition_id, source_row_number, source_row_sha256, cui_token, cui_token_class, cui,
        cui_checksum, name_token, legal_form_token, recorded_date_state, match_method,
        county_code, privacy_class, address_privacy_class)
     select $1::bigint, g, $2, $3, 'public_shape_2_10', $3, 'valid',
            coalesce($4::text, 'DISTINCT NAME ' || g::text), 'SRL', 'blank', $5::text,
            $6::text, 'public', 'personal_moderate'
     from generate_series($7::int, $7::int + $8::int - 1) as g`,
    [e, sha('a'), cui, name, county === null ? null : 'test-matcher', county, firstRow, count]
  );

const insertCaen = (
  e: string,
  row: number,
  cui: string,
  key: string,
  code: string | null,
  revision: string | null
) =>
  q(
    `insert into companies_v2.onrc_caen_observations
       (edition_id, source_row_number, source_row_sha256, identifier_token, identifier_key,
        profile_identifier_key, identity_resolution, cui, caen_code_token, caen_revision_token,
        caen_parse_state, caen_code, caen_revision_state, caen_revision, privacy_class)
     values ($1::bigint, $2, $3, $4, $4, $4, 'resolved_cui', $5, $6, $7, $8, $6, $9, $10, 'public')`,
    [
      e,
      row,
      sha('b'),
      key,
      cui,
      code,
      revision ?? 'x9',
      code === null ? 'invalid' : 'code',
      revision === null ? 'invalid' : 'known',
      revision,
    ]
  );

const insertStatus = (
  e: string,
  row: number,
  cui: string,
  key: string,
  code: string,
  privacy = 'public'
) =>
  q(
    `insert into companies_v2.onrc_status_observations
       (edition_id, source_row_number, source_row_sha256, identifier_token, identifier_key,
        profile_identifier_key, identity_resolution, cui, status_code_token, status_parse_state,
        status_code, status_label, status_label_source, privacy_class)
     values ($1::bigint, $2, $3, $4, $4, $4, 'resolved_cui', $5, $6, 'code', $6, null, null, $7)`,
    [e, row, sha('f'), key, cui, code, privacy]
  );

/** Append a publish event, move the pointer and bump the access epoch, as the real entry does. */
const publish = async (edition: string, previous: string | null): Promise<void> => {
  const pointer = await q(`select epoch::text as epoch from companies_v2.onrc_publication`);
  const epoch = String(Number(pointer[0]?.['epoch'] ?? 0) + 1);
  fakeRunId += 1;
  await withReplica(async () => {
    await q(`update companies_analytics.privacy_state set epoch = epoch + 1 where singleton`);
    const event = await q(
      `insert into companies_v2.onrc_publications
         (event_kind, edition_id, previous_active_edition_id, new_active_edition_id,
          publication_epoch, privacy_epoch, load_run_id, actor, reason, receipt, transaction_id)
       values ('publish', $1::bigint, $2::bigint, $1::bigint, $3::bigint,
               (select epoch from companies_analytics.privacy_state where singleton), $4,
               'fixture', 'onrc reader proof', '{}'::jsonb, pg_current_xact_id())
       returning event_id::text as id`,
      [edition, previous, epoch, fakeRunId]
    );
    await q(
      `update companies_v2.onrc_publication
          set active_edition_id = $1::bigint, previous_edition_id = $2::bigint,
              epoch = $3::bigint, last_event_id = $4::bigint
        where singleton`,
      [edition, previous, epoch, event[0]?.['id']]
    );
  });
};

/** Withdraw public access of an edition (one-way latch) with an event, as the real entry does. */
const withdraw = async (edition: string): Promise<void> => {
  const pointer = await q(`select epoch::text as epoch from companies_v2.onrc_publication`);
  const epoch = String(Number(pointer[0]?.['epoch'] ?? 0) + 1);
  fakeRunId += 1;
  await withReplica(async () => {
    await q(
      `update companies_v2.onrc_editions
          set public_access_enabled = false, access_withdrawal_reason = 'fixture withdrawal',
              access_withdrawn_at = now()
        where edition_id = $1::bigint`,
      [edition]
    );
    await q(`update companies_analytics.privacy_state set epoch = epoch + 1 where singleton`);
    const event = await q(
      `insert into companies_v2.onrc_publications
         (event_kind, edition_id, previous_active_edition_id, new_active_edition_id,
          publication_epoch, privacy_epoch, load_run_id, actor, reason, receipt, transaction_id)
       values ('withdraw_access', $1::bigint, $1::bigint, $1::bigint, $2::bigint,
               (select epoch from companies_analytics.privacy_state where singleton), $3,
               'fixture', 'onrc reader proof', '{}'::jsonb, pg_current_xact_id())
       returning event_id::text as id`,
      [edition, epoch, fakeRunId]
    );
    await q(
      `update companies_v2.onrc_publication set epoch = $1::bigint, last_event_id = $2::bigint where singleton`,
      [epoch, event[0]?.['id']]
    );
  });
};

const seed = async (): Promise<void> => {
  const existing = await q(`select count(*)::text as n from companies_v2.onrc_editions`);
  if (existing[0]?.['n'] !== '0') {
    throw new Error('COMPANIES_ONRC_TEST_DATABASE_URL must be a FRESH throwaway database');
  }
  await withReplica(async () => {
    // Spine, an NGO and the territory hub's county rows.
    for (const cui of SEEDED) {
      await q(
        `insert into core.organizations (cui, kind, name, first_seen_source, privacy_class)
         values ($1, 'company', $2, 'fixture', 'public')`,
        [cui, `CORE NAME ${cui}`]
      );
    }
    await q(
      `insert into core.organizations (cui, kind, name, first_seen_source, privacy_class)
       values ($1, 'ngo', 'ASOCIATIA TEST', 'fixture', 'public')`,
      [NGO]
    );
    for (const [code, name, siruta] of [
      ['CJ', 'Cluj', '9990001'],
      ['B', 'București', '9990002'],
    ] as const) {
      await q(
        `insert into core.territories (territorial_siruta_code, siruta_code, name, county_code,
           county_name, region, level, kind, territory_key, privacy_class)
         values ($1, $1, $2, $3, $2, 'Test', 'county', 'county', $4, 'public')`,
        [siruta, name, code, `fixture:county:${code}`]
      );
    }
    await q(
      `insert into core.classification_codes (system, code, label) values
         ('caen_rev2', '6201', 'Activitati de realizare a soft-ului la comanda'),
         ('caen_rev0', '1111', 'Rev0 fixture label'),
         ('caen_rev2', '1111', 'Rev2 label that must never attach to a rev0 row')
       on conflict do nothing`
    );
  });

  // The edition and its data rows (replica: guard triggers off for the fixture only).
  await withReplica(async () => {
    const e1 = await insertEdition('1', 'onrc:2026-07-08', '2026-07-08');
    editions.e1 = e1;
    await insertProfile(e1, {
      cui: CUI.conflict,
      identifiers: 1,
      name: 'CONFLICT SRL',
      nameBasis: 'single_observation',
      recorded: ['2001-02-03', 'single_observation'],
      county: ['CJ', 'single_observation'],
      status: [null, 'multiple_values'],
    });
    await insertIdentifier(
      e1,
      'J40/123/2000',
      CUI.conflict,
      [1],
      ['1048', '1070'],
      ['1048', '1070'],
      ['CJ'],
      ['1070', 'priority_summary']
    );
    await insertIdentity(e1, 1, CUI.conflict, 'J40/123/2000', 'CONFLICT SRL', 'CJ', '2001-02-03');
    await insertStatus(e1, 1, CUI.conflict, 'J40/123/2000', '1048');
    await insertStatus(e1, 2, CUI.conflict, 'J40/123/2000', '1070');
    await insertCaen(e1, 1, CUI.conflict, 'J40/123/2000', '6201', 'rev2');

    await insertProfile(e1, {
      cui: CUI.split,
      identifiers: 2,
      name: 'SPLIT SRL',
      nameBasis: 'consistent_observations',
      county: [null, 'multiple_values'],
      status: [null, 'multiple_values'],
    });
    await insertIdentifier(
      e1,
      'J12/1/2010',
      CUI.split,
      [2],
      ['1048'],
      ['1048'],
      ['B'],
      ['1048', 'single_code']
    );
    await insertIdentifier(
      e1,
      'J12/2/2015',
      CUI.split,
      [3],
      ['1084'],
      ['1084'],
      ['CJ'],
      ['1084', 'single_code']
    );
    await insertIdentity(e1, 2, CUI.split, 'J12/1/2010', 'SPLIT SRL', 'B', null);
    await insertIdentity(e1, 3, CUI.split, 'J12/2/2015', 'SPLIT SRL', 'CJ', null);
    await insertStatus(e1, 3, CUI.split, 'J12/1/2010', '1048');
    await insertStatus(e1, 4, CUI.split, 'J12/2/2015', '1084');
    await insertCaen(e1, 2, CUI.split, 'J12/2/2015', '6201', 'rev2');

    await insertProfile(e1, {
      cui: CUI.complete,
      identifiers: 1,
      name: 'COMPLETE SRL',
      nameBasis: 'single_observation',
      county: ['B', 'single_observation'],
      status: ['1084', 'single_observation'],
    });
    await insertIdentifier(
      e1,
      'J1/3/1999',
      CUI.complete,
      [4],
      ['1084'],
      ['1084'],
      ['B'],
      ['1084', 'single_code']
    );
    await insertIdentity(e1, 4, CUI.complete, 'J1/3/1999', 'COMPLETE SRL', 'B', null);
    await insertStatus(e1, 5, CUI.complete, 'J1/3/1999', '1084');
    await insertCaen(e1, 3, CUI.complete, 'J1/3/1999', '1111', 'rev0');
    await insertCaen(e1, 4, CUI.complete, 'J1/3/1999', '6201', null); // unknown revision

    await insertProfile(e1, {
      cui: CUI.partial,
      identifiers: 1,
      name: 'PARTIAL SRL',
      nameBasis: 'single_observation',
      status: [null, 'partial_observations'],
      caenCoverage: 'partial',
      statusCoverage: 'partial',
    });
    await insertIdentifier(
      e1,
      'J1/4/1999',
      CUI.partial,
      [5],
      ['1084'],
      ['1084', '1048'],
      [],
      [null, 'incomplete']
    );
    await insertIdentity(e1, 5, CUI.partial, 'J1/4/1999', 'PARTIAL SRL', null, null);
    await insertStatus(e1, 6, CUI.partial, 'J1/4/1999', '1084');
    await insertStatus(e1, 7, CUI.partial, 'J1/4/1999', '1048', 'restricted'); // hidden

    await insertProfile(e1, {
      cui: CUI.withdrawn,
      identifiers: 1,
      name: 'WITHDRAWN SRL',
      nameBasis: 'single_observation',
      status: ['1048', 'single_observation'],
    });
    await insertIdentifier(
      e1,
      'J1/6/2001',
      CUI.withdrawn,
      [6],
      ['1048'],
      ['1048'],
      [],
      ['1048', 'single_code']
    );
    await insertIdentity(e1, 6, CUI.withdrawn, 'J1/6/2001', 'WITHDRAWN SRL', null, null);
    await insertStatus(e1, 8, CUI.withdrawn, 'J1/6/2001', '1048');

    await insertProfile(e1, {
      cui: DIFF_CUI.duplicates,
      identifiers: 1,
      name: 'DUPLICATE SRL',
      nameBasis: 'consistent_observations',
      county: ['CJ', 'consistent_observations'],
    });
    await insertIdentityRows(e1, 100_001, 1000, DIFF_CUI.duplicates, 'DUPLICATE SRL', 'CJ');
    await insertProfile(e1, {
      cui: DIFF_CUI.conflict,
      identifiers: 1,
      name: null,
      nameBasis: 'multiple_values',
    });
    await insertIdentityRows(e1, 200_001, 1000, DIFF_CUI.conflict, 'FIRST NAME SRL', null);
    await insertIdentityRows(e1, 201_001, 1, DIFF_CUI.conflict, 'SECOND NAME SRL', null);
    await insertProfile(e1, {
      cui: DIFF_CUI.overBound,
      identifiers: 1,
      name: null,
      nameBasis: 'multiple_values',
    });
    await insertIdentityRows(e1, 300_001, 1001, DIFF_CUI.overBound, null, null);
  });
};

/** The second edition: CONFLICT renamed, source date later. */
const seedSecondEdition = async (): Promise<void> => {
  await withReplica(async () => {
    const e2 = await insertEdition('2', 'onrc:2026-08-05', '2026-08-05');
    editions.e2 = e2;
    await insertProfile(e2, {
      cui: CUI.conflict,
      identifiers: 1,
      name: 'CONFLICT TRADING SRL',
      nameBasis: 'single_observation',
      county: ['CJ', 'single_observation'],
      status: ['1048', 'single_observation'],
    });
    await insertIdentifier(
      e2,
      'J40/123/2000',
      CUI.conflict,
      [1],
      ['1048'],
      ['1048'],
      ['CJ'],
      ['1048', 'single_code']
    );
    await insertIdentity(e2, 1, CUI.conflict, 'J40/123/2000', 'CONFLICT TRADING SRL', 'CJ', null);
    await insertStatus(e2, 1, CUI.conflict, 'J40/123/2000', '1048');

    await insertProfile(e2, {
      cui: DIFF_CUI.duplicates,
      identifiers: 1,
      name: 'DUPLICATE SRL',
      nameBasis: 'single_observation',
      county: ['CJ', 'single_observation'],
    });
    await insertIdentityRows(e2, 100_001, 1, DIFF_CUI.duplicates, 'DUPLICATE SRL', 'CJ');
    await insertProfile(e2, {
      cui: DIFF_CUI.conflict,
      identifiers: 1,
      name: 'FIRST NAME SRL',
      nameBasis: 'single_observation',
    });
    await insertIdentityRows(e2, 200_001, 1, DIFF_CUI.conflict, 'FIRST NAME SRL', null);
    await insertProfile(e2, {
      cui: DIFF_CUI.overBound,
      identifiers: 1,
      name: 'DISTINCT NAME 300001',
      nameBasis: 'single_observation',
    });
    await insertIdentityRows(e2, 300_001, 1, DIFF_CUI.overBound, null, null);
  });
};

const capture = async (): Promise<CompanyRegistryEnvelope> =>
  (await repo.captureRegistryScope())._unsafeUnwrap();

/** The roles THIS run created (owned only after their CREATE ROLE succeeded). */
const probeRoles = makeProbeRoleLedger((text) => q(text));

/** Create a fixture reader role with the footprint grants minus `without`. */
const createProbeRole = async (role: string, without: string | null): Promise<void> => {
  // A failed (e.g. colliding) CREATE ROLE throws here and leaves the role unowned.
  await probeRoles.create(role);
  await q(`grant usage on schema core, companies_v2, companies_analytics to ${role}`);
  for (const relation of READER_RELATIONS) {
    if (relation !== without) await q(`grant select on ${relation} to ${role}`);
  }
  for (const relation of OPTIONAL_READER_RELATIONS) {
    const present = await q(`select to_regclass($1) is not null as present`, [relation]);
    if (present[0]?.['present'] === true) await q(`grant select on ${relation} to ${role}`);
  }
};

/** The real repository over its own pool whose every connection runs as `role`. */
const repoAs = (role: string): CompaniesRepository => {
  const probe = new Kysely<ProdDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: URL, max: 2 }),
      onCreateConnection: async (connection) => {
        await connection.executeQuery(CompiledQuery.raw(`set role ${role}`));
      },
    }),
  });
  probeDbs.push(probe);
  return makeCompaniesRepo(probe);
};

/** Spine + ANAF fiscal (known revision rev2) + one FY2024 statement for FISCAL_CUI. */
const seedFiscalCompany = async (): Promise<void> => {
  await withReplica(async () => {
    await q(
      `insert into core.organizations (cui, kind, name, first_seen_source, privacy_class)
       values ($1, 'company', 'FISCAL SPINE SRL', 'fixture', 'public')`,
      [FISCAL_CUI]
    );
    await q(
      `insert into companies_v2.fiscal_status
         (cui, is_vat_payer, is_inactive, status_date, main_caen_rev, main_caen_code,
          source_snapshot_id, source_url, privacy_class)
       values ($1, true, false, '2026-06-15', 'rev2', '6201', 'anaf:fixture',
               'https://webservicesp.anaf.ro/fixture', 'public')`,
      [FISCAL_CUI]
    );
    await q(
      `insert into companies_v2.financials
         (cui, year, metric_rule_version, turnover, employees, source_snapshot_id, source_url,
          raw_row_sha256, privacy_class, source_system)
       values ($1, 2024, 'anaf-bilant-metric-v1', 100.00, 5, 'anaf:fixture',
               'https://webservicesp.anaf.ro/bilant?an=2024&cui=' || $1, $2, 'public', 'anaf')`,
      [FISCAL_CUI, sha('a')]
    );
  });
};

const cuisOf = (rows: readonly { cui: string }[]): string[] => rows.map((r) => r.cui).sort();

const listCuis = async (filter: Record<string, unknown>): Promise<string[]> => {
  const res = await makeCompanyList(
    { repo, flowsRepo: stubFlows, meili: null },
    {
      filter: { ...filter, cui: { in: [...SEEDED] } },
      sort: 'cui',
      page: { page: 1, pageSize: 100 },
    }
  );
  const value = res._unsafeUnwrap();
  // Rows and the bounded total agree: one row per CUI, counted once.
  expect(value.total).toBe(value.rows.length);
  expect(new Set(value.rows.map((r) => r.cui)).size).toBe(value.rows.length);
  return cuisOf(value.rows);
};

d('ONRC edition reader over the real 172000 views', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 4 });
    db = new Kysely<ProdDatabase>({ dialect: new PostgresDialect({ pool }) });
    repo = makeCompaniesRepo(db);
    await seed();
  }, 120_000);

  afterAll(async () => {
    try {
      // This run's role sessions close first; then ONLY the roles this run
      // created are dropped, and a cleanup failure fails the suite.
      await Promise.all(probeDbs.map((probe) => probe.destroy()));
      await probeRoles.cleanup();
    } finally {
      await db?.destroy();
    }
  });

  it('before any publication the registry is UNPUBLISHED (a state, never an empty edition)', async () => {
    const scope = await capture();
    expect(scope.state).toBe('unpublished');
    expect(scope.editionId).toBeNull();
    const list = await makeCompanyList(
      { repo, flowsRepo: stubFlows, meili: null },
      { filter: { status: { eq: '1048' } }, sort: 'cui', page: { page: 1, pageSize: 10 } }
    );
    expect(list.isErr() && list.error.type).toBe('ServiceUnavailable');
    const profile = (await makeCompanyProfileData({ repo }, CUI.conflict))._unsafeUnwrap();
    expect(profile?.registry.cuiState).toBe('unpublished');
    expect(profile?.legalForm).toBeNull();
    expect(profile?.headlineStatus).toBeNull();
    expect(profile?.name).toBe(`CORE NAME ${CUI.conflict}`);
    expect(profile?.nameSource).toBe('core_organization');
  });

  it('publishes edition 1: the envelope pins it with both epochs and the eligibility policy', async () => {
    await publish(editions.e1, null);
    const scope = await capture();
    expect(scope).toMatchObject({
      state: 'published',
      editionId: editions.e1,
      sourcePublishedAt: '2026-07-08',
      sourceSnapshotId: 'onrc:2026-07-08',
      interpretationVersion: 'onrc-interpretation-v1',
      dimensionPolicyVersion: 'onrc-dimension-v1',
      eligibilityPolicyVersion: 'public-legal-person-v1',
      publicationEpoch: '1',
    });
    expect(scope.accessEpoch).toMatch(/^\d+$/u);
  });

  it('status 1048 matches ANY public original 1048, also next to a conflicting 1070 on the same identifier', async () => {
    // conflict (1048+1070 one identifier), split (1048 on identifier A), withdrawn (1048).
    // partial's 1048 is a HIDDEN row: never a public match.
    expect(await listCuis({ status: { eq: '1048' } })).toEqual(
      [CUI.conflict, CUI.split, CUI.withdrawn].sort()
    );
  });

  it('conjoined status/county/CAEN criteria must hold on the SAME identifier', async () => {
    // split: 1048 on A (county B) but CJ on B → no match; conflict: 1048 + CJ on one identifier.
    expect(await listCuis({ status: { eq: '1048' }, county: { eq: 'CJ' } })).toEqual([
      CUI.conflict,
    ]);
    // county CJ and 6201 on split's identifier B → match.
    expect(await listCuis({ county: { eq: 'CJ' }, caenCode: { eq: '6201' } })).toEqual(
      [CUI.conflict, CUI.split].sort()
    );
    // 1048 is on split's A, 6201 on its B → no match.
    expect(await listCuis({ status: { eq: '1048' }, caenCode: { eq: '6201' } })).toEqual([
      CUI.conflict,
    ]);
    // A county name resolves through the public county territories, like its code.
    expect(await listCuis({ status: { eq: '1048' }, county: { eq: 'cluj' } })).toEqual([
      CUI.conflict,
    ]);
  });

  it('caenCode is broad over revisions; onrcCaen is exact (rev0 included)', async () => {
    expect(await listCuis({ caenCode: { eq: '1111' } })).toEqual([CUI.complete]);
    expect(await listCuis({ onrcCaen: { eq: 'rev0:1111' } })).toEqual([CUI.complete]);
    expect(await listCuis({ onrcCaen: { eq: 'rev2:1111' } })).toEqual([]);
    // The unknown-revision 6201 row matches the broad code but no exact revision.
    expect(await listCuis({ caenCode: { eq: '6201' } })).toEqual(
      [CUI.complete, CUI.conflict, CUI.split].sort()
    );
    expect(await listCuis({ onrcCaen: { eq: 'rev2:6201' } })).toEqual(
      [CUI.conflict, CUI.split].sort()
    );
  });

  it('negatives need complete evidence: unknown, partial and not-in-edition never count as absence', async () => {
    // Without status 1048: only `complete` (complete coverage, 1084 only).
    // partial (hidden 1048), notInEdition, oneDigit: no complete evidence → excluded.
    expect(await listCuis({ exclude: { status: { eq: '1048' } } })).toEqual([CUI.complete]);
    expect(await listCuis({ exclude: { caenCode: { eq: '6201' } } })).toEqual([CUI.withdrawn]);
    // County negative needs a known consensus county that differs.
    expect(await listCuis({ exclude: { county: { eq: 'CJ' } } })).toEqual([CUI.complete]);
  });

  it('facets use the same predicates; each CUI once in a status/county bucket; CAEN on the same identifier', async () => {
    const status = (
      await repo.countBy('status', { cui: { in: [...SEEDED] } }, await capture())
    )._unsafeUnwrap();
    const buckets = Object.fromEntries(status.groups.map((g) => [g.key, g.count]));
    expect(buckets).toEqual({
      '(multiple_values)': 2, // conflict, split
      '1084': 1, // complete
      '1048': 1, // withdrawn
      '(partial_observations)': 1, // partial
      '(not_in_edition)': 2, // notInEdition, oneDigit
    });
    expect(status.denominator).toBe(SEEDED.length);
    const caen = (
      await repo.countBy(
        'caenDivision',
        { status: { eq: '1048' }, cui: { in: [...SEEDED] } },
        await capture()
      )
    )._unsafeUnwrap();
    // Only the 6201 on the identifier carrying 1048 (conflict); split's 6201 is on its 1084 identifier.
    expect(caen.groups.map((g) => [g.key, g.count])).toEqual([['rev2:62', 1]]);
    expect(caen.denominator).toBe(3); // conflict, split, withdrawn: the population, not a bucket sum
  });

  it('registration-number lookup normalizes exactly like the edition (whitespace removed, upper-cased)', async () => {
    const scope = await capture();
    // NBSP and LINE SEPARATOR are among the 25 removed code points.
    const raw = ` j40 / 123 /${String.fromCodePoint(0xa0)}2000${String.fromCodePoint(0x2028)}`;
    const hits = (await repo.findByRegistrationNumber(raw, scope))._unsafeUnwrap();
    expect(hits.map((h) => [h.cui, h.label, h.labelSource])).toEqual([
      [CUI.conflict, 'CONFLICT SRL', 'onrc_edition'],
    ]);
    expect((await repo.findByRegistrationNumber('J40-123-2000', scope))._unsafeUnwrap()).toEqual(
      []
    );
  });

  it('a profile shows retained observations, safe provenance, civil dates and no priority-picked status', async () => {
    const profile = (await makeCompanyProfileData({ repo }, CUI.conflict))._unsafeUnwrap();
    expect(profile?.registry.cuiState).toBe('in_edition');
    expect(profile?.name).toBe('CONFLICT SRL');
    expect(profile?.nameSource).toBe('onrc_edition');
    expect(profile?.headlineStatus).toBeNull(); // multiple_values: no consensus
    expect(profile?.statusFlags.map((f) => [f.code, f.label])).toEqual([
      ['1048', null],
      ['1070', null],
    ]);
    expect(profile?.registrationDate).toBe('2001-02-03'); // civil date, no TZ shift
    expect(profile?.codInmatriculare).toBe('J40/123/2000');
    const [identifier] = profile?.registry.identifiers ?? [];
    expect(identifier).toMatchObject({
      id: `${editions.e1}:J40/123/2000`,
      statusCodes: ['1048', '1070'],
      hasActiveObservation: true,
    });
    const [identity] = profile?.registry.identityObservations ?? [];
    expect(identity?.name).toBe('CONFLICT SRL'); // trimmed display text
    expect(identity?.id).toBe(`${editions.e1}:OD_FIRME:1`);
    expect(identity?.provenance).toEqual({
      resourceKey: 'OD_FIRME',
      sourceRowNumber: 1,
      sourceRowSha256: sha('a'),
      sourceUrl: 'https://data.gov.ro/onrc/firme.csv',
      sourceFileSha256: sha('c'),
      sourcePublishedAt: '2026-07-08',
    });
    const serialized = JSON.stringify(profile);
    for (const forbidden of ['STRADA PRIVATA', 's3://', 'object_version', 'test-matcher', 'x9']) {
      expect(serialized).not.toContain(forbidden);
    }
    const [caen] = profile?.registry.caenObservations ?? [];
    expect(caen?.catalogLabel).toEqual({
      label: 'Activitati de realizare a soft-ului la comanda',
      system: 'caen_rev2',
      source: 'current_db_catalog',
    });
  });

  it('labels come from the exact (revision, code) only: rev0 is distinct, an unknown revision has none', async () => {
    const profile = (await makeCompanyProfileData({ repo }, CUI.complete))._unsafeUnwrap();
    const byKey = Object.fromEntries(
      (profile?.caenActivities ?? []).map((a) => [`${a.rev ?? 'unknown'}:${a.code}`, a.label])
    );
    expect(byKey).toEqual({ 'rev0:1111': 'Rev0 fixture label', 'unknown:6201': null });
  });

  it('a spine without a profile is NOT_IN_EDITION (never absent or unregistered); one-digit tokens never link', async () => {
    for (const cui of [CUI.notInEdition, CUI.oneDigit]) {
      const profile = (await makeCompanyProfileData({ repo }, cui))._unsafeUnwrap();
      expect(profile?.registry.cuiState).toBe('not_in_edition');
      expect(profile?.name).toBe(`CORE NAME ${cui}`);
      expect(profile?.nameSource).toBe('core_organization');
    }
    expect((await makeCompanyProfileData({ repo }, NGO))._unsafeUnwrap()).toBeNull();
  });

  it('the first edition is NOT comparable (never a disappearance)', async () => {
    const diff = (await makeCompanyRegistrationDiff({ repo }, CUI.conflict))._unsafeUnwrap();
    expect(diff).toMatchObject({ status: 'not_comparable', reason: 'first_edition' });
  });

  it('a publication between the read and the recheck is retried under the new pin', async () => {
    await seedSecondEdition();
    let published = false;
    let captures = 0;
    const racing: CompaniesRepository = {
      ...repo,
      captureRegistryScope: async () => {
        captures += 1;
        return repo.captureRegistryScope();
      },
      getProfileData: async (cui, scope) => {
        const res = await repo.getProfileData(cui, scope);
        if (!published) {
          published = true;
          await publish(editions.e2, editions.e1);
        }
        return res;
      },
    };
    const profile = (await makeCompanyProfileData({ repo: racing }, CUI.conflict))._unsafeUnwrap();
    expect(captures).toBe(2);
    expect(profile?.registry.registry.editionId).toBe(editions.e2);
    expect(profile?.name).toBe('CONFLICT TRADING SRL');
    // Two published editions: a real comparison.
    const diff = (await makeCompanyRegistrationDiff({ repo }, CUI.conflict))._unsafeUnwrap();
    expect(diff).toMatchObject({
      status: 'changed',
      fromEditionId: editions.e1,
      toEditionId: editions.e2,
      changes: [{ field: 'legalName', from: 'CONFLICT SRL', to: 'CONFLICT TRADING SRL' }],
    });
  });

  it('the diff compares COMPLETE distinct value sets: duplicates never crowd out the later edition or a later conflict', async () => {
    const diff = async (cui: string) =>
      (await makeCompanyRegistrationDiff({ repo }, cui))._unsafeUnwrap();
    // 1,000 identical earlier observations and one identical later one.
    expect(await diff(DIFF_CUI.duplicates)).toMatchObject({
      status: 'unchanged',
      reason: null,
      fromEditionId: editions.e1,
      toEditionId: editions.e2,
      changes: [],
    });
    // The 1,001st earlier observation's other name is seen: two names on one side.
    expect(await diff(DIFF_CUI.conflict)).toMatchObject({ status: 'ambiguous', changes: [] });
    // 1,001 distinct earlier names exceed the comparison bound: never a partial comparison.
    expect(await diff(DIFF_CUI.overBound)).toMatchObject({
      status: 'not_comparable',
      reason: 'evidence_bound_exceeded',
      changes: [],
    });
  });

  describe('reader roles of this run (fixture grants only)', () => {
    // Runs here, in order: after edition 2 is published, before the withdrawal.
    beforeAll(async () => {
      await createProbeRole(PROBE_ROLES.full, null);
      await createProbeRole(
        PROBE_ROLES.noStatusView,
        'companies_v2.onrc_published_status_observations'
      );
      await createProbeRole(PROBE_ROLES.noCatalog, 'core.classification_codes');
      await seedFiscalCompany();
    }, 60_000);

    it('the read-footprint probe (where false) checks privileges: one missing view or catalog grant pins UNAVAILABLE', async () => {
      // The ledger owns exactly what this run created.
      expect(probeRoles.owned()).toEqual([
        PROBE_ROLES.full,
        PROBE_ROLES.noStatusView,
        PROBE_ROLES.noCatalog,
      ]);

      // Every reader grant: the published edition, and the recheck holds.
      const full = repoAs(PROBE_ROLES.full);
      const fullScope = (await full.captureRegistryScope())._unsafeUnwrap();
      expect(fullScope).toMatchObject({ state: 'published', editionId: editions.e2 });
      const recheck = (await full.confirmRegistryScope(fullScope, [CUI.conflict]))._unsafeUnwrap();
      expect(recheck.current).toMatchObject({ state: 'published', editionId: editions.e2 });

      // One missing grant anywhere in the footprint: UNAVAILABLE, though no row is read.
      for (const role of [PROBE_ROLES.noStatusView, PROBE_ROLES.noCatalog]) {
        const partial = repoAs(role);
        expect((await partial.captureRegistryScope())._unsafeUnwrap()).toMatchObject({
          state: 'unavailable',
          editionId: null,
        });
        // The pinned published scope no longer holds for it either (a moved scope).
        const moved = (
          await partial.confirmRegistryScope(fullScope, [CUI.conflict])
        )._unsafeUnwrap();
        expect(moved.current).toBeNull();
      }
      // The missing grant is real: under the published pin the evidence read
      // loses the capability (a moved scope), never a partial profile.
      const evidence = await repoAs(PROBE_ROLES.noStatusView).getProfileData(
        CUI.conflict,
        fullScope
      );
      expect(evidence._unsafeUnwrapErr()).toEqual({
        type: 'ServiceUnavailable',
        message: REGISTRY_CAPABILITY_LOST_MESSAGE,
      });
    });

    it('a missing catalog grant keeps the fiscal and financial content; the ANAF label is its own revision or null', async () => {
      const full = (
        await makeCompanyProfileData({ repo: repoAs(PROBE_ROLES.full) }, FISCAL_CUI)
      )._unsafeUnwrap();
      expect(full?.registry.registry.state).toBe('published');
      expect(full?.registry.cuiState).toBe('not_in_edition');
      expect(full?.fiscal).toMatchObject({
        vatPayer: true,
        mainCaenCode: '6201',
        mainCaenRev: 'rev2',
      });
      expect(full?.financials.map((f) => [f.year, f.turnover])).toEqual([[2024, '100.00']]);
      expect(full?.caenActivities).toEqual([
        {
          code: '6201',
          rev: 'rev2',
          source: 'anaf',
          label: 'Activitati de realizare a soft-ului la comanda',
          labelSource: 'current_db_catalog',
        },
      ]);

      const noCatalog = (
        await makeCompanyProfileData({ repo: repoAs(PROBE_ROLES.noCatalog) }, FISCAL_CUI)
      )._unsafeUnwrap();
      expect(noCatalog?.registry.registry.state).toBe('unavailable');
      expect(noCatalog?.registry.cuiState).toBe('unavailable');
      expect(noCatalog?.name).toBe('FISCAL SPINE SRL');
      expect(noCatalog?.fiscal).toMatchObject({
        vatPayer: true,
        mainCaenCode: '6201',
        mainCaenRev: 'rev2',
      });
      expect(noCatalog?.financials.map((f) => [f.year, f.turnover])).toEqual([[2024, '100.00']]);
      expect(noCatalog?.caenActivities).toEqual([
        { code: '6201', rev: 'rev2', source: 'anaf', label: null, labelSource: null },
      ]);
    });
  });

  it('a continuation under a moved scope is refused, never silently switched', async () => {
    const before = await capture();
    const res = await runPinned(
      repo,
      (scope) => repo.publishedEditions(scope),
      () => [],
      { expectedKey: `onrc:published:${editions.e1}:1:0` }
    );
    expect(res.isErr() && res.error.type).toBe('InvalidInput');
    expect(before.editionId).toBe(editions.e2);
  });

  it('a returned CUI whose organization turns private fails the recheck, and is gone on the next read', async () => {
    const scope = await capture();
    const rows = (
      await repo.listCompanies(
        { cui: { in: [CUI.withdrawn] } },
        'cui',
        { page: 1, pageSize: 10 },
        scope
      )
    )._unsafeUnwrap();
    expect(cuisOf(rows.rows)).toEqual([CUI.withdrawn]);
    await q(`update core.organizations set privacy_class = 'restricted' where cui = $1`, [
      CUI.withdrawn,
    ]);
    const recheck = (await repo.confirmRegistryScope(scope, [CUI.withdrawn]))._unsafeUnwrap();
    expect(recheck.privateCuis).toEqual([CUI.withdrawn]);
    expect(await listCuis({ status: { eq: '1048' } })).not.toContain(CUI.withdrawn);
  });

  it('an access withdrawal of the active edition is WITHDRAWN: registry facts unavailable, fiscal/financial unaffected', async () => {
    await withdraw(editions.e2);
    const scope = await capture();
    expect(scope.state).toBe('withdrawn');
    const profile = (await makeCompanyProfileData({ repo }, CUI.conflict))._unsafeUnwrap();
    expect(profile?.registry.cuiState).toBe('withdrawn');
    expect(profile?.legalForm).toBeNull();
    expect(profile?.registry.identifiers).toEqual([]);
    const facet = await repo.countBy('status', { cui: { in: [...SEEDED] } }, scope);
    expect(facet.isErr() && facet.error.type).toBe('ServiceUnavailable');
    // The pinned historical read of edition 2 is refused by the views too.
    const pinned = (
      await repo.listCompanies(
        { status: { eq: '1048' }, cui: { in: [...SEEDED] } },
        'cui',
        { page: 1, pageSize: 10 },
        { ...scope, state: 'published', editionId: editions.e2 }
      )
    )._unsafeUnwrap();
    expect(pinned.rows).toEqual([]);
  });
});
