/**
 * Contract awards (PROC-KB0Z step 1) over the data platform's REAL view DDL
 * (tests/fixtures/procurement/ca-public-views-ddl.ts, generated from the
 * scrapper's migrations), on a throwaway PostgreSQL 18, read as a login that
 * holds only the API's grants (the four views, the names views, da_release).
 *
 * Proves: the reader rules (keys first on plain columns, rows by key; no
 * computed column in a keys or count plan, so the 77 s path cannot return), the
 * 2021 floor and undated records, a person buyer never named by code, winner
 * codes only through supplier_names_public, a re-anchored id, and the refusals
 * (no grant, outside the window, absent).
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import fastifyLib from 'fastify';
import { CompiledQuery, Kysely, PostgresDialect, sql, type RawBuilder } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import {
  caBuyerSummary,
  getCaRecord,
  listCaBuyerRecords,
  OUTSIDE_WINDOW_RESOURCE,
  type CaRecordsDeps,
} from '@/modules/procurement/core/ca-records-usecases.js';
import {
  caRecordsTypeDefs,
  makeCaRecordsResolvers,
} from '@/modules/procurement/shell/graphql/ca-records-schema.js';
import {
  buyerCountsSql,
  buyerKeysSql,
  makeCaRecordsRepo,
  recordRowsSql,
} from '@/modules/procurement/shell/repo/ca-records-repo.js';
import { makeCaRecordsRestPlugin } from '@/modules/procurement/shell/rest/ca-records-routes.js';
import {
  baseTypeDefs,
  mergeGraphqlSlices,
  scalarResolvers,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { dockerCliUp } from './disposable-postgres.js';
import {
  CA_NAMING_DDL,
  CA_PLATFORM_TABLES,
  CA_PUBLIC_VIEWS_DDL,
} from '../fixtures/procurement/ca-public-views-ddl.js';

let dockerAvailable = false;
let container: StartedPostgreSqlContainer | undefined;
let owner: Kysely<ProdDatabase> | undefined;
let api: Kysely<ProdDatabase> | undefined;
let noGrant: Kysely<ProdDatabase> | undefined;
let noNames: Kysely<ProdDatabase> | undefined;
let deps: CaRecordsDeps;

const it = (name: string, test: () => Promise<void>): void => {
  vitestIt(name, async ({ skip }) => {
    if (!dockerAvailable) skip();
    await test();
  });
};

/** A mintable Romanian code: the body and its check digit (weights 7,5,3,2,1,7,5,3,2). */
const cui = (body: string): string => {
  const padded = body.padStart(9, '0');
  const weights = [7, 5, 3, 2, 1, 7, 5, 3, 2];
  const sum = weights.reduce((total, weight, i) => total + weight * Number(padded[i]), 0);
  const check = (sum * 10) % 11;
  return `${body}${String(check === 10 ? 0 : check)}`;
};

const BUYER = cui('4300001');
const PERSON_BUYER = cui('4300002');
const BIG_BUYER = cui('4300003');
const NO_RECORDS_BUYER = cui('4300004');
const GATE_WINNER = cui('5100001');
const MASKED_WINNER = cui('5100002');
const WITHHELD_WINNER = cui('5100003');
const NO_NAMES_ROW_WINNER = cui('5100004');
const BUYER_NAME = 'PRIMARIA TESTULUI';
const PERSON_REGISTRY_NAME = 'POPESCU IONELA PFA';
const SECRET_WINNER_NAME = 'SECRETA PERSOANA';

const STUBS_DDL = `
  create schema core;
  create schema companies_v2;
  create schema procurement_v3;
  create function core.normalize_cui(raw text) returns text language sql immutable as $f$
    select case when raw ~ '^[0-9]{1,10}$' then raw end $f$;
  create function core.cui_is_mintable(raw text) returns boolean language sql immutable as $f$
    with p as (select lpad(core.normalize_cui(raw), 10, '0') as p)
    select coalesce(length(core.normalize_cui(raw)) between 2 and 10 and core.normalize_cui(raw) !~ '^0'
      and (case when ((substr(p,1,1)::int*7 + substr(p,2,1)::int*5 + substr(p,3,1)::int*3 + substr(p,4,1)::int*2
        + substr(p,5,1)::int*1 + substr(p,6,1)::int*7 + substr(p,7,1)::int*5 + substr(p,8,1)::int*3
        + substr(p,9,1)::int*2) * 10) % 11 = 10 then 0 else ((substr(p,1,1)::int*7 + substr(p,2,1)::int*5
        + substr(p,3,1)::int*3 + substr(p,4,1)::int*2 + substr(p,5,1)::int*1 + substr(p,6,1)::int*7
        + substr(p,7,1)::int*5 + substr(p,8,1)::int*3 + substr(p,9,1)::int*2) * 10) % 11 end)
        = substr(p, 10, 1)::int, false) from p $f$;
  create table core.organizations (org_id bigint primary key, cui text, name text, display_name text,
    privacy_class text not null);
  create table companies_v2.onrc_current_profiles (cui text primary key, eligibility_reason text);
`;

/** What the API reads beside the four views (shapes as the API reads them). */
const API_SIDE_DDL = `
  create table procurement_v3.da_release (data_as_of timestamptz not null);
  create view procurement_v3.supplier_disclosure with (security_barrier = true) as
    select sp.fiscal_code_clean, sp.supplier_id
    from procurement_v3.supplier_privacy sp
    where sp.public and sp.supplier_kind = 'company';
  create table procurement_v3.supplier_names_public (fiscal_code_clean text primary key, naming text,
    display_name text, code_shown boolean);
  create table procurement_v3.party_public_names (fiscal_code_clean text primary key, registry_name text,
    buyer_name_public boolean, supplier_name_public boolean);
`;

