/**
 * Companies ANAF-assumed main activity reader — real-DDL PostgreSQL proof
 * (not part of the default runs: it skips unless its URL is set).
 *
 * Prerequisite: `COMPANIES_MAIN_CAEN_TEST_DATABASE_URL` points at a FRESH,
 * DISPOSABLE PostgreSQL database on which the scrapper's prod migration chain
 * has been applied (through `20261013T220000` at least; the reader never
 * selects the time-basis columns `20261013T220030` appends). The file refuses
 * a database that already holds ONRC editions or main CAEN refreshes: every
 * seeded row is append-only and stays behind. Never point it at a shared or
 * production database.
 *
 * Seeding: every relation (ONRC edition, observations, publication, fiscal
 * rows, the ETL receipt, the main refresh / resolutions / supports /
 * assignments / state and an integrity hold) is inserted in one transaction
 * under `session_replication_role = replica`, which disables the
 * append-only, refresh-of-this-transaction and FK GUARD TRIGGERS for the
 * fixture only. Every CHECK constraint, every function (policy, digests,
 * public token) and the FOUR PUBLIC VIEWS are the real ones: currentness,
 * withdrawal, integrity masking, token masking and the flags are decided by
 * the real DDL, and the API reads them through its real repository SQL.
 *
 * Scope: this proves the READ side only — the real views' semantics and the
 * API's real reader SQL over them. Replica-mode synthetic seeding does NOT
 * test writer permissions, the refresh lifecycle, append-only guards or the
 * correctness gates of the data lane (the data suites own those). Expects
 * the final DDL's `anaf_withdrawn` AND `integrity_held` view columns.
 *
 * Expected values are written by hand from the fixture below, never computed
 * by the code under test.
 */

import { Kysely, PostgresDialect, type LogEvent } from 'kysely';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mainActivityWitness } from '@/modules/companies/core/main-activity.js';
import { makeCompanyComposition } from '@/modules/companies/core/usecases.js';
import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';

import type { CompaniesRepository } from '@/modules/companies/core/ports.js';
import type { FlowsRepo, ProdDatabase } from '@/modules/shared/index.js';

const URL = process.env['COMPANIES_MAIN_CAEN_TEST_DATABASE_URL'] ?? '';
const d = URL.length > 0 ? describe : describe.skip;

// ── fixture (hand-written) ────────────────────────────────────────────────────

const CUI = {
  omv: '9910001', // ANAF "610" (string) → ONRC rev2:0610 by leading zeros; also a SHORT_TOKEN 610 row
  lidl: '9910002', // ANAF 4711 → rev2 AND rev3 class keys → latest rev3
  noMatch: '9910003', // ANAF 4730, no class key → assumed code, unknown revision, no label
  held: '9910004', // resolved rev2:6201, then an integrity hold on its exact served source
  invalid: '9910005', // ANAF object token carrying contact text → never public
  withdraw: '9910006', // resolved rev2:6201; its fiscal row is withdrawn mid-test
  many: '9910007', // 2,001 authorized class keys: the flag list past its bound
  history: '9910008', // an outcome in the OLD edition e0, then one in e1
  noSource: '9910010', // no fiscal row at all: SOURCE_MISSING with the exact no-source evidence
  noSourceCorrected: '9910011', // a reviewed correction (rev2:6201) without any fiscal evidence
  missingToken: '9910012', // a REAL public fiscal row whose CAEN token is absent: SOURCE_MISSING with a source
  partial: '9910013', // no source snapshot but a source hash: a partial shape the reader refuses
} as const;
const ALL = Object.values(CUI);
const CONTACT = 'private@example.com';

const sha = (c: string): string => c.repeat(64);
/** One of the three manifest resources `onrc_manifest_is_valid` requires (all six descriptor fields). */
const resource = (name: string) => ({
  bytes: 1000,
  data_rows: 10,
  object_uri: `s3://onrc-test/${name}.csv`,
  object_version_id: 'v1',
  sha256: sha('c'),
  source_url: `https://data.gov.ro/onrc/${name}.csv`,
});
/** Exactly the shape the real `onrc_editions_manifest` CHECK admits (as the ONRC reader suite seeds it). */
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
const ids = { e0: '', e1: '', r0: '', r1: '' };
let fakeRunId = 991_000;
const stubFlows = {} as FlowsRepo;

let seeding: PoolClient | null = null;
const q = async (text: string, values: unknown[] = []): Promise<Record<string, unknown>[]> =>
  (await (seeding ?? pool).query(text, values)).rows as Record<string, unknown>[];
const one = async (text: string, values: unknown[] = []): Promise<string> =>
  String((await q(text, values))[0]?.['v']);

/** Fixture inserts on ONE client in ONE transaction, guard triggers off (fixture only). */
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

const insertEdition = (content: string, snapshot: string, published: string) =>
  one(
    `insert into companies_v2.onrc_editions
       (content_key, source_snapshot_id, source_published_at, manifest, interpretation_version,
        privacy_policy_version, dimension_policy_version, eligibility_policy_version,
        address_match_bundle_sha256, reference_bundle_sha256, state, seal)
     values ($1, $2, $3::date, $4::jsonb, 'onrc-interpretation-v1', 'onrc-privacy-v1',
             'onrc-dimension-v1', 'public-legal-person-v1', $5, $6, 'verified', '{"fixture":true}')
     returning edition_id::text as v`,
    [sha(content), snapshot, published, MANIFEST, sha('d'), sha('e')]
  );

