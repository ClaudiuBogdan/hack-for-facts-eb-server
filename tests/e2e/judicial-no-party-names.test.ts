/**
 * JUST-9Q9C on a real PostgreSQL: the judicial module publishes NO party name,
 * for any kind, and no case object text (26 November 2026).
 *
 * The justice schema is the data repo's four original migrations, pinned by
 * SHA-256 and applied to a throwaway container. Synthetic rows only: a company
 * name key and a public-entity name key that share a word, both tracing to a
 * party row with a publishable rule, so both pass every gate the reads had
 * before this change. Nothing is read from, or written to, any other database.
 *
 * Proved here:
 *  - the id lookup and the name search return no name, for the company and for
 *    the public entity;
 *  - a case still lists its parties with their kind, and none carries a name, a
 *    key or a legal form;
 *  - the company-litigation join still counts the cases of both linked CUIs:
 *    only the name is withheld;
 *  - the case object text is stored and findable in PostgreSQL yet never
 *    served (case detail, case list), and the `q` filter on it is refused on
 *    the list and on the caseload aggregate.
 *
 * Without a checkout that has the migrations (`SCRAPPER_REPO_ROOT`) or without
 * a container runtime the suite SKIPS, or fails when `TEST_E2E_REQUIRED=1`.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import {
  getCaseDetail,
  getCompanyLitigation,
  getCourtCaseload,
  listCases,
  resolveJudicialFilters,
} from '@/modules/judicial/core/usecases.js';
import { makeJudicialModule, type JudicialModule } from '@/modules/judicial/index.js';
import { createContributorRegistry } from '@/modules/shared/index.js';
import { createProdDb, type ProdDb } from '@/modules/shared/shell/db/pool.js';

import { dockerCliUp, teardownDisposablePostgres } from './disposable-postgres.js';

import type { Kysely } from 'kysely';

/** The justice schema, in apply order (the same four files judicial-a3 pins). */
const MIGRATION_SHA256: Readonly<Record<string, string>> = {
  '20260614T120000__justice_domain.ts':
    '6492bd70d06c7e6bd142be0e0a716e1389d9d2acb8a7e4ccf9292de83205dc52',
  '20260614T120100__justice_links.ts':
    '5fded953b09af4a52a8675afb75eb6471ce4cdaaa18c6f839f3c7ff4f48a490e',
  '20260629T130000__justice_case_legal_ref_hearing_anchor.ts':
    '1628173cdcecab0bbd1d72f73e93faf4448f2eb13aa8dedf0c1dbd1ec24d791d',
  '20260629T131000__justice_iccj_court.ts':
    '4bfcea271e16e43ba78e77fdfe0f61f6d5229f4a0574a8b80906ee496137f60a',
};
const FIRST_MIGRATION = '20260614T120000__justice_domain.ts';

const COURT = 'TEST_NAMES_TRIBUNAL';
const CASE_ID = '9';
const COMPANY_KEY = '11';
const PUBLIC_ENTITY_KEY = '12';
/** Synthetic names; the shared word makes one search match both rows. */
const COMPANY_NAME = 'FIXTURE ALFA SRL';
const PUBLIC_ENTITY_NAME = 'FIXTURE ALFA INSTITUTIE';
const SHARED_WORD = 'alfa';
/** Synthetic CUIs: one published link to each name key. */
const COMPANY_CUI = '900001';
const PUBLIC_ENTITY_CUI = '900002';
/** A synthetic object text and a marker inside it. */
const OBJECT_TEXT = 'obiect de test cu MARCAJ ALFA';
const OBJECT_NEEDLE = 'MARCAJ ALFA';

let container: StartedPostgreSqlContainer | undefined;
let admin: pg.Client | undefined;
let prod: ProdDb | undefined;
let judicial: JudicialModule | undefined;
let ready = false;

const unavailable = (reason: string): void => {
  if (process.env['TEST_E2E_REQUIRED'] === '1') {
    throw new Error(`judicial no-party-names e2e required but unavailable: ${reason}`);
  }
  console.warn(`judicial no-party-names e2e skipped: ${reason}`);
};

const it = (name: string, test: () => Promise<void>): void => {
  vitestIt(name, async ({ skip }) => {
    if (!ready) skip();
    await test();
  });
};

const migrationPath = (root: string, file: string): string =>
  path.join(root, 'src', 'db', 'prod-migrations', file);

const resolveScrapperRoot = (): string | undefined => {
  const explicit = process.env['SCRAPPER_REPO_ROOT'];
  const candidates = [
    ...(explicit !== undefined && explicit !== '' ? [explicit] : []),
    path.resolve(process.cwd(), '..', 'hack-for-facts-eb-scrapper'),
    path.resolve(process.cwd(), '..', '..', '..', '..', 'hack-for-facts-eb-scrapper'),
  ];
  return candidates.find((c) => fs.existsSync(migrationPath(c, FIRST_MIGRATION)));
};