const GRANTS = `
  create role ca_api login password 'ca_api';
  create role ca_nogrant login password 'ca_nogrant';
  create role ca_nonames login password 'ca_nonames';
  grant usage on schema procurement_v3 to ca_api, ca_nogrant, ca_nonames;
  -- As procurement-api-read.sql: the views' SQL functions (core.cui_is_mintable) are parsed as the caller.
  grant usage on schema core to ca_api, ca_nogrant, ca_nonames;
  -- As procurement-api-read.sql: da_release is granted per column.
  grant select (data_as_of) on procurement_v3.da_release to ca_api, ca_nogrant, ca_nonames;
  grant select on procurement_v3.ca_records_public, procurement_v3.ca_record_winners_public,
    procurement_v3.ca_record_lots_public, procurement_v3.ca_record_keys_public to ca_api, ca_nonames;
  grant select on procurement_v3.supplier_names_public, procurement_v3.party_public_names to ca_api, ca_nogrant;
  grant select on procurement_v3.party_public_names to ca_nonames;
`;

const AS_OF = '2026-11-24T12:00:00.000000Z';

interface Fact {
  pub: string;
  contract: string;
  matchPub?: string;
  kind?: 'plain_contract' | 'framework_agreement' | 'subsequent_contract';
  status?: 'eligible' | 'identity_review' | 'superseded';
  valueKind?: 'awarded' | 'framework_ceiling' | 'modification_change';
  amount: string | null;
  day: string | null;
  buyer: string;
  evidencePub?: string;
}

const factSql = (f: Fact): RawBuilder<unknown> => {
  const valueKind =
    f.valueKind ?? (f.kind === 'framework_agreement' ? 'framework_ceiling' : 'awarded');
  const status = f.status ?? 'eligible';
  const additive = status === 'eligible' && valueKind !== 'modification_change';
  return sql`insert into procurement_v3.ca_money_facts (source_name, match_id, value_kind, contract_kind,
      current_status, head_status, current_publication_id, current_contract_id, evidence_publication_id,
      evidence_contract_id, native_amount, currency_id, reported_ron, amount_source, additive_ron,
      review_exposure_ron, vat_basis, conclusion_day, publication_day, procedure_id, buyer_code, category_code,
      members, flag_page_value, flag_list_value, flag_foreign_lei_equivalent, flag_zero, flag_negative,
      flag_currency_unknown, flag_rate_unknown, flag_native_ron_disagrees, flag_unverified_head,
      flag_history_incomplete, flag_kind_unknown, flag_change_carried, superseded_at)
    values ('seap', ${`ca:${f.matchPub ?? f.pub}:${f.contract}`}, ${valueKind}, ${f.kind ?? 'plain_contract'},
      ${status}, 'named_head', ${f.pub}, ${f.contract}, ${f.evidencePub ?? f.pub}, ${f.contract},
      ${f.amount}::numeric, 1, ${f.amount}::numeric,
      ${valueKind === 'modification_change' ? 'view_ron_change' : 'view_ron'},
      ${additive || (status === 'eligible' && valueKind === 'modification_change') ? f.amount : null}::numeric,
      ${status === 'identity_review' ? f.amount : null}::numeric, 'unknown', ${f.day}::date, ${f.day}::date,
      'P1', ${f.buyer}, '45000000-7', 1, false, false, false, false, false, false, false, false, false,
      false, false, false, ${status === 'superseded' ? sql`now()` : null})`;
};