const insertProfileAndIdentifier = async (e: string, cui: string) => {
  const key = `J99/${cui}/2000`;
  await q(
    `insert into companies_v2.onrc_edition_profiles
       (edition_id, cui, identity_observations, identifier_count, unresolved_identifier_count,
        unidentified_observations, name, name_basis, legal_form, legal_form_basis, recorded_date,
        recorded_date_basis, county_code, county_basis, uat_siruta_code, uat_basis, status_code,
        status_basis, caen_coverage, status_coverage, legal_person_eligibility, eligibility_reason,
        eligibility_policy_version, privacy_class)
     values ($1::bigint, $2, 1, 1, 0, 0, $3, 'single_observation', 'SA', 'single_observation',
             null, 'missing', null, 'missing', null, 'missing', null, 'missing', 'complete',
             'complete', 'eligible', null, 'public-legal-person-v1', 'public')`,
    [e, cui, `MAIN FIXTURE ${cui}`]
  );
  await q(
    `insert into companies_v2.onrc_identifier_profiles
       (edition_id, identifier_key, identity_resolution, cui, identity_row_count, identity_row_numbers,
        status_codes, public_status_codes, status_summary_code, status_summary_basis,
        status_observations, unparsed_status_observations, restricted_status_observations,
        county_codes, county_basis, caen_observations, unparsed_caen_observations,
        unknown_revision_caen_observations, restricted_caen_observations, privacy_class)
     values ($1::bigint, $2, 'resolved_cui', $3, 1, '{1}'::int[], '{}'::text[], '{}'::text[], null,
             'none_observed', 0, 0, 0, '{}'::text[], 'missing', 0, 0, 0, 0, 'public')`,
    [e, key, cui]
  );
  return key;
};

let caenRow = 0;
/** One public ONRC CAEN observation; `token` is the original code token (4 digits = class-eligible). */
const insertCaen = (
  e: string,
  cui: string,
  key: string,
  token: string,
  code: string,
  revision: string
) => {
  caenRow += 1;
  return q(
    `insert into companies_v2.onrc_caen_observations
       (edition_id, source_row_number, source_row_sha256, identifier_token, identifier_key,
        profile_identifier_key, identity_resolution, cui, caen_code_token, caen_revision_token,
        caen_parse_state, caen_code, caen_revision_state, caen_revision, privacy_class)
     values ($1::bigint, $2, $3, $4, $4, $4, 'resolved_cui', $5, $6, $7, 'code', $8, 'known', $7, 'public')`,
    [e, caenRow, sha('b'), key, cui, token, revision, code]
  );
};

const publish = async (edition: string, previous: string | null): Promise<void> => {
  const epoch = String(
    Number(await one(`select epoch::text as v from companies_v2.onrc_publication`)) + 1
  );
  fakeRunId += 1;
  await q(`update companies_analytics.privacy_state set epoch = epoch + 1 where singleton`);
  const event = await one(
    `insert into companies_v2.onrc_publications
       (event_kind, edition_id, previous_active_edition_id, new_active_edition_id,
        publication_epoch, privacy_epoch, load_run_id, actor, reason, receipt, transaction_id)
     values ('publish', $1::bigint, $2::bigint, $1::bigint, $3::bigint,
             (select epoch from companies_analytics.privacy_state where singleton), $4,
             'fixture', 'main reader proof', '{}'::jsonb, pg_current_xact_id())
     returning event_id::text as v`,
    [edition, previous, epoch, fakeRunId]
  );
  await q(
    `update companies_v2.onrc_publication
        set active_edition_id = $1::bigint, previous_edition_id = $2::bigint,
            epoch = $3::bigint, last_event_id = $4::bigint
      where singleton`,
    [edition, previous, epoch, event]
  );
};

/** Withdraw public access of an edition (one-way latch) with its event, as the real entry does. */
const withdrawEdition = async (edition: string): Promise<void> => {
  await withReplica(async () => {
    const epoch = String(
      Number(await one(`select epoch::text as v from companies_v2.onrc_publication`)) + 1
    );
    fakeRunId += 1;
    await q(
      `update companies_v2.onrc_editions
          set public_access_enabled = false, access_withdrawal_reason = 'fixture withdrawal',
              access_withdrawn_at = now()
        where edition_id = $1::bigint`,
      [edition]
    );
    await q(`update companies_analytics.privacy_state set epoch = epoch + 1 where singleton`);
    const event = await one(
      `insert into companies_v2.onrc_publications
         (event_kind, edition_id, previous_active_edition_id, new_active_edition_id,
          publication_epoch, privacy_epoch, load_run_id, actor, reason, receipt, transaction_id)
       values ('withdraw_access', $1::bigint, $2::bigint, $2::bigint, $3::bigint,
               (select epoch from companies_analytics.privacy_state where singleton), $4,
               'fixture', 'main reader proof', '{}'::jsonb, pg_current_xact_id())
       returning event_id::text as v`,
      [edition, ids.e1, epoch, fakeRunId]
    );
    await q(
      `update companies_v2.onrc_publication set epoch = $1::bigint, last_event_id = $2::bigint where singleton`,
      [epoch, event]
    );
  });
};

interface Fiscal {
  readonly cui: string;
  readonly served: string | null;
  readonly snapshot: string;
  readonly hash: string;
}
const fiscalOf = (cui: string, served: string | null): Fiscal => ({
  cui,
  served,
  snapshot: `anaf:${cui}`,
  hash: sha(String(Number(cui.at(-1)) % 10)),
});

const insertFiscal = (f: Fiscal, retrievedAt = '2026-06-15T08:00:00Z') =>
  q(
    `insert into companies_v2.fiscal_status
       (cui, is_vat_payer, is_inactive, status_date, main_caen_rev, main_caen_code, source_hash,
        retrieved_at, source_snapshot_id, source_url, raw_row_sha256, privacy_class)
     values ($1, true, false, '2026-06-15', null, $2, $3, $5::timestamptz, $4,
             'https://webservicesp.anaf.ro/fixture', $3, 'public')`,
    [f.cui, f.served, f.hash, f.snapshot, retrievedAt]
  );

/** A main refresh with its own succeeded receipt and valid audit, pinned to the LIVE global pins. */
const insertRefresh = async (edition: string, previous: string | null): Promise<string> => {
  fakeRunId += 1;
  const run = String(fakeRunId);
  await q(
    `insert into etl.load_runs (run_id, source_id, target_table, status, finished_at)
     overriding system value
     values ($1::bigint, 'private_companies_main_caen', 'companies_v2.main_caen_assignments',
             'succeeded', now())`,
    [run]
  );
  await q(
    `insert into etl.validation_results (run_id, source_id, check_name, status)
     values ($1::bigint, 'private_companies_main_caen', 'main_caen.audit', 'valid')`,
    [run]
  );
  const refresh = await one(
    `insert into companies_v2.main_caen_refreshes
       (previous_refresh_id, load_run_id, mode, focus_count, policy_version, form_policy,
        input_fingerprint, edition_id, onrc_publication_epoch, privacy_epoch, catalog_sha256,
        corrections_sha256, inputs, census, changed_assignments, new_resolutions, new_supports)
     values ($1::bigint, $2::bigint, 'full', 0, companies_v2.main_caen_policy(),
             companies_v2.anaf_fiscal_caen_form_policy(), $3, $4::bigint,
             (select epoch from companies_v2.onrc_publication where singleton),
             (select epoch from companies_analytics.privacy_state where singleton),
             companies_v2.main_caen_catalog_digest(), companies_v2.main_caen_corrections_digest(),
             '{}'::jsonb, '{}'::jsonb, 1, 1, 1)
     returning refresh_id::text as v`,
    [previous, run, sha('f'), edition]
  );
  return refresh;
};