const seed = async (client: pg.Client): Promise<void> => {
  await client.query(
    `insert into justice.courts (institution_code, ordinal, court_level, locality)
     values ($1, 9401, 'tribunal', 'NAMESLOC')`,
    [COURT]
  );
  await client.query(
    `insert into justice.cases (case_id, source_slug, institution_code, case_number,
       category, object, source_opened_at, latest_source_modified_at)
     values ($1::bigint, 'portal_just', $2, '9/3/2024', 'NAMESCAT', $3,
       '2024-06-15T12:00:00Z', null)`,
    [CASE_ID, COURT, OBJECT_TEXT]
  );
  for (const [id, key, name, kind, legalForm] of [
    [COMPANY_KEY, 'fixture alfa srl', COMPANY_NAME, 'company', 'SRL'],
    [PUBLIC_ENTITY_KEY, 'fixture alfa institutie', PUBLIC_ENTITY_NAME, 'public_entity', 'INST'],
  ] as const) {
    await client.query(
      `insert into justice.party_name_keys (name_key_id, name_key, display_name, party_kind,
         legal_form, mention_count, classifier_version, normalizer_version)
       overriding system value
       values ($1::bigint, $2, $3, $4, $5, 1, 'party-kind-v0', 'test-names')`,
      [id, key, name, kind, legalForm]
    );
  }
  // Every row carries a publishable rule and the recognized classifier version.
  for (const [index, nameKey, kind, rule] of [
    [0, COMPANY_KEY, 'company', 'company_legal_form'],
    [1, PUBLIC_ENTITY_KEY, 'public_entity', 'public_entity_anchor'],
  ] as const) {
    await client.query(
      `insert into justice.case_parties (case_id, party_index, name_key_id, party_kind,
         classifier_version, classifier_rule, row_hash, latest_response_id, parser_version)
       values ($1::bigint, $2, $3::bigint, $4, 'party-kind-v0', $5, 'h', 1, 'test-names')`,
      [CASE_ID, index, nameKey, kind, rule]
    );
  }
  for (const [nameKey, cui] of [
    [COMPANY_KEY, COMPANY_CUI],
    [PUBLIC_ENTITY_KEY, PUBLIC_ENTITY_CUI],
  ] as const) {
    await client.query(
      `insert into justice.party_company_candidates (name_key_id, candidate_cui, method,
         confidence_tier, validation_status, resolver_version)
       values ($1::bigint, $2, 'exact_normalized_name_unique', 'A', 'published', 'test-names')`,
      [nameKey, cui]
    );
  }
};

beforeAll(async () => {
  const scrapperRoot = resolveScrapperRoot();
  if (scrapperRoot === undefined) {
    unavailable(`no scrapper checkout with ${FIRST_MIGRATION} (SCRAPPER_REPO_ROOT)`);
    return;
  }
  if (!dockerCliUp()) {
    unavailable('no container runtime');
    return;
  }
  for (const [file, digest] of Object.entries(MIGRATION_SHA256)) {
    const actual = createHash('sha256')
      .update(fs.readFileSync(migrationPath(scrapperRoot, file)))
      .digest('hex');
    expect(actual, `${file} changed in the scrapper checkout`).toBe(digest);
  }
  container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('judicial_no_party_names')
    .start();
  const connectionString = container.getConnectionUri();
  admin = new pg.Client({ connectionString });
  await admin.connect();
  prod = createProdDb({ connectionString, max: 4 });
  const setup = prod.db as unknown as Kysely<unknown>;
  for (const file of Object.keys(MIGRATION_SHA256)) {
    const migration = (await import(pathToFileURL(migrationPath(scrapperRoot, file)).href)) as {
      up: (db: Kysely<unknown>) => Promise<void>;
    };
    await migration.up(setup);
  }
  await seed(admin);
  judicial = makeJudicialModule({
    db: prod.db,
    registry: createContributorRegistry(),
    legalActLoader: () => undefined,
  });
  ready = true;
}, 150_000);

afterAll(async () => {
  await teardownDisposablePostgres(
    container,
    () => admin?.end(),
    () => prod?.db.destroy()
  );
});

const repos = (): JudicialModule['repos'] => {
  if (judicial === undefined) throw new Error('module not ready');
  return judicial.repos;
};