const publicationSql = (
  pub: string,
  title: string | null,
  day: string | null
): RawBuilder<unknown> =>
  sql`insert into procurement_v3.ca_publications (source_name, publication_id, family, public_id, raw_item_ref,
      raw_item_key, source_url, notice_no, notice_no_status, title, listing_status, publication_at_status,
      publication_day, chain_reference, procedure_id_status, category_code_status, list_value_status,
      list_view_agree, list_view_differences, buyer_fiscal_code_status, expected_rule_version, part_summary,
      list_payload_key)
    values ('seap', ${pub}, 'ca', ${`pub-${pub}`}, ${Number(pub)}, ${`raw-${pub}`},
      ${`https://e-licitatie.example/ca/${pub}`}, ${`CAN${pub}`}, 'valid', ${title}, 'listed', 'valid',
      ${day}::date, ${`chain-${pub}`}, 'valid', 'valid', 'valid', 'agree', '{}', 'valid', 'r1', '{}'::jsonb,
      ${`payload-${pub}`})`;

const winnerSql = (
  pub: string,
  contract: string,
  key: string,
  order: number,
  code: string | null
) =>
  sql`insert into procurement_v3.ca_contract_winners (source_name, publication_id, contract_id, winner_key,
      page_order, view_order, view_code_clean, view_code_status, page_code_clean, page_code_status,
      link_status, party_eligible)
    values ('seap', ${pub}, ${contract}, ${key}, ${order}, ${order}, ${code},
      ${code === null ? 'missing' : 'valid'}, ${code}, ${code === null ? 'missing' : 'valid'}, 'linked', true)`;

const lotSql = (pub: string, contract: string, lot: string, order: number, title: string) => [
  sql`insert into procurement_v3.ca_lots (source_name, publication_id, lot_id, lot_order, lot_number,
      lot_number_status, title, category_code, category_code_status, estimated_value, currency_id, is_eu_funded,
      ted_uid, ted_uid_status, cancelled_status, cancellation_at_status)
    values ('seap', ${pub}, ${lot}, ${order}, ${String(order)}, 'valid', ${title}, '45000000-7', 'valid', 1000,
      1, false, ${`LOT-${lot}`}, 'valid', 'not_cancelled', 'absent')`,
  sql`insert into procurement_v3.ca_contract_lots (source_name, publication_id, contract_id, lot_id,
      lot_order, lot_no, lot_no_status)
    values ('seap', ${pub}, ${contract}, ${lot}, ${order}, ${String(order)}, 'valid')`,
];

const namingSql = (code: string, naming: string, masked: string | null = null) =>
  sql`insert into procurement_v3.supplier_naming (fiscal_code_clean, lanes, in_onrc, naming, masked_name,
      name_source, policy_version, built_at)
    values (${code}, array['ca'], false, ${naming}, ${masked},
      ${naming === 'named' ? 'registry' : naming === 'masked' ? 'registry_masked' : null}, 'v1', now())`;

const load = async (db: Kysely<ProdDatabase>): Promise<void> => {
  await sql.raw(STUBS_DDL).execute(db);
  await sql.raw(CA_PLATFORM_TABLES).execute(db);
  await sql.raw(CA_NAMING_DDL).execute(db);
  await sql.raw(API_SIDE_DDL).execute(db);
  await sql.raw(CA_PUBLIC_VIEWS_DDL).execute(db);
  await sql.raw(GRANTS).execute(db);
  await sql`insert into procurement_v3.da_release values (${AS_OF}::timestamptz)`.execute(db);

  // Parties.
  await sql`insert into core.organizations values (1, ${BUYER}, ${BUYER_NAME}, null, 'public'),
    (2, ${PERSON_BUYER}, ${PERSON_REGISTRY_NAME}, null, 'public')`.execute(db);
  await sql`insert into procurement_v3.party_public_names values
    (${BUYER}, ${BUYER_NAME}, true, true),
    (${PERSON_BUYER}, ${PERSON_REGISTRY_NAME}, true, true)`.execute(db);
  await sql`insert into procurement_v3.supplier_privacy (fiscal_code_clean, supplier_kind, public, method)
    values (${GATE_WINNER}, 'company', true, 'test'), (${PERSON_BUYER}, 'sole_trader', false, 'test')`.execute(
    db
  );
  await sql`insert into procurement_v3.da_buyer_geography values (${BUYER}, '54975', 'CJ', 'Nord-Vest', now())`.execute(
    db
  );
  for (const statement of [
    namingSql(GATE_WINNER, 'named'),
    namingSql(MASKED_WINNER, 'masked', 'Io*** Po*****'),
    namingSql(WITHHELD_WINNER, 'withheld'),
    namingSql(NO_NAMES_ROW_WINNER, 'code_only'),
  ])
    await statement.execute(db);
  await sql`insert into procurement_v3.supplier_names_public values
    (${GATE_WINNER}, 'named', 'ALFA CONSTRUCT SRL', true),
    (${MASKED_WINNER}, 'masked', 'Io*** Po*****', true),
    (${WITHHELD_WINNER}, 'withheld', ${SECRET_WINNER_NAME}, false)`.execute(db);

  // Buyer's records: 1001 awarded 2025 (a change fact, two lots); 1002 a framework 2024 with a joint win;
  // 1003 under identity review 2023; 1004 before the floor (2019); 1005 undated; 1006 superseded;
  // 1007 a withheld, a no-names-row and an unidentified winner (2022).
  const facts: Fact[] = [
    { pub: '1001', contract: '1', amount: '1000.50', day: '2025-03-10', buyer: BUYER },
    {
      pub: '1001',
      contract: '1',
      valueKind: 'modification_change',
      amount: '120.00',
      day: '2025-03-10',
      buyer: BUYER,
      evidencePub: '1008',
    },
    {
      pub: '1002',
      contract: '1',
      kind: 'framework_agreement',
      amount: '5000.00',
      day: '2024-06-01',
      buyer: BUYER,
    },
    {
      pub: '1003',
      contract: '1',
      status: 'identity_review',
      amount: '300.00',
      day: '2023-01-05',
      buyer: BUYER,
    },
    { pub: '1004', contract: '1', amount: '77.00', day: '2019-05-05', buyer: BUYER },
    { pub: '1005', contract: '1', amount: '55.00', day: null, buyer: BUYER },
    {
      pub: '1006',
      contract: '1',
      status: 'superseded',
      amount: '66.00',
      day: '2025-01-01',
      buyer: BUYER,
    },
    { pub: '1007', contract: '1', amount: null, day: '2022-02-02', buyer: BUYER },
    // A person buyer's record.
    { pub: '2001', contract: '1', amount: '10.00', day: '2024-04-04', buyer: PERSON_BUYER },
    // Re-anchored: the identity's earliest appearance (900) is its key; 901 is current.
    {
      pub: '901',
      contract: '1',
      matchPub: '900',
      amount: '42.00',
      day: '2025-05-05',
      buyer: BUYER,
    },
  ];
  for (const fact of facts) await factSql(fact).execute(db);
  for (const [pub, title, day] of [
    ['1001', 'Lucrari de reabilitare', '2025-03-10'],
    ['1002', 'Acord-cadru furnituri', '2024-06-01'],
    ['1003', 'Servicii', '2023-01-05'],
    ['1004', 'Vechi', '2019-05-05'],
    ['1005', 'Fara data', null],
    ['1006', 'Inlocuit', '2025-01-01'],
    ['1007', 'Contact: ion@example.ro', '2022-02-02'],
    ['1008', 'Act aditional', '2025-09-09'],
    ['2001', 'Servicii PFA', '2024-04-04'],
    ['900', 'Prima aparitie', '2025-05-05'],
    ['901', 'Reanuntare', '2025-05-05'],
  ] as const)
    await publicationSql(pub, title, day).execute(db);
  for (const statement of [
    winnerSql('1001', '1', 'w1', 1, GATE_WINNER),
    winnerSql('1002', '1', 'w1', 1, GATE_WINNER),
    winnerSql('1002', '1', 'w2', 2, MASKED_WINNER),
    winnerSql('1003', '1', 'w1', 1, GATE_WINNER),
    winnerSql('1004', '1', 'w1', 1, GATE_WINNER),
    winnerSql('1005', '1', 'w1', 1, GATE_WINNER),
    winnerSql('1007', '1', 'w1', 1, WITHHELD_WINNER),
    winnerSql('1007', '1', 'w2', 2, NO_NAMES_ROW_WINNER),
    winnerSql('1007', '1', 'w3', 3, null),
    winnerSql('2001', '1', 'w1', 1, GATE_WINNER),
    winnerSql('901', '1', 'w1', 1, GATE_WINNER),
  ])
    await statement.execute(db);
  for (const statement of [
    ...lotSql('1001', '1', 'L1', 1, 'Lotul 1'),
    ...lotSql('1001', '1', 'L2', 2, 'Lotul 2'),
  ])
    await statement.execute(db);
  await sql`insert into procurement_v3.ca_contract_identity (source_name, publication_id, contract_id,
      contract_kind, match_id, match_status, match_method, identity_status, current_status, is_current,
      review_reasons, members, gap_to_predecessor, chain_history_incomplete, chain_order_unverified)
    values ('seap', '900', '1', 'plain_contract', 'ca:900:1', 'linked', 'anchor', 'eligible', 'superseded',
        false, '{}', 2, false, false, false),
      ('seap', '901', '1', 'plain_contract', 'ca:900:1', 'linked', 'anchor', 'eligible', 'eligible', true, '{}',
        2, false, false, false)`.execute(db);

  // Volume for the plan and timing checks: 20,000 records of one buyer, a winner and a lot each.
  await sql`
    insert into procurement_v3.ca_publications (source_name, publication_id, family, public_id, raw_item_ref,
      raw_item_key, source_url, notice_no_status, title, listing_status, publication_at_status, publication_day,
      chain_reference, procedure_id_status, category_code_status, list_value_status, list_view_agree,
      list_view_differences, buyer_fiscal_code_status, expected_rule_version, part_summary, list_payload_key)
    select 'seap', 'b' || g, 'ca', 'pub-b' || g, 100000 + g, 'raw-b' || g, 'https://e-licitatie.example/ca/b' || g,
      'valid', 'Titlu ' || g, 'listed', 'valid', date '2021-01-01' + (g % 2000), 'chain-b' || g, 'valid', 'valid',
      'valid', 'agree', '{}', 'valid', 'r1', '{}'::jsonb, 'payload-b' || g
    from generate_series(1, 20000) g`.execute(db);
  await sql`
    insert into procurement_v3.ca_money_facts (source_name, match_id, value_kind, contract_kind, current_status,
      head_status, current_publication_id, current_contract_id, evidence_publication_id, evidence_contract_id,
      native_amount, currency_id, reported_ron, amount_source, additive_ron, vat_basis, conclusion_day,
      publication_day, procedure_id, buyer_code, category_code, members, flag_page_value, flag_list_value,
      flag_foreign_lei_equivalent, flag_zero, flag_negative, flag_currency_unknown, flag_rate_unknown,
      flag_native_ron_disagrees, flag_unverified_head, flag_history_incomplete, flag_kind_unknown,
      flag_change_carried)
    select 'seap', 'ca:b' || g || ':1', 'awarded', 'plain_contract', 'eligible', 'named_head', 'b' || g, '1',
      'b' || g, '1', g * 10, 1, g * 10, 'view_ron', g * 10, 'unknown', date '2021-01-01' + (g % 2000),
      date '2021-01-01' + (g % 2000), 'P' || g, ${BIG_BUYER}, '45000000-7', 1, false, false, false, false, false,
      false, false, false, false, false, false, false
    from generate_series(1, 20000) g`.execute(db);
  await sql`
    insert into procurement_v3.ca_contract_winners (source_name, publication_id, contract_id, winner_key,
      page_order, view_order, view_code_clean, view_code_status, page_code_clean, page_code_status, link_status,
      party_eligible)
    select 'seap', 'b' || g, '1', 'w1', 1, 1, ${GATE_WINNER}, 'valid', ${GATE_WINNER}, 'valid', 'linked', true
    from generate_series(1, 20000) g`.execute(db);
  await sql`
    insert into procurement_v3.ca_contract_lots (source_name, publication_id, contract_id, lot_id, lot_order,
      lot_no, lot_no_status)
    select 'seap', 'b' || g, '1', 'L1', 1, '1', 'valid' from generate_series(1, 20000) g`.execute(
    db
  );
  await sql`analyze`.execute(db);
};

const connect = (uri: string): Kysely<ProdDatabase> =>
  new Kysely<ProdDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: uri, max: 2 }) }),
  });

const asRole = (role: string): string => {
  const uri = new URL(container?.getConnectionUri() ?? '');
  uri.username = role;
  uri.password = role;
  return uri.toString();
};

beforeAll(async () => {
  if (!dockerCliUp()) return;
  try {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('ca_views')
      .start();
  } catch (error) {
    console.warn(
      `Testcontainers runtime unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  dockerAvailable = true;
  owner = connect(container.getConnectionUri());
  await load(owner);
  api = connect(asRole('ca_api'));
  noGrant = connect(asRole('ca_nogrant'));
  noNames = connect(asRole('ca_nonames'));
  deps = { repo: makeCaRecordsRepo(api, true) };
}, 240_000);