interface Resolution {
  readonly status: string;
  readonly token: string | null;
  readonly jsonType: string;
  readonly form: string;
  readonly canonical: string | null;
  readonly assumed: string | null;
  readonly candidates: readonly string[];
  readonly selected: readonly [string, string, string] | null;
  readonly matchBasis: string | null;
  readonly revisionBasis: string | null;
}

const insertResolution = (
  cui: string,
  refresh: string,
  edition: string,
  r: Resolution,
  previous: string | null,
  basis = 'anaf_assumed_main'
) =>
  one(
    `insert into companies_v2.main_caen_resolutions
       (cui, previous_resolution_id, refresh_id, reasons, status, policy_version, main_role_basis,
        revision_basis, match_basis, anaf_binding_state, anaf_json_type, anaf_original_token,
        anaf_token_form, anaf_canonical_digits, anaf_assumed_code, edition_id, candidate_keys,
        resolved_revision, resolved_code, resolved_label, catalog_sha256)
     values ($1, $2::bigint, $3::bigint, '{first_assignment}', $4, companies_v2.main_caen_policy(),
             $17, $5, $6, 'bound', $7, $8, $9, $10, $11, $12::bigint, $13::text[],
             $14, $15, $16, companies_v2.main_caen_catalog_digest())
     returning resolution_id::text as v`,
    [
      cui,
      previous,
      refresh,
      r.status,
      r.revisionBasis,
      r.matchBasis,
      r.jsonType,
      r.token,
      r.form,
      r.canonical,
      r.assumed,
      edition,
      r.candidates,
      r.selected?.[0] ?? null,
      r.selected?.[1] ?? null,
      r.selected?.[2] ?? null,
      basis,
    ]
  );

const insertSupport = (
  f: Fiscal,
  resolution: string,
  refresh: string,
  edition: string,
  r: Resolution,
  previous: string | null,
  retrievedAt = '2026-06-15T08:00:00Z'
) =>
  one(
    `insert into companies_v2.main_caen_supports
       (cui, resolution_id, previous_support_id, refresh_id, edition_id, fiscal_source_snapshot_id,
        fiscal_source_hash, fiscal_raw_row_sha256, fiscal_served_code, fiscal_status_date,
        fiscal_retrieved_at, fiscal_source_url, evidence_custody, anaf_json_type,
        anaf_original_token, anaf_v3_form, onrc_profile_present, onrc_caen_coverage,
        candidate_row_count, unqualified_match_rows)
     values ($1, $2::bigint, $3::bigint, $4::bigint, $5::bigint, $6, $7, $7, $8, '2026-06-15',
             $11::timestamptz, 'https://webservicesp.anaf.ro/fixture',
             'pointer_bound_at_derivation', $9, $10, 'four_digit', true, 'complete', 1, 0)
     returning support_id::text as v`,
    [
      f.cui,
      resolution,
      previous,
      refresh,
      edition,
      f.snapshot,
      f.hash,
      f.served,
      r.jsonType,
      r.token,
      retrievedAt,
    ]
  );

/**
 * An outcome WITHOUT any fiscal evidence (no ANAF binding, no token, no form):
 * `source_missing`, or a reviewed correction selecting / withholding a key.
 */
const insertNoSourceOutcome = (
  cui: string,
  refresh: string,
  edition: string,
  outcome:
    | { readonly status: 'source_missing' }
    | {
        readonly status: 'corrected';
        readonly correction: string;
        readonly key: readonly [string, string];
      }
) =>
  one(
    `insert into companies_v2.main_caen_resolutions
       (cui, previous_resolution_id, refresh_id, reasons, status, policy_version, main_role_basis,
        revision_basis, match_basis, anaf_binding_state, edition_id, candidate_keys,
        resolved_revision, resolved_code, resolved_label, correction_id, catalog_sha256)
     values ($1, null, $2::bigint, '{first_assignment}', $3, companies_v2.main_caen_policy(),
             'anaf_assumed_main', $4, null, null, $5::bigint, $6::text[], $7, $8, $9, $10::bigint,
             companies_v2.main_caen_catalog_digest())
     returning resolution_id::text as v`,
    outcome.status === 'corrected'
      ? [
          cui,
          refresh,
          'corrected',
          'reviewed_correction',
          edition,
          [`${outcome.key[0]}:${outcome.key[1]}`],
          outcome.key[0],
          outcome.key[1],
          `Eticheta ${outcome.key[0]} ${outcome.key[1]}`,
          outcome.correction,
        ]
      : [cui, refresh, 'source_missing', null, edition, [], null, null, null, null]
  );

/** Its support: every fiscal field null (`hash` set only to build the PARTIAL negative). */
const insertNoSourceSupport = (
  cui: string,
  resolution: string,
  refresh: string,
  edition: string,
  hash: string | null = null
) =>
  one(
    `insert into companies_v2.main_caen_supports
       (cui, resolution_id, previous_support_id, refresh_id, edition_id, fiscal_source_snapshot_id,
        fiscal_source_hash, onrc_profile_present, onrc_caen_coverage, candidate_row_count,
        unqualified_match_rows)
     values ($1, $2::bigint, null, $3::bigint, $4::bigint, null, $5, true, 'complete', 0, 0)
     returning support_id::text as v`,
    [cui, resolution, refresh, edition, hash]
  );

const assign = (cui: string, resolution: string, support: string, refresh: string) =>
  q(
    `insert into companies_v2.main_caen_assignments (cui, resolution_id, support_id, refresh_id)
     values ($1, $2::bigint, $3::bigint, $4::bigint)
     on conflict (cui) do update set resolution_id = excluded.resolution_id,
       support_id = excluded.support_id, refresh_id = excluded.refresh_id`,
    [cui, resolution, support, refresh]
  );