describe('judicial party names on a real PostgreSQL: none is published (JUST-9Q9C)', () => {
  it('the fixture holds both names, each with a publishable party row', async () => {
    const rows = await admin?.query<{ party_kind: string; n: string }>(
      `select k.party_kind, count(*)::text as n
         from justice.party_name_keys k
         join justice.case_parties p on p.name_key_id = k.name_key_id
        where p.classifier_rule in ('company_legal_form', 'public_entity_anchor')
          and p.classifier_version = 'party-kind-v0'
          and k.display_name ilike '%' || $1 || '%'
        group by k.party_kind order by k.party_kind`,
      [SHARED_WORD]
    );
    expect(rows?.rows).toEqual([
      { party_kind: 'company', n: '1' },
      { party_kind: 'public_entity', n: '1' },
    ]);
  });

  it('the id lookup returns no name, for the company and for the public entity', async () => {
    const names = (
      await repos().dictionary.getPublishableNames([COMPANY_KEY, PUBLIC_ENTITY_KEY])
    )._unsafeUnwrap();
    expect(names.size).toBe(0);
    for (const key of [COMPANY_KEY, PUBLIC_ENTITY_KEY]) {
      expect((await repos().dictionary.getPublishableName(key))._unsafeUnwrap()).toBeNull();
    }
  });

  it('the name search returns no name, for the company and for the public entity', async () => {
    for (const word of [SHARED_WORD, 'srl', 'institutie', 'fixture']) {
      expect((await repos().dictionary.resolveCompanyName(word, 50))._unsafeUnwrap()).toEqual([]);
      // The same through the discovery usecase every transport calls.
      expect(
        (await resolveJudicialFilters(repos(), 'companyName', word, 50))._unsafeUnwrap()
      ).toEqual([]);
    }
  });

  it('a case still lists its parties by kind; none carries a name, a key or a legal form', async () => {
    const detail = (await getCaseDetail(repos(), { caseId: CASE_ID }))._unsafeUnwrap();
    expect(detail?.parties).toEqual([
      {
        partyIndex: 0,
        partyKind: 'company',
        roleNormalized: null,
        nameKeyId: null,
        name: null,
        legalForm: null,
      },
      {
        partyIndex: 1,
        partyKind: 'public_entity',
        roleNormalized: null,
        nameKeyId: null,
        name: null,
        legalForm: null,
      },
    ]);
    // Nothing of either synthetic name is anywhere in the case answer.
    const answer = JSON.stringify(detail);
    expect(answer).not.toContain(COMPANY_NAME);
    expect(answer).not.toContain(PUBLIC_ENTITY_NAME);
  });

  it('company litigation keeps its counts; the name is withheld for both linked CUIs', async () => {
    for (const cui of [COMPANY_CUI, PUBLIC_ENTITY_CUI]) {
      const summary = (await getCompanyLitigation(repos(), cui))._unsafeUnwrap();
      expect([cui, summary.caseCount, summary.companyName]).toEqual([cui, 1, null]);
    }
  });

  it('the fixture case holds an object text that a search in PostgreSQL finds', async () => {
    const rows = await admin?.query<{ n: string }>(
      `select count(*)::text as n from justice.cases c
        where c.institution_code = $1 and c.object ilike '%' || $2 || '%'`,
      [COURT, OBJECT_NEEDLE]
    );
    expect(rows?.rows).toEqual([{ n: '1' }]);
  });

  it('case detail keeps the case and serves no object text', async () => {
    const detail = (await getCaseDetail(repos(), { caseId: CASE_ID }))._unsafeUnwrap();
    expect(detail?.case).toMatchObject({
      caseId: CASE_ID,
      institutionCode: COURT,
      caseNumber: '9/3/2024',
      category: 'NAMESCAT',
      object: null,
    });
    expect(JSON.stringify(detail)).not.toContain(OBJECT_NEEDLE);
    const byKey = (
      await getCaseDetail(repos(), { institutionCode: COURT, caseNumber: '9/3/2024' })
    )._unsafeUnwrap();
    expect(byKey?.case.object).toBeNull();
    expect(JSON.stringify(byKey)).not.toContain(OBJECT_NEEDLE);
  });

  it('the case list keeps the case and serves no object text', async () => {
    const page = (
      await listCases(repos(), {
        filter: { institutionCode: { in: [COURT] } },
        sort: 'openedAt',
        dir: 'desc',
        page: { first: 10 },
      })
    )._unsafeUnwrap();
    expect(page.items.map((item) => [item.node.caseId, item.node.object])).toEqual([
      [CASE_ID, null],
    ]);
    expect(JSON.stringify(page)).not.toContain(OBJECT_NEEDLE);
  });

  it('the q filter is refused on the list and on the aggregate, without repeating the query', async () => {
    const filter = { institutionCode: { in: [COURT] }, q: { contains: OBJECT_NEEDLE } };
    const listed = await listCases(repos(), {
      filter,
      sort: 'openedAt',
      dir: 'desc',
      page: { first: 10 },
    });
    const counted = await getCourtCaseload(repos(), 'category', filter);
    for (const res of [listed, counted]) {
      expect(res.isErr()).toBe(true);
      const error = res._unsafeUnwrapErr();
      expect([error.type, 'field' in error ? error.field : null]).toEqual(['InvalidInput', 'q']);
      expect(error.message).not.toContain(OBJECT_NEEDLE);
    }
    // The aggregate without q still counts the case.
    const plain = (
      await getCourtCaseload(repos(), 'category', { institutionCode: { in: [COURT] } })
    )._unsafeUnwrap();
    expect(plain.denominator).toBe(1);
  });
});