afterAll(async () => {
  await api?.destroy();
  await noGrant?.destroy();
  await noNames?.destroy();
  await owner?.destroy();
  await container?.stop();
});

// ── Plans: the reader rule, measured on the real barrier views ──────────────

const COMPUTED_RELATIONS = [
  'ca_contract_winners',
  'ca_contract_lots',
  'supplier_privacy',
  'onrc_current_profiles',
  'organizations',
  'ca_lots',
  'supplier_naming',
];

/** A node of `explain (format json)`: its keys are PostgreSQL's ("Node Type", "Relation Name", "Plans"). */
type PlanNode = Readonly<Record<string, unknown>>;

interface PlanRelation {
  readonly relation: string;
  readonly type: string;
  /** The node's index or recheck condition, when it has one. */
  readonly condition: string;
  /** Under a SubPlan or InitPlan (a computed column's probe), not the statement's own read. */
  readonly inSubplan: boolean;
}

/** Every relation a plan reads, and a `subplan` entry for each SubPlan or InitPlan node. */
const relationsOf = (node: PlanNode, out: PlanRelation[] = [], underSubplan = false) => {
  const relation = node['Relation Name'];
  const type = node['Node Type'];
  const parent = node['Parent Relationship'];
  const inSubplan = underSubplan || parent === 'SubPlan' || parent === 'InitPlan';
  if (parent === 'SubPlan' || parent === 'InitPlan')
    out.push({ relation: 'subplan', type: parent, condition: '', inSubplan });
  if (typeof relation === 'string') {
    const condition = node['Index Cond'] ?? node['Recheck Cond'];
    out.push({
      relation,
      type: typeof type === 'string' ? type : '',
      condition: typeof condition === 'string' ? condition : '',
      inSubplan,
    });
  }
  const children = node['Plans'];
  if (Array.isArray(children))
    for (const child of children as PlanNode[]) relationsOf(child, out, inSubplan);
  return out;
};