const RESOLVED = (
  code: string,
  revision: string,
  token: string,
  jsonType = 'string'
): Resolution => ({
  status: 'resolved',
  token,
  jsonType,
  form: /^[0-9]{4}$/u.test(token) ? 'four_digit' : 'other_digit_form',
  canonical: token.replace(/^0+/u, ''),
  assumed: /^[0-9]{4}$/u.test(token) ? token : null,
  candidates: [`${revision}:${code}`],
  selected: [revision, code, `Eticheta ${revision} ${code}`],
  matchBasis: /^[0-9]{4}$/u.test(token) ? 'exact' : 'leading_zero_match',
  revisionBasis: 'unique_onrc_match',
});

const seed = async (): Promise<void> => {
  const editions = await one(`select count(*)::text as v from companies_v2.onrc_editions`);
  const refreshes = await one(`select count(*)::text as v from companies_v2.main_caen_refreshes`);
  if (editions !== '0' || refreshes !== '0') {
    throw new Error('COMPANIES_MAIN_CAEN_TEST_DATABASE_URL must be a FRESH throwaway database');
  }
  await withReplica(async () => {
    for (const cui of ALL) {
      await q(
        `insert into core.organizations (cui, kind, name, first_seen_source, privacy_class)
         values ($1, 'company', $2, 'fixture', 'public')`,
        [cui, `CORE NAME ${cui}`]
      );
    }
    await q(
      `insert into core.classification_codes (system, code, label) values
         ('caen_rev2', '0610', 'Eticheta rev2 0610'), ('caen_rev2', '4711', 'Eticheta rev2 4711'),
         ('caen_rev3', '4711', 'Eticheta rev3 4711'), ('caen_rev2', '6201', 'Eticheta rev2 6201'),
         ('caen_rev2', '4730', 'Eticheta rev2 4730')
       on conflict do nothing`
    );
    // 2,001 labelled rev1 codes for the flag-bound company.
    await q(
      `insert into core.classification_codes (system, code, label)
       select 'caen_rev1', lpad(g::text, 4, '0'), 'Eticheta rev1 ' || lpad(g::text, 4, '0')
       from generate_series(5000, 7000) g on conflict do nothing`
    );

    ids.e0 = await insertEdition('0', 'onrc:2026-06-01', '2026-06-01');
    ids.e1 = await insertEdition('1', 'onrc:2026-07-08', '2026-07-08');
    for (const e of [ids.e0, ids.e1]) {
      for (const cui of ALL) {
        const key = await insertProfileAndIdentifier(e, cui);
        if (cui === CUI.omv) {
          await insertCaen(e, cui, key, '0610', '0610', 'rev2');
          await insertCaen(e, cui, key, '610', '0610', 'rev2'); // a short token: never a class
          await insertCaen(e, cui, key, '4711', '4711', 'rev2');
        }
        if (cui === CUI.noSourceCorrected) {
          await insertCaen(e, cui, key, '6201', '6201', 'rev2');
        }
        if (cui === CUI.lidl) {
          await insertCaen(e, cui, key, '4711', '4711', 'rev2');
          await insertCaen(e, cui, key, '4711', '4711', 'rev3');
        }
        if (
          cui === CUI.noMatch ||
          cui === CUI.held ||
          cui === CUI.withdraw ||
          cui === CUI.history
        ) {
          await insertCaen(e, cui, key, '6201', '6201', 'rev2');
        }
        if (cui === CUI.many && e === ids.e1) {
          await q(
            `insert into companies_v2.onrc_caen_observations
               (edition_id, source_row_number, source_row_sha256, identifier_token, identifier_key,
                profile_identifier_key, identity_resolution, cui, caen_code_token, caen_revision_token,
                caen_parse_state, caen_code, caen_revision_state, caen_revision, privacy_class)
             select $1::bigint, 100000 + g, $2, $3, $3, $3, 'resolved_cui', $4, lpad(g::text, 4, '0'),
                    'rev1', 'code', lpad(g::text, 4, '0'), 'known', 'rev1', 'public'
             from generate_series(5000, 7000) g`,
            [e, sha('b'), key, cui]
          );
        }
      }
    }
    await publish(ids.e0, null);
    // History: an outcome derived under the OLD edition e0.
    ids.r0 = await insertRefresh(ids.e0, null);
    const histFiscal = fiscalOf(CUI.history, '6201');
    const oldOutcome = await insertResolution(
      CUI.history,
      ids.r0,
      ids.e0,
      RESOLVED('6201', 'rev2', '6201'),
      null
    );
    const oldSupport = await insertSupport(
      histFiscal,
      oldOutcome,
      ids.r0,
      ids.e0,
      RESOLVED('6201', 'rev2', '6201'),
      null
    );
    await assign(CUI.history, oldOutcome, oldSupport, ids.r0);

    await publish(ids.e1, ids.e0);
    // A reviewed correction BEFORE the refresh that pins the corrections digest.
    const correction = await one(
      `insert into companies_v2.main_caen_corrections
         (cui, action, onrc_revision, onrc_code, evidence_url, reason, reviewed_by, review_reference)
       values ($1, 'select_onrc_key', 'rev2', '6201', 'https://example.invalid/review', 'fixture',
               'fixture reviewer', 'fixture-1')
       returning correction_id::text as v`,
      [CUI.noSourceCorrected]
    );
    ids.r1 = await insertRefresh(ids.e1, ids.r0);
    // No fiscal row at all (the current view counts it current only without a public fiscal row).
    for (const cui of [CUI.noSource, CUI.partial]) {
      const outcome = await insertNoSourceOutcome(cui, ids.r1, ids.e1, {
        status: 'source_missing',
      });
      const support = await insertNoSourceSupport(
        cui,
        outcome,
        ids.r1,
        ids.e1,
        cui === CUI.partial ? sha('9') : null
      );
      await assign(cui, outcome, support, ids.r1);
    }
    const corrected = await insertNoSourceOutcome(CUI.noSourceCorrected, ids.r1, ids.e1, {
      status: 'corrected',
      correction,
      key: ['rev2', '6201'],
    });
    await assign(
      CUI.noSourceCorrected,
      corrected,
      await insertNoSourceSupport(CUI.noSourceCorrected, corrected, ids.r1, ids.e1),
      ids.r1
    );
    // A REAL public fiscal row whose CAEN token is absent: SOURCE_MISSING WITH a source.
    {
      const f = fiscalOf(CUI.missingToken, null);
      await insertFiscal(f);
      const r: Resolution = {
        status: 'source_missing',
        token: null,
        jsonType: 'absent',
        form: 'absent',
        canonical: null,
        assumed: null,
        candidates: [],
        selected: null,
        matchBasis: null,
        revisionBasis: null,
      };
      const outcome = await insertResolution(CUI.missingToken, ids.r1, ids.e1, r, null);
      await assign(
        CUI.missingToken,
        outcome,
        await insertSupport(f, outcome, ids.r1, ids.e1, r, null),
        ids.r1
      );
    }
    const rows: [string, string | null, Resolution][] = [
      [CUI.omv, '0610', RESOLVED('0610', 'rev2', '610')],
      [
        CUI.lidl,
        '4711',
        {
          ...RESOLVED('4711', 'rev3', '4711'),
          status: 'resolved_latest_revision',
          revisionBasis: 'latest_matching_onrc_revision',
          candidates: ['rev3:4711', 'rev2:4711'],
        },
      ],
      [
        CUI.noMatch,
        '4730',
        {
          ...RESOLVED('4730', 'rev2', '4730'),
          status: 'no_onrc_match',
          candidates: [],
          selected: null,
          matchBasis: null,
          revisionBasis: null,
        },
      ],
      [CUI.held, '6201', RESOLVED('6201', 'rev2', '6201')],
      [
        CUI.invalid,
        null,
        {
          status: 'token_invalid',
          token: JSON.stringify({ email: CONTACT }),
          jsonType: 'object',
          form: 'invalid',
          canonical: null,
          assumed: null,
          candidates: [],
          selected: null,
          matchBasis: null,
          revisionBasis: null,
        },
      ],
      [CUI.withdraw, '6201', RESOLVED('6201', 'rev2', '6201')],
      [
        CUI.many,
        '9998',
        {
          ...RESOLVED('9998', 'rev1', '9998'),
          status: 'no_onrc_match',
          candidates: [],
          selected: null,
          matchBasis: null,
          revisionBasis: null,
        },
      ],
    ];
    for (const [cui, served, r] of rows) {
      const f = fiscalOf(cui, served);
      await insertFiscal(f);
      const resolution = await insertResolution(cui, ids.r1, ids.e1, r, null);
      const support = await insertSupport(f, resolution, ids.r1, ids.e1, r, null);
      await assign(cui, resolution, support, ids.r1);
    }
    await insertFiscal(histFiscal);
    const newOutcome = await insertResolution(
      CUI.history,
      ids.r1,
      ids.e1,
      RESOLVED('6201', 'rev2', '6201'),
      oldOutcome
    );
    const newSupport = await insertSupport(
      histFiscal,
      newOutcome,
      ids.r1,
      ids.e1,
      RESOLVED('6201', 'rev2', '6201'),
      oldSupport
    );
    await assign(CUI.history, newOutcome, newSupport, ids.r1);
    await q(
      `update companies_v2.main_caen_state set refresh_id = $1::bigint, epoch = 2, content_epoch = 2
        where singleton`,
      [ids.r1]
    );
  });
};

