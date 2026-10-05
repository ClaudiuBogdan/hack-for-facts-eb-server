/**
 * The global search's company contribution reader — real-DDL PostgreSQL proof
 * (WRITTEN FOR THE PRIMARY'S THROWAWAY PROOF; never run by the author and not
 * part of the default unit runs: `*.pg.test.ts` is excluded there).
 *
 * Prerequisite: `COMPANIES_SEARCH_TEST_DATABASE_URL` points at a FRESH,
 * DISPOSABLE PostgreSQL database on which the scrapper's prod migration chain
 * has been applied through `20261003T172000__companies_onrc_editions`, with
 * `core.public_entities` present (the kernel's institution hub). The file
 * refuses a database that already holds ONRC editions; every seeded row stays
 * behind. Never point it at a shared or production database. It is a separate
 * variable from the ONRC reader proof's, which also requires a fresh database.
 *
 * Seeding follows `onrc-edition-reader.pg.test.ts` (whose insert statements
 * are copied, not imported): one transaction under `session_replication_role
 * = replica` disables the append-only/seal/publication GUARD TRIGGERS for the
 * fixture only; every CHECK constraint, the public `onrc_published_*` views,
 * the publication envelope and the module's SQL are the real ones. Expected
 * values are hand-written from the fixture, never computed by the code under
 * test. No source verifier fixture or oracle is used.
 *
 * What it proves on the actual DDL (api-repair-09):
 *  - the privacy population: short canonical CUIs (`1`, `4`, `7`) are
 *    classified by the all-kind parent read; a restricted parent of any kind
 *    is private; a public company outside the ONRC shape (`7`) contributes
 *    nothing; an absent CUI is `none`;
 *  - company values only for public company parents of the ONRC shape, bound
 *    to the pinned edition (in edition, not in edition, ONRC county);
 *  - the generic-county fallback: an institution role on a PUBLIC territory
 *    gives its county; on a restricted territory none;
 *  - the final decision refuses once a served short CUI turns non-public.
 */

import { Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REGISTRY_MOVED_MESSAGE } from '@/modules/companies/core/registry.js';
import { makeCompanySearchContribution } from '@/modules/companies/core/search-contribution.js';
import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';
import { makeCompanySearchReader } from '@/modules/companies/shell/repo/search-contribution-sql.js';

import type { ProdDatabase, SearchCompanyContributionPort } from '@/modules/shared/index.js';

const URL = process.env['COMPANIES_SEARCH_TEST_DATABASE_URL'] ?? '';
const d = URL.length > 0 ? describe : describe.skip;

// ── fixture (hand-written) ────────────────────────────────────────────────────

const CUI = {
  privateShort: '1', // institution, restricted organization
  publicShort: '4', // institution, public organization, public territory
  shortCompany: '7', // public company outside the ONRC shape (one digit)
  alfa: '9910001', // in edition, ONRC county missing, institution role on a PUBLIC territory (CJ)
  beta: '9910002', // in edition, ONRC county CJ, a public 1048 on its identifier
  privateCompany: '9910003', // restricted company
  hiddenTerritory: '9910005', // core-only company, institution role on a RESTRICTED territory
  coreOnly: '9910006', // core-only company, no institution role
  absent: '9999999', // no core organization
} as const;

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
let port: SearchCompanyContributionPort;
let seeding: PoolClient | null = null;

const q = async (text: string, values: unknown[] = []): Promise<Record<string, unknown>[]> =>
  (await (seeding ?? pool).query(text, values)).rows as Record<string, unknown>[];

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