const planOf = async (statement: RawBuilder<unknown>) => {
  if (api === undefined) throw new Error('no database');
  const compiled = statement.compile(api);
  // EXPLAIN with the statement's own parameters (as the API sends them).
  const raw = await api.executeQuery<Record<string, unknown>>(
    CompiledQuery.raw(`explain (format json) ${compiled.sql}`, [...compiled.parameters])
  );
  const document = raw.rows[0]?.['QUERY PLAN'];
  const plan = Array.isArray(document)
    ? (document[0] as { Plan?: PlanNode } | undefined)?.Plan
    : undefined;
  if (plan === undefined) throw new Error('no plan');
  return relationsOf(plan);
};

const WINDOW = { from: '2021-01-01', to: null };

describe('reader rule 1 on the real views', () => {
  it('a keys page reads no computed column, for every sort', async () => {
    for (const sort of ['awardDayDesc', 'awardDayAsc', 'amountDesc'] as const) {
      const relations = await planOf(
        buyerKeysSql({ buyerCode: BIG_BUYER, window: WINDOW, sort, offset: 0, limit: 20 })
      );
      const names = relations.map((r) => r.relation);
      // The facts once (a computed column's subquery would read them again) and no subplan.
      expect(names.filter((name) => name === 'ca_money_facts')).toHaveLength(1);
      expect(names).not.toContain('subplan');
      for (const relation of COMPUTED_RELATIONS) expect(names).not.toContain(relation);
    }
  });

  it('the counts read no computed column', async () => {
    const names = (await planOf(buyerCountsSql(BIG_BUYER, WINDOW))).map((r) => r.relation);
    expect(names.filter((name) => name === 'ca_money_facts')).toHaveLength(1);
    expect(names).not.toContain('subplan');
    for (const relation of COMPUTED_RELATIONS) expect(names).not.toContain(relation);
  });

  it('the plan check sees the slow shape (a computed column in the keys statement)', async () => {
    const relations = await planOf(sql`
      select r.source_name, r.match_id, r.winner_count from procurement_v3.ca_records_public r
      where r.buyer_code = ${BIG_BUYER} order by r.award_day desc limit 20`);
    expect(relations.map((r) => r.relation)).toContain('ca_contract_winners');
    // change_lei reads only ca_money_facts, so the check counts the facts and the subplans too.
    const change = (
      await planOf(sql`
      select r.source_name, r.match_id, r.change_lei from procurement_v3.ca_records_public r
      where r.buyer_code = ${BIG_BUYER} order by r.award_day desc limit 20`)
    ).map((r) => r.relation);
    expect(
      change.filter((name) => name === 'ca_money_facts').length > 1 || change.includes('subplan')
    ).toBe(true);
  });

  it('the rows step probes the facts by key, never a scan', async () => {
    const keys = Array.from({ length: 20 }, (_v, i) => `ca:b${String(i + 1)}:1`);
    const relations = await planOf(recordRowsSql('seap', keys));
    const facts = relations.filter((r) => r.relation === 'ca_money_facts');
    expect(facts.length).toBeGreaterThan(0);
    // Every read of the facts (the main row and each computed column's probe) is an index probe.
    for (const fact of facts) expect(fact.type).not.toBe('Seq Scan');
    // The statement's own read of the facts (not a computed column's probe) uses both key columns.
    const main = facts.filter((fact) => !fact.inSubplan);
    expect(main).toHaveLength(1);
    expect(main[0]?.condition).toContain('source_name');
    expect(main[0]?.condition).toContain('match_id');
  });

  it('serves a large buyer’s pages within bounds', async () => {
    for (const sort of ['awardDayDesc', 'amountDesc'] as const)
      for (const page of [1, 50]) {
        const started = performance.now();
        const answer = (
          await listCaBuyerRecords(deps, { buyerFiscalCode: BIG_BUYER, sort, page, pageSize: 50 })
        )._unsafeUnwrap();
        const elapsed = performance.now() - started;
        expect(answer.items).toHaveLength(50);
        expect(answer.total).toBe(20000);
        expect(answer.depthLimited).toBe(true);
        // Loose: the slow shape evaluates every record's subqueries (seconds at this volume).
        expect(elapsed).toBeLessThan(3000);
      }
    const ordered = (
      await listCaBuyerRecords(deps, {
        buyerFiscalCode: BIG_BUYER,
        sort: 'amountDesc',
        page: 1,
        pageSize: 3,
      })
    )._unsafeUnwrap();
    expect(ordered.items.map((item) => item.amountLei)).toEqual([
      '200000.00',
      '199990.00',
      '199980.00',
    ]);
  });
});