/** Record an integrity hold on the CURRENT served source identity of `cui`. */
const holdCurrentSource = async (cui: string): Promise<void> => {
  await withReplica(async () => {
    fakeRunId += 1;
    await q(
      `insert into etl.load_runs (run_id, source_id, target_table, status, finished_at)
       overriding system value
       values ($1::bigint, 'private_companies_main_caen', 'companies_v2.main_caen_assignments',
               'failed', now())`,
      [String(fakeRunId)]
    );
    await q(
      `insert into companies_v2.main_caen_integrity_holds
         (cui, fiscal_source_snapshot_id, fiscal_source_hash, support_id_at_detection,
          contradiction_source, contradiction_field, detected_run_id)
       select s.cui, s.fiscal_source_snapshot_id, s.fiscal_source_hash, s.support_id,
              'archived_exchange', 'cod_CAEN', $2::bigint
         from companies_v2.main_caen_assignments a
         join companies_v2.main_caen_supports s on s.cui = a.cui and s.support_id = a.support_id
        where a.cui = $1`,
      [cui, String(fakeRunId)]
    );
  });
};

const withdrawFiscal = (cui: string) =>
  withReplica(async () => {
    await q(`update companies_v2.fiscal_status set privacy_class = 'restricted' where cui = $1`, [
      cui,
    ]);
  });

/**
 * READER-FIXTURE-ONLY fresh global pins. Earlier cases legitimately move the
 * GLOBAL pins (e.g. the old-edition withdrawal advances the ONRC publication
 * AND privacy epochs while the active edition stays published), and nothing
 * re-derives Main afterwards, so the seed refresh no longer pins them. Before
 * a case that needs a CURRENT baseline, append — as the producer would — one
 * new successful refresh following the state pointer: its own succeeded
 * receipt and valid `main_caen.audit`, the LIVE active edition and publication
 * epoch, privacy epoch, catalog / corrections digests and policies, zero
 * change counters (it creates no resolution or support), then advance `main_caen_state` to it (epoch + 1; the semantic
 * content epoch unchanged). Nothing else is touched: no epoch is reset, no
 * edition restored, no history row, hold, generation or earlier receipt
 * changed. Replica seeding is reader-only and qualifies no lifecycle.
 */