const seed = async (): Promise<void> => {
  const existing = await q(`select count(*)::text as n from companies_v2.onrc_editions`);
  if (existing[0]?.['n'] !== '0') {
    throw new Error('COMPANIES_SEARCH_TEST_DATABASE_URL must be a FRESH throwaway database');
  }
  let edition = '';
  await withReplica(async () => {
    const orgs: readonly (readonly [string, string, string, string])[] = [
      [CUI.privateShort, 'public_entity', 'PRIVATE PARENT NAME', 'restricted'],
      [CUI.publicShort, 'public_entity', 'PRIMARIA PATRU', 'public'],
      [CUI.shortCompany, 'company', 'SAPTE SRL', 'public'],
      [CUI.alfa, 'company', 'ALFA CORE NAME', 'public'],
      [CUI.beta, 'company', 'BETA CORE NAME', 'public'],
      [CUI.privateCompany, 'company', 'PRIVATE COMPANY', 'restricted'],
      [CUI.hiddenTerritory, 'company', 'HIDDEN TERRITORY SRL', 'public'],
      [CUI.coreOnly, 'company', 'CORE ONLY SRL', 'public'],
    ];
    for (const [cui, kind, name, privacy] of orgs) {
      await q(
        `insert into core.organizations (cui, kind, name, first_seen_source, privacy_class)
         values ($1, $2, $3, 'fixture', $4)`,
        [cui, kind, name, privacy]
      );
    }
    // The county hub (CJ public) and a restricted territory.
    const territory = async (
      siruta: string,
      name: string,
      code: string,
      privacy: string
    ): Promise<number> =>
      Number(
        (
          await q(
            `insert into core.territories (territorial_siruta_code, siruta_code, name, county_code,
               county_name, region, level, kind, territory_key, privacy_class)
             values ($1, $1, $2, $3, $2, 'Test', 'county', 'county', $4, $5)
             returning id`,
            [siruta, name, code, `fixture:search:${siruta}`, privacy]
          )
        )[0]?.['id']
      );
    const cluj = await territory('9991001', 'Cluj', 'CJ', 'public');
    const hidden = await territory('9991002', 'Ascuns', 'XX', 'restricted');
    for (const [cui, name, territoryId] of [
      [CUI.publicShort, 'PRIMARIA PATRU', cluj],
      [CUI.alfa, 'ALFA REGIE', cluj],
      [CUI.hiddenTerritory, 'HIDDEN INSTITUTION', hidden],
    ] as const) {
      await q(
        `insert into core.public_entities (cui, name, is_territorial_executive, is_uat, entity_type, territory_id)
         values ($1, $2, false, false, 'fixture', $3)`,
        [cui, name, territoryId]
      );
    }

    edition = String(
      (
        await q(
          `insert into companies_v2.onrc_editions
             (content_key, source_snapshot_id, source_published_at, manifest, interpretation_version,
              privacy_policy_version, dimension_policy_version, eligibility_policy_version,
              address_match_bundle_sha256, reference_bundle_sha256, state, seal)
           values ($1, 'onrc:2026-09-30', '2026-09-30'::date, $2::jsonb, 'onrc-interpretation-v1',
                   'onrc-privacy-v1', 'onrc-dimension-v1', 'public-legal-person-v1', $3, $4,
                   'verified', '{"fixture":true}')
           returning edition_id::text as id`,
          [sha('9'), MANIFEST, sha('d'), sha('e')]
        )
      )[0]?.['id']
    );
    const profile = (
      cui: string,
      name: string,
      county: [string | null, string],
      statusCoverage: string
    ) =>
      q(
        `insert into companies_v2.onrc_edition_profiles
           (edition_id, cui, identity_observations, identifier_count, unresolved_identifier_count,
            unidentified_observations, name, name_basis, legal_form, legal_form_basis, recorded_date,
            recorded_date_basis, county_code, county_basis, uat_siruta_code, uat_basis, status_code,
            status_basis, caen_coverage, status_coverage, legal_person_eligibility, eligibility_reason,
            eligibility_policy_version, privacy_class)
         values ($1::bigint, $2, 1, 1, 0, 0, $3, 'single_observation', 'SRL', 'single_observation',
                 null, 'missing', $4, $5, null, 'missing', null, 'missing', 'complete', $6,
                 'eligible', null, 'public-legal-person-v1', 'public')`,
        [edition, cui, name, county[0], county[1], statusCoverage]
      );
    await profile(CUI.alfa, 'ALFA SRL', [null, 'missing'], 'partial');
    await profile(CUI.beta, 'BETA SRL', ['CJ', 'single_observation'], 'complete');
    await q(
      `insert into companies_v2.onrc_identifier_profiles
         (edition_id, identifier_key, identity_resolution, cui, identity_row_count, identity_row_numbers,
          status_codes, public_status_codes, status_summary_code, status_summary_basis,
          status_observations, unparsed_status_observations, restricted_status_observations,
          county_codes, county_basis, caen_observations, unparsed_caen_observations,
          unknown_revision_caen_observations, restricted_caen_observations, privacy_class)
       values ($1::bigint, 'J12/1/2010', 'resolved_cui', $2, 1, '{1}'::int[], '{1048}'::text[],
               '{1048}'::text[], '1048', 'single_code', 1, 0, 0, '{CJ}'::text[],
               'single_observation', 0, 0, 0, 0, 'public')`,
      [edition, CUI.beta]
    );
  });

  // Publish the edition (an event, the pointer and the access epoch), as the real entry does.
  await withReplica(async () => {
    await q(`update companies_analytics.privacy_state set epoch = epoch + 1 where singleton`);
    const event = await q(
      `insert into companies_v2.onrc_publications
         (event_kind, edition_id, previous_active_edition_id, new_active_edition_id,
          publication_epoch, privacy_epoch, load_run_id, actor, reason, receipt, transaction_id)
       values ('publish', $1::bigint, null, $1::bigint, 1,
               (select epoch from companies_analytics.privacy_state where singleton), 991001,
               'fixture', 'search contribution proof', '{}'::jsonb, pg_current_xact_id())
       returning event_id::text as id`,
      [edition]
    );
    await q(
      `update companies_v2.onrc_publication
          set active_edition_id = $1::bigint, previous_edition_id = null,
              epoch = 1, last_event_id = $2::bigint
        where singleton`,
      [edition, event[0]?.['id']]
    );
  });
};