// ── Records ─────────────────────────────────────────────────────────────────

describe('a buyer’s contract awards', () => {
  it('counts dated records from 2021 only, undated ones apart', async () => {
    const summary = (await caBuyerSummary(deps, { buyerFiscalCode: BUYER }))._unsafeUnwrap();
    // 1001, 1002, 1003, 1007, 900 dated from 2021; 1004 (2019) out; 1005 undated; 1006 superseded.
    expect(summary).toMatchObject({
      recordCount: 5,
      valuedCount: 4,
      identityReviewCount: 1,
      undatedCount: 1,
      window: { floor: '2021-01-01', from: '2021-01-01', to: null },
      dataAsOf: AS_OF,
      disclosureKey: AS_OF,
      buyer: { fiscalCode: BUYER, displayKind: 'authority', name: BUYER_NAME },
    });
    // A window asked from 2019 starts at the floor.
    const early = (
      await caBuyerSummary(deps, { buyerFiscalCode: BUYER, from: '2019-01-01', to: '2024-12-31' })
    )._unsafeUnwrap();
    expect(early.window.from).toBe('2021-01-01');
    expect(early.recordCount).toBe(3);
  });

  it('lists newest first, by key, with winners named through the names view', async () => {
    const page = (
      await listCaBuyerRecords(deps, { buyerFiscalCode: BUYER, page: 1, pageSize: 20 })
    )._unsafeUnwrap();
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(false);
    expect(page.items.map((item) => item.recordId)).toEqual([
      'seap:ca:900:1',
      'seap:ca:1001:1',
      'seap:ca:1002:1',
      'seap:ca:1003:1',
      'seap:ca:1007:1',
    ]);
    const [anchored, award, framework, review, withheld] = page.items;
    expect(award).toMatchObject({
      valueKind: 'awarded',
      contractKind: 'ordinary',
      additive: true,
      amountLei: '1000.50',
      changeLei: '120.00',
      changePublicationDay: '2025-09-09',
      awardDay: '2025-03-10',
      lotCount: 2,
      winnerCount: 1,
      title: 'Lucrari de reabilitare',
      buyer: { displayKind: 'authority', name: BUYER_NAME, countyCode: 'CJ', siruta: '54975' },
      winners: [
        {
          displayKind: 'company',
          fiscalCode: GATE_WINNER,
          name: 'ALFA CONSTRUCT SRL',
          disclosed: true,
        },
      ],
    });
    expect(anchored?.title).toBe('Reanuntare');
    expect(framework).toMatchObject({
      valueKind: 'framework_ceiling',
      contractKind: 'framework_agreement',
      flags: ['joint_win'],
      winners: [
        { displayKind: 'company', fiscalCode: GATE_WINNER, disclosed: true },
        // Outside the gate: masked, never a registry name.
        {
          displayKind: 'person_masked',
          fiscalCode: MASKED_WINNER,
          name: 'Io*** Po*****',
          disclosed: false,
        },
      ],
    });
    expect(review).toMatchObject({ status: 'identity_review', additive: false });
    // A code the names view withholds, a code with no names row and no code: none shows a code.
    expect(withheld?.winners).toEqual([
      { order: 1, displayKind: 'withheld', fiscalCode: null, name: null, disclosed: null },
      { order: 2, displayKind: 'withheld', fiscalCode: null, name: null, disclosed: null },
      { order: 3, displayKind: 'unidentified', fiscalCode: null, name: null, disclosed: null },
    ]);
    // The free-text rule withholds a title with an e-mail address.
    expect(withheld?.title).toBeNull();
    const raw = JSON.stringify(page);
    expect(raw).not.toContain(WITHHELD_WINNER);
    expect(raw).not.toContain(NO_NAMES_ROW_WINNER);
    expect(raw).not.toContain(SECRET_WINNER_NAME);
  });

  it('says when a window holds more than a list reaches, and refuses a page beyond it', async () => {
    const small = (
      await listCaBuyerRecords(deps, { buyerFiscalCode: BUYER, page: 1, pageSize: 5 })
    )._unsafeUnwrap();
    expect(small.depthLimited).toBe(false);
    expect(
      (
        await listCaBuyerRecords(deps, { buyerFiscalCode: BIG_BUYER, page: 201, pageSize: 50 })
      )._unsafeUnwrapErr()
    ).toMatchObject({ type: 'InvalidInput', field: 'page' });
    // The last reachable page, and a narrowed window that reaches the rest.
    const last = (
      await listCaBuyerRecords(deps, { buyerFiscalCode: BIG_BUYER, page: 200, pageSize: 50 })
    )._unsafeUnwrap();
    expect(last.items).toHaveLength(50);
    expect(last.hasMore).toBe(false);
    const narrowed = (
      await listCaBuyerRecords(deps, {
        buyerFiscalCode: BIG_BUYER,
        from: '2021-01-01',
        to: '2021-12-31',
        page: 1,
        pageSize: 5,
      })
    )._unsafeUnwrap();
    expect(narrowed.depthLimited).toBe(false);
    expect(narrowed.total).toBeLessThan(10000);
  });

  it('pages and sorts on plain columns', async () => {
    const asc = (
      await listCaBuyerRecords(deps, {
        buyerFiscalCode: BUYER,
        sort: 'awardDayAsc',
        page: 2,
        pageSize: 2,
      })
    )._unsafeUnwrap();
    expect(asc.items.map((item) => item.recordId)).toEqual(['seap:ca:1002:1', 'seap:ca:1001:1']);
    expect(asc.hasMore).toBe(true);
    const bad = await listCaBuyerRecords(deps, { buyerFiscalCode: BUYER, page: 1, pageSize: 51 });
    expect(bad._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'pageSize' });
  });

  it('never names a person buyer by code', async () => {
    const summary = (await caBuyerSummary(deps, { buyerFiscalCode: PERSON_BUYER }))._unsafeUnwrap();
    expect(summary.buyer.displayKind).toBe('person_masked');
    expect(summary.buyer.name).not.toBeNull();
    expect(summary.buyer.name).toContain('*');
    const page = (
      await listCaBuyerRecords(deps, { buyerFiscalCode: PERSON_BUYER, page: 1, pageSize: 5 })
    )._unsafeUnwrap();
    expect(page.items[0]?.buyer).toMatchObject({
      displayKind: 'person_masked',
      name: summary.buyer.name,
    });
    const raw = JSON.stringify([summary, page]);
    expect(raw).not.toContain(PERSON_REGISTRY_NAME);
    expect(raw).not.toContain('POPESCU');
  });

  it('names no buyer it has no record for', async () => {
    const summary = (
      await caBuyerSummary(deps, { buyerFiscalCode: NO_RECORDS_BUYER })
    )._unsafeUnwrap();
    expect(summary).toMatchObject({
      recordCount: 0,
      undatedCount: 0,
      buyer: { displayKind: 'unknown', name: null },
    });
  });
});