const freshPins = async (): Promise<string> => {
  let refresh = '';
  await withReplica(async () => {
    fakeRunId += 1;
    const run = String(fakeRunId);
    await q(
      `insert into etl.load_runs (run_id, source_id, target_table, status, finished_at)
       overriding system value
       values ($1::bigint, 'private_companies_main_caen', 'companies_v2.main_caen_assignments',
               'succeeded', now())`,
      [run]
    );
    await q(
      `insert into etl.validation_results (run_id, source_id, check_name, status)
       values ($1::bigint, 'private_companies_main_caen', 'main_caen.audit', 'valid')`,
      [run]
    );
    refresh = await one(
      `insert into companies_v2.main_caen_refreshes
         (previous_refresh_id, load_run_id, mode, focus_count, policy_version, form_policy,
          input_fingerprint, edition_id, onrc_publication_epoch, privacy_epoch, catalog_sha256,
          corrections_sha256, inputs, census, changed_assignments, new_resolutions, new_supports)
       select s.refresh_id, $1::bigint, 'full', 0, companies_v2.main_caen_policy(),
              companies_v2.anaf_fiscal_caen_form_policy(), $2, p.edition_id, p.publication_epoch,
              ps.epoch, companies_v2.main_caen_catalog_digest(),
              companies_v2.main_caen_corrections_digest(), '{}'::jsonb, '{}'::jsonb, 0, 0, 0
         from companies_v2.main_caen_state s
         cross join companies_v2.onrc_current_publication p
         cross join companies_analytics.privacy_state ps
        where s.singleton and ps.singleton and p.publication_state = 'published'
       returning refresh_id::text as v`,
      [run, sha('f')]
    );
    await q(
      `update companies_v2.main_caen_state
          set refresh_id = $1::bigint, epoch = epoch + 1, changed_at = clock_timestamp()
        where singleton`,
      [refresh]
    );
  });
  return refresh;
};

/** The reader's global pins, as the view states them. */
const readerPins = async () =>
  (
    await q(
      `select refresh_id::text as refresh_id, onrc_publication_epoch::text as publication_epoch,
              privacy_epoch::text as privacy_epoch, receipt_ok, onrc_ok, privacy_ok, catalog_ok,
              policy_ok, corrections_ok, edition_available, pins_current
         from companies_v2.main_caen_reader_pins`
    )
  )[0];

/** Every global pin holds for exactly this refresh. */
const expectPinsCurrent = async (refresh: string) => {
  expect(await readerPins()).toMatchObject({
    refresh_id: refresh,
    receipt_ok: true,
    onrc_ok: true,
    privacy_ok: true,
    catalog_ok: true,
    policy_ok: true,
    corrections_ok: true,
    edition_available: true,
    pins_current: true,
  });
};

const main = async (cui: string, flags = true) =>
  (await repo.getMainActivity(cui, { flags }))._unsafeUnwrap();

const activityOf = async (cui: string, flags = true) => {
  const read = await main(cui, flags);
  if (read.assignment.state !== 'row') throw new Error(`no assignment row for ${cui}`);
  return { read, activity: read.assignment.activity };
};