d('search contribution reader on the actual DDL', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 4 });
    db = new Kysely<ProdDatabase>({ dialect: new PostgresDialect({ pool }) });
    port = makeCompanySearchContribution(makeCompaniesRepo(db), makeCompanySearchReader(db));
    await seed();
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('classifies the privacy population and reads company values only for the ONRC shape', async () => {
    const hydration = (await port.hydrate(Object.values(CUI), true))._unsafeUnwrap();
    expect(hydration.published).toBe(true);
    expect(hydration.scopeKey).toMatch(/^onrc:published:[1-9][0-9]*:1:[0-9]+$/u);
    expect(Object.fromEntries(hydration.parents)).toEqual({
      '1': { kind: 'private' },
      '4': { kind: 'none' },
      '7': { kind: 'none' },
      '9910001': {
        kind: 'company',
        values: {
          registryState: 'in_edition',
          name: 'ALFA SRL',
          nameSource: 'onrc_edition',
          legalForm: 'SRL',
          countyCode: null,
          countyName: null,
          active: null,
          identifiers: [],
        },
        independentCountyName: 'Cluj',
      },
      '9910002': {
        kind: 'company',
        values: {
          registryState: 'in_edition',
          name: 'BETA SRL',
          nameSource: 'onrc_edition',
          legalForm: 'SRL',
          countyCode: 'CJ',
          countyName: 'Cluj',
          active: true,
          identifiers: ['J12/1/2010'],
        },
        independentCountyName: null,
      },
      '9910003': { kind: 'private' },
      '9910005': {
        kind: 'company',
        values: {
          registryState: 'not_in_edition',
          name: 'HIDDEN TERRITORY SRL',
          nameSource: 'core_organization',
          legalForm: null,
          countyCode: null,
          countyName: null,
          active: null,
          identifiers: [],
        },
        // Its institution's territory is restricted: no county.
        independentCountyName: null,
      },
      '9910006': {
        kind: 'company',
        values: {
          registryState: 'not_in_edition',
          name: 'CORE ONLY SRL',
          nameSource: 'core_organization',
          legalForm: null,
          countyCode: null,
          countyName: null,
          active: null,
          identifiers: [],
        },
        independentCountyName: null,
      },
      '9999999': { kind: 'none' },
    });
  });

  it('the final decision refuses once a served short CUI turns non-public', async () => {
    const hydration = (await port.hydrate([CUI.publicShort], true))._unsafeUnwrap();
    expect((await port.confirm(hydration.scopeKey, [CUI.publicShort])).isOk()).toBe(true);
    await q(`update core.organizations set privacy_class = 'restricted' where cui = $1`, [
      CUI.publicShort,
    ]);
    expect(
      (await port.confirm(hydration.scopeKey, [CUI.publicShort]))._unsafeUnwrapErr().message
    ).toBe(REGISTRY_MOVED_MESSAGE);
  });
});