describe('one contract award', () => {
  it('serves the record with its lots', async () => {
    const detail = (await getCaRecord(deps, 'seap:ca:1001:1'))._unsafeUnwrap();
    expect(detail.reanchored).toBe(false);
    expect(detail.record.recordId).toBe('seap:ca:1001:1');
    expect(detail.lots.map((lot) => [lot.lotOrder, lot.title])).toEqual([
      [1, 'Lotul 1'],
      [2, 'Lotul 2'],
    ]);
  });

  it('resolves an id from an earlier build through the keys view', async () => {
    const detail = (await getCaRecord(deps, 'seap:ca:901:1'))._unsafeUnwrap();
    expect(detail.reanchored).toBe(true);
    expect(detail.record.recordId).toBe('seap:ca:900:1');
  });

  it('refuses a record before the floor as outside the published window', async () => {
    const refused = (await getCaRecord(deps, 'seap:ca:1004:1'))._unsafeUnwrapErr();
    expect(refused).toMatchObject({ type: 'NotFound', resource: OUTSIDE_WINDOW_RESOURCE });
  });

  it('serves an undated record, and refuses absent, superseded and malformed ids', async () => {
    expect((await getCaRecord(deps, 'seap:ca:1005:1'))._unsafeUnwrap().record.awardDay).toBeNull();
    for (const id of ['seap:ca:1006:1', 'seap:ca:9999:1'])
      expect((await getCaRecord(deps, id))._unsafeUnwrapErr()).toMatchObject({
        type: 'NotFound',
        resource: 'contractAward',
      });
    for (const id of ['seap:1001:1', "seap:ca:1001:1' or 1=1", 'x'])
      expect((await getCaRecord(deps, id))._unsafeUnwrapErr()).toMatchObject({
        type: 'InvalidInput',
      });
  });
});