d('main activity reader over the REAL main CAEN DDL', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 4 });
    db = new Kysely<ProdDatabase>({ dialect: new PostgresDialect({ pool }) });
    repo = makeCompaniesRepo(db);
    await seed();
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('OMV-like: CURRENT, ANAF "610" resolved to ONRC rev2:0610 by leading zeros; only the CLASS row is flagged', async () => {
    const { read, activity } = await activityOf(CUI.omv);
    expect(activity).toMatchObject({
      currentness: 'current',
      anafWithdrawn: false,
      status: 'resolved',
      matchBasis: 'leading_zero_match',
      resolved: { revision: 'rev2', code: '0610', label: 'Eticheta rev2 0610' },
      candidates: [{ revision: 'rev2', code: '0610' }],
      anaf: {
        originalToken: '610',
        jsonType: 'string',
        tokenForm: 'other_digit_form',
        assumedCode: null,
      },
      edition: { editionId: ids.e1 },
    });
    expect(read.flags).toEqual({
      state: 'read',
      flags: [
        expect.objectContaining({
          revision: 'rev2',
          code: '0610',
          isMainCaen: true,
          matchesAssumedMainCode: true,
        }),
        expect.objectContaining({
          revision: 'rev2',
          code: '4711',
          isMainCaen: false,
          matchesAssumedMainCode: false,
        }),
      ],
    });
  });

  it('Lidl-like: the latest known matching revision rev3 is selected, both candidates kept, both class rows match the code', async () => {
    const { read, activity } = await activityOf(CUI.lidl);
    expect(activity).toMatchObject({
      status: 'resolved_latest_revision',
      revisionBasis: 'latest_matching_onrc_revision',
      resolved: { revision: 'rev3', code: '4711' },
      candidates: [
        { revision: 'rev3', code: '4711' },
        { revision: 'rev2', code: '4711' },
      ],
    });
    expect(
      read.flags.state === 'read' &&
        read.flags.flags.map((f) => [f.revision, f.isMainCaen, f.matchesAssumedMainCode])
    ).toEqual([
      ['rev2', false, true],
      ['rev3', true, true],
    ]);
  });

  it('no ONRC match: the assumed code with no key and no label', async () => {
    const { activity } = await activityOf(CUI.noMatch);
    expect(activity).toMatchObject({
      status: 'no_onrc_match',
      resolved: null,
      anaf: { assumedCode: '4730' },
    });
  });

  it('a malformed object token carrying contact text is never public (view mask AND API defense)', async () => {
    const raw = await q(
      `select anaf_original_token, anaf_json_type, anaf_token_form
         from companies_v2.main_caen_current_assignments where cui = $1`,
      [CUI.invalid]
    );
    expect(raw).toEqual([
      { anaf_original_token: null, anaf_json_type: 'object', anaf_token_form: 'invalid' },
    ]);
    const { activity } = await activityOf(CUI.invalid);
    expect(JSON.stringify(activity)).not.toContain(CONTACT);
    expect(activity.anaf).toMatchObject({
      originalToken: null,
      jsonType: 'object',
      tokenForm: 'invalid',
    });
    const history = (
      await repo.getMainActivityHistory(CUI.invalid, { kind: 'outcomes', beforeId: null, limit: 5 })
    )._unsafeUnwrap();
    const evidence = (
      await repo.getMainActivityHistory(CUI.invalid, { kind: 'evidence', beforeId: null, limit: 5 })
    )._unsafeUnwrap();
    expect(JSON.stringify([history, evidence])).not.toContain(CONTACT);
  });

  it('a main-only read never names the flag view; 2,001 keys are overflow while the singleton is served', async () => {
    const logged: string[] = [];
    const logging = new Kysely<ProdDatabase>({
      dialect: new PostgresDialect({ pool }),
      log: (event: LogEvent) => {
        logged.push(event.query.sql);
      },
    });
    const mainOnly = (
      await makeCompaniesRepo(logging).getMainActivity(CUI.many, { flags: false })
    )._unsafeUnwrap();
    expect(logged.join('\n')).not.toContain('main_caen_class_flags');
    expect(mainOnly).toMatchObject({
      assignment: { state: 'row' },
      flags: { state: 'not_requested' },
    });
    const withFlags = await main(CUI.many);
    expect(withFlags.flags).toEqual({ state: 'overflow' });
    expect(withFlags.assignment).toMatchObject({
      state: 'row',
      activity: { status: 'no_onrc_match' },
    });
  });

  it('the fresh witness equals the read witness while nothing moved', async () => {
    const read = await main(CUI.omv);
    expect((await repo.readMainActivityWitness(CUI.omv))._unsafeUnwrap()).toBe(
      mainActivityWitness(read)
    );
  });

  it('the real composition serves the settled main activity with the flagged class rows', async () => {
    const composition = (
      await makeCompanyComposition({ repo, flowsRepo: stubFlows, meili: null }, CUI.omv, {
        mainActivity: true,
        mainFlags: true,
      })
    )._unsafeUnwrap();
    const part = composition?.mainActivity?._unsafeUnwrap();
    expect(part?.read).toMatchObject({
      availability: 'assigned',
      activity: { currentness: 'current' },
    });
    expect(
      part?.caenActivities
        .filter((a) => a.isMainCaen === true)
        .map((a) => [a.rev, a.code, a.classState])
    ).toEqual([['rev2', '0610', 'class']]);
  });

  it('an integrity hold: PENDING_REFRESH, interpretation and token suppressed, no true flag, source dates kept; the witness moves', async () => {
    const before = (await repo.readMainActivityWitness(CUI.held))._unsafeUnwrap();
    await holdCurrentSource(CUI.held);
    const { read, activity } = await activityOf(CUI.held);
    expect(activity).toMatchObject({
      currentness: 'pending_refresh',
      integrityHeld: true,
      status: null,
      resolved: null,
      candidates: null,
      anaf: { originalToken: null, tokenForm: null, statusDate: '2026-06-15' },
    });
    expect(
      read.flags.state === 'read' && read.flags.flags.every((f) => f.isMainCaen === null)
    ).toBe(true);
    expect((await repo.readMainActivityWitness(CUI.held))._unsafeUnwrap()).not.toBe(before);
  });

  it('a fiscal withdrawal: SOURCE_WITHDRAWN, anafWithdrawn, no ANAF object; history ANAF withdrawn; the witness moves', async () => {
    const before = (await repo.readMainActivityWitness(CUI.withdraw))._unsafeUnwrap();
    await withdrawFiscal(CUI.withdraw);
    const { activity } = await activityOf(CUI.withdraw);
    expect(activity).toMatchObject({
      currentness: 'source_withdrawn',
      anafWithdrawn: true,
      anaf: null,
      status: null,
    });
    expect((await repo.readMainActivityWitness(CUI.withdraw))._unsafeUnwrap()).not.toBe(before);
    const history = (
      await repo.getMainActivityHistory(CUI.withdraw, {
        kind: 'outcomes',
        beforeId: null,
        limit: 5,
      })
    )._unsafeUnwrap();
    expect(history).toMatchObject({
      state: 'read',
      outcomes: [{ anafWithdrawn: true, anaf: null }],
    });
  });

  it('a hold on a fiscally withdrawn source: SOURCE_WITHDRAWN first, integrityHeld true, no ANAF object, never current', async () => {
    await holdCurrentSource(CUI.withdraw);
    const { read, activity } = await activityOf(CUI.withdraw);
    expect(activity).toMatchObject({
      currentness: 'source_withdrawn',
      anafWithdrawn: true,
      integrityHeld: true,
      anaf: null,
      status: null,
      resolved: null,
    });
    expect(
      read.flags.state === 'read' && read.flags.flags.every((f) => f.isMainCaen === null)
    ).toBe(true);
  });

  it('history: newest-first keyset pages; visibility by id follows an OLD edition withdrawal', async () => {
    const first = (
      await repo.getMainActivityHistory(CUI.history, { kind: 'outcomes', beforeId: null, limit: 1 })
    )._unsafeUnwrap();
    expect(
      first.state === 'read' && first.outcomes.map((o) => [o.editionId, o.onrcWithdrawn])
    ).toEqual([[ids.e1, false]]);
    const newest = first.state === 'read' ? first.outcomes[0]!.resolutionId : '';
    const second = (
      await repo.getMainActivityHistory(CUI.history, {
        kind: 'outcomes',
        beforeId: newest,
        limit: 5,
      })
    )._unsafeUnwrap();
    expect(second.state === 'read' && second.outcomes.map((o) => o.editionId)).toEqual([ids.e0]);
    const oldId = second.state === 'read' ? second.outcomes[0]!.resolutionId : '';
    const visibleBefore = (
      await repo.readMainActivityHistoryVisibility(CUI.history, 'outcomes', [newest, oldId])
    )._unsafeUnwrap();
    expect(visibleBefore).toEqual(
      new Map([
        [newest, 'false:false'],
        [oldId, 'false:false'],
      ])
    );

    await withdrawEdition(ids.e0);
    const visibleAfter = (
      await repo.readMainActivityHistoryVisibility(CUI.history, 'outcomes', [newest, oldId])
    )._unsafeUnwrap();
    expect(visibleAfter).toEqual(
      new Map([
        [newest, 'false:false'],
        [oldId, 'false:true'],
      ])
    );
    const old = (
      await repo.getMainActivityHistory(CUI.history, {
        kind: 'outcomes',
        beforeId: newest,
        limit: 5,
      })
    )._unsafeUnwrap();
    expect(old).toMatchObject({
      outcomes: [{ onrcWithdrawn: true, editionId: null, resolved: null, status: null }],
    });
  });

  it('per-CUI statements: default-settings EXPLAIN recorded; separately, an index-availability diagnostic (enable_seqscan off)', async () => {
    const statements: { sql: string; parameters: readonly unknown[] }[] = [];
    const logging = new Kysely<ProdDatabase>({
      dialect: new PostgresDialect({ pool }),
      log: (event: LogEvent) => {
        statements.push({ sql: event.query.sql, parameters: event.query.parameters });
      },
    });
    const logged = makeCompaniesRepo(logging);
    await logged.getMainActivity(CUI.omv, { flags: true });
    await logged.getMainActivityHistory(CUI.history, {
      kind: 'outcomes',
      beforeId: null,
      limit: 5,
    });
    await logged.getMainActivityHistory(CUI.history, {
      kind: 'evidence',
      beforeId: null,
      limit: 5,
    });
    // Every read runs in its own transaction with JIT off; the setting ends with it.
    const frame = ['begin', 'set local jit = off', 'read', 'commit'];
    expect(statements.map((s) => (/^\s*select\b/iu.test(s.sql) ? 'read' : s.sql))).toEqual([
      ...frame,
      ...frame,
      ...frame,
    ]);
    const clients = await Promise.all([1, 2, 3, 4].map(() => pool.connect()));
    try {
      for (const client of clients) {
        expect((await client.query('show jit')).rows[0]).toEqual({ jit: 'on' });
      }
    } finally {
      for (const client of clients) client.release();
    }
    const reads = statements.filter((s) => /^\s*select\b/iu.test(s.sql));
    const explain = async (forceIndex: boolean): Promise<string[]> => {
      const client = await pool.connect();
      const plans: string[] = [];
      try {
        await client.query('begin');
        // Test-session diagnostic only: never an application or runtime setting.
        if (forceIndex) await client.query('set local enable_seqscan = off');
        for (const s of reads) {
          const res = await client.query(`explain (format json) ${s.sql}`, [...s.parameters]);
          plans.push(JSON.stringify(res.rows[0]));
        }
        await client.query('rollback');
      } finally {
        client.release();
      }
      return plans;
    };
    // 1. Default planner settings: recorded for root's review. On a tiny fixture
    //    a cheap sequential scan is not a correctness failure, and no plan here
    //    is latency or production-performance evidence.
    const defaultPlans = await explain(false);
    expect(defaultPlans).toHaveLength(reads.length);
    console.info(JSON.stringify({ mainActivityDefaultPlans: defaultPlans }).slice(0, 20_000));
    // 2. Index-availability diagnostic (labelled as such): with sequential scans
    //    disabled, the per-CUI predicate reaches the cui indexes of the base
    //    relations behind the views, i.e. no whole-population evaluation is
    //    structurally required.
    const diagnostic = await explain(true);
    const nodesOn = (plan: string, relation: string) =>
      [...plan.matchAll(new RegExp(`\\{[^{}]*"Relation Name":"${relation}"[^{}]*\\}`, 'gu'))].map(
        (m) => m[0]
      );
    for (const relation of [
      'main_caen_assignments',
      'main_caen_resolutions',
      'main_caen_supports',
    ]) {
      const nodes = diagnostic.flatMap((plan) => nodesOn(plan, relation));
      expect(nodes.length, relation).toBeGreaterThan(0);
      for (const node of nodes) {
        expect(node, relation).toMatch(
          /"Node Type":"(Index Scan|Index Only Scan|Bitmap Heap Scan)"/u
        );
      }
    }
    console.info(JSON.stringify({ mainActivityIndexDiagnosticPlans: diagnostic }).slice(0, 20_000));
  });

  // ── the exact no-source shape, never judged from the status ──

  it('no fiscal source: SOURCE_MISSING with an all-null ANAF object — not a withdrawal', async () => {
    // Current global pins first (the earlier cases moved them).
    await expectPinsCurrent(await freshPins());
    const { activity } = await activityOf(CUI.noSource);
    expect(activity).toMatchObject({
      status: 'source_missing',
      anafWithdrawn: false,
      currentness: 'current',
    });
    expect(activity.anaf).toEqual({
      originalToken: null,
      jsonType: null,
      tokenForm: null,
      canonicalDigits: null,
      assumedCode: null,
      v3Form: null,
      statusDate: null,
      retrievedAt: null,
      sourceUrl: null,
      sourceSnapshotId: null,
      sourceHash: null,
      rawCaptureId: null,
      rawCustodyId: null,
      evidenceCustody: null,
    });
    const evidence = (
      await repo.getMainActivityHistory(CUI.noSource, {
        kind: 'evidence',
        beforeId: null,
        limit: 5,
      })
    )._unsafeUnwrap();
    expect(evidence).toMatchObject({
      state: 'read',
      evidence: [
        {
          anafWithdrawn: false,
          anaf: {
            sourceSnapshotId: null,
            evidenceCustody: null,
          },
        },
      ],
    });
  });

  it('a reviewed correction without fiscal evidence stands: CORRECTED rev2:6201 with the no-source ANAF object', async () => {
    const { activity } = await activityOf(CUI.noSourceCorrected);
    expect(activity).toMatchObject({
      currentness: 'current',
      status: 'corrected',
      revisionBasis: 'reviewed_correction',
      resolved: { revision: 'rev2', code: '6201' },
      anaf: { sourceSnapshotId: null, evidenceCustody: null },
    });
  });

  it('a REAL fiscal row with an absent CAEN token is SOURCE_MISSING too, and keeps its source', async () => {
    const { activity } = await activityOf(CUI.missingToken);
    expect(activity).toMatchObject({
      currentness: 'current',
      status: 'source_missing',
      anaf: {
        sourceSnapshotId: `anaf:${CUI.missingToken}`,
        jsonType: 'absent',
      },
    });
  });

  it('a PARTIAL no-source shape (a source hash without a snapshot) fails closed on the current read and the evidence history', async () => {
    expect((await repo.getMainActivity(CUI.partial, { flags: false })).isErr()).toBe(true);
    expect(
      (
        await repo.getMainActivityHistory(CUI.partial, {
          kind: 'evidence',
          beforeId: null,
          limit: 5,
        })
      ).isErr()
    ).toBe(true);
  });

  it('a hold while the pinned edition is unavailable: ONRC_UNAVAILABLE first, integrityHeld true, token suppressed, source dates kept', async () => {
    // Withdrawing the ACTIVE edition makes every assignment of it ONRC_UNAVAILABLE.
    await withdrawEdition(ids.e1);
    const { read, activity } = await activityOf(CUI.held);
    expect(activity).toMatchObject({
      currentness: 'onrc_unavailable',
      integrityHeld: true,
      anafWithdrawn: false,
      status: null,
      resolved: null,
      edition: null,
      anaf: { originalToken: null, tokenForm: null, statusDate: '2026-06-15' },
    });
    expect(
      read.flags.state === 'read' && read.flags.flags.every((f) => f.isMainCaen === null)
    ).toBe(true);
  });
});