describe('refusals', () => {
  it('answers unavailable, with no query of the views, without the grant', async () => {
    if (noGrant === undefined) throw new Error('no database');
    const refusedDeps = { repo: makeCaRecordsRepo(noGrant, true) };
    expect(
      (await caBuyerSummary(refusedDeps, { buyerFiscalCode: BUYER }))._unsafeUnwrapErr()
    ).toMatchObject({ type: 'ServiceUnavailable' });
    expect((await getCaRecord(refusedDeps, 'seap:ca:1001:1'))._unsafeUnwrapErr().type).toBe(
      'ServiceUnavailable'
    );
  });

  it('shows no winner code without the names view', async () => {
    if (noNames === undefined) throw new Error('no database');
    const page = (
      await listCaBuyerRecords(
        { repo: makeCaRecordsRepo(noNames, true) },
        { buyerFiscalCode: BUYER, page: 1, pageSize: 20 }
      )
    )._unsafeUnwrap();
    expect(page.disclosureKey).toBe('unavailable');
    const winners = page.items.flatMap((item) => item.winners);
    expect(winners.length).toBeGreaterThan(0);
    for (const winner of winners) expect(winner.fiscalCode).toBeNull();
    expect(JSON.stringify(page)).not.toContain(GATE_WINNER);
    expect(JSON.stringify(page)).not.toContain(MASKED_WINNER);
  });

  it('answers unavailable when switched off', async () => {
    if (api === undefined) throw new Error('no database');
    const off = { repo: makeCaRecordsRepo(api, false) };
    expect((await caBuyerSummary(off, { buyerFiscalCode: BUYER }))._unsafeUnwrapErr().type).toBe(
      'ServiceUnavailable'
    );
  });

  it('the API login cannot read the base tables', async () => {
    if (api === undefined) throw new Error('no database');
    await expect(
      sql`select 1 from procurement_v3.ca_money_facts limit 1`.execute(api)
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('REST', () => {
  it('serves the same answers under /api/v1/procurement/contract-awards', async () => {
    const app = fastifyLib();
    await app.register(makeCaRecordsRestPlugin(deps), {
      prefix: '/api/v1/procurement/contract-awards',
    });
    try {
      const summary = await app.inject({
        url: `/api/v1/procurement/contract-awards/buyer-summary?buyerFiscalCode=${BUYER}`,
      });
      expect(summary.statusCode).toBe(200);
      expect(summary.headers['cache-control']).toBe('no-store');
      expect(summary.json()).toMatchObject({ ok: true, data: { recordCount: 5 } });
      const records = await app.inject({
        url: `/api/v1/procurement/contract-awards/records?buyerFiscalCode=${BUYER}&pageSize=2`,
      });
      expect(records.json()).toMatchObject({
        ok: true,
        meta: { page: { total: 5 }, hasMore: true },
      });
      const outside = await app.inject({
        url: '/api/v1/procurement/contract-awards/records/lookup?recordId=seap:ca:1004:1',
      });
      expect(outside.statusCode).toBe(404);
      expect(outside.json()).toMatchObject({ resource: OUTSIDE_WINDOW_RESOURCE });
      const unknown = await app.inject({
        url: `/api/v1/procurement/contract-awards/records?buyerFiscalCode=${BUYER}&winnerCount=2`,
      });
      expect(unknown.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('GraphQL', () => {
  it('serves the new root fields over the real views', async () => {
    const { typeDefs } = mergeGraphqlSlices(baseTypeDefs, [
      { source: 'procurement', typeDefs: caRecordsTypeDefs },
    ]);
    const app = fastifyLib({ logger: false });
    await app.register(
      makeGraphQLPlugin({
        schema: [typeDefs],
        resolvers: [{ ...scalarResolvers, ...makeCaRecordsResolvers(deps) }],
        isProduction: false,
        enableGraphiQL: false,
      })
    );
    await app.ready();
    const gql = async (query: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ query }),
      });
      return {
        body: res.json<{
          data?: Record<string, unknown> | null;
          errors?: { extensions?: Record<string, unknown> }[];
        }>(),
        cacheControl: res.headers['cache-control'],
      };
    };
    try {
      const summary =
        await gql(`{ procurementContractAwardSummary(buyerFiscalCode: "${BUYER}", from: "2019-01-01") {
        recordCount undatedCount window { floor from } buyer { displayKind name } } }`);
      // Every root is no-store, even with no winner selected.
      expect(summary.cacheControl).toBe('no-store');
      expect(summary.body.data).toEqual({
        procurementContractAwardSummary: {
          recordCount: 5,
          undatedCount: 1,
          window: { floor: '2021-01-01', from: '2021-01-01' },
          buyer: { displayKind: 'authority', name: BUYER_NAME },
        },
      });
      const page =
        await gql(`{ procurementContractAwards(buyerFiscalCode: "${BUYER}", sort: awardDayAsc, pageSize: 5) {
        total items { recordId awardDay flags winners { displayKind fiscalCode name disclosed } } } }`);
      expect(page.body.errors).toBeUndefined();
      // A named winner makes the answer never cacheable.
      expect(page.cacheControl).toBe('no-store');
      expect(JSON.stringify(page.body)).not.toContain(WITHHELD_WINNER);
      const outside = await gql(
        '{ procurementContractAward(recordId: "seap:ca:1004:1") { record { recordId } } }'
      );
      expect(outside.body.errors?.[0]?.extensions).toMatchObject({
        code: 'NOT_FOUND',
        reason: 'OUTSIDE_PUBLISHED_WINDOW',
      });
      const detail = await gql(
        '{ procurementContractAward(recordId: "seap:ca:901:1") { reanchored record { recordId lotCount } lots { lotOrder } } }'
      );
      expect(detail.cacheControl).toBe('no-store');
      const keysOnly = await gql(
        `{ procurementContractAwards(buyerFiscalCode: "${BUYER}", pageSize: 1) { total depthLimited } }`
      );
      expect(keysOnly.cacheControl).toBe('no-store');
      expect(keysOnly.body.data).toEqual({
        procurementContractAwards: { total: 5, depthLimited: false },
      });
      expect(detail.body.data).toEqual({
        procurementContractAward: {
          reanchored: true,
          record: { recordId: 'seap:ca:900:1', lotCount: 0 },
          lots: [],
        },
      });
    } finally {
      await app.close();
    }
  });
});
