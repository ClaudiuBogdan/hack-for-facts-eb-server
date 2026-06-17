/**
 * Judicial golden + tri-surface + RUNTIME leak audit against the live justice
 * schema. The justice.* tables are EMPTY on the serving DB (the 6.16M-case corpus
 * lives in the raw cluster), so this test SEEDS a deterministic, clearly-namespaced
 * fixture (institution_code 'TEST_JUD%', case_id in the 9_000_000_xxx range), runs
 * GraphQL + MCP through `buildRedesignApp()` + `inject()`, asserts the privacy
 * invariant holds end-to-end, and tears the fixture down in afterAll.
 *
 * The fixture plants a PERSON party, a COMPANY party (publishable), a PUBLIC party,
 * a company party with a DECLINED classifier rule, a published company-litigation
 * candidate whose `candidates` jsonb carries a planted person-name string, and a
 * legal-ref both as 'object' (served) and 'solution_summary' (must be excluded).
 *
 * Skips cleanly when PROD_DATABASE_URL is absent.
 */

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { loadRedesignConfig } from '@/infra/config/redesign-env.js';

import type { FastifyInstance } from 'fastify';

const HAS_DB = (process.env['PROD_DATABASE_URL'] ?? '').length > 0;
const d = HAS_DB ? describe : describe.skip;

// Fixture sentinels (namespaced so they never collide with a real load).
const COURT_TRIB = 'TEST_JUD_TRIB';
const COURT_JUD = 'TEST_JUD_JUDX';
const CASE_ID = '9000001001';
const NAME_KEY_COMPANY = '9000002001';
const NAME_KEY_PUBLIC = '9000002002';
const NAME_KEY_DECLINED = '9000002003';
const PLANTED_PERSON = 'IONESCU MARIA PERSOANA FIZICA';
const COMPANY_NAME = 'ACME TEST SRL';
const PUBLIC_NAME = 'PRIMARIA TEST';
const TEST_CUI = '99000001';

let app: FastifyInstance;
let close: () => Promise<void>;
let pool: Pool;

const onUncaught = (err: unknown): void => {
  if (err instanceof Error && err.message.includes('destroySoon')) return;
  throw err;
};

interface GqlResponse<T> {
  readonly data?: T;
  readonly errors?: readonly { readonly message: string }[];
}
interface JsonRpcResponse {
  readonly result?: { readonly structuredContent?: unknown; readonly content?: readonly { readonly text?: string }[] };
}

const gql = async <T>(query: string, variables?: Record<string, unknown>): Promise<GqlResponse<T>> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  return res.json();
};

const mcpCall = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body: JsonRpcResponse = res.json();
  if (body.result?.structuredContent !== undefined) return body.result.structuredContent as T;
  const text = body.result?.content?.[0]?.text;
  // eslint-disable-next-line no-restricted-syntax -- test parses the trusted MCP tool-output payload
  return (text !== undefined ? JSON.parse(text) : undefined) as T;
};

const seed = async (): Promise<void> => {
  // courts: a tribunal parent + a judecatorie child.
  await pool.query(
    `insert into justice.courts (institution_code, ordinal, court_level, specialization, locality, county_code, parent_institution_code, mapping_confidence)
     values ($1, 9001, 'tribunal', null, 'Test City', '01', null, 'high'),
            ($2, 9002, 'judecatorie', null, 'Test Town', '01', $1, 'high')
     on conflict (institution_code) do nothing`,
    [COURT_TRIB, COURT_JUD]
  );
  // a case under the judecatorie.
  await pool.query(
    `insert into justice.cases (case_id, source_slug, institution_code, case_number, category, category_name, stage, stage_name, object, source_opened_at, latest_source_modified_at, first_seen_at, last_seen_at)
     values ($1, 'portal_just', $2, '1/2024', 'civil', 'Civil', 'fond', 'Fond', 'pretenții comerciale', '2024-01-15', '2024-02-20', now(), now())
     on conflict (case_id) do nothing`,
    [CASE_ID, COURT_JUD]
  );
  // hearings (solution/solution_summary are written but MUST NOT surface).
  // row_hash is a loader-internal NOT NULL column the server never reads.
  await pool.query(
    `insert into justice.case_hearings (case_id, hearing_index, hearing_at, panel, solution, solution_summary, pronouncement_date, row_hash)
     values ($1, 0, '2024-02-01 10:00+00', 'C1', 'Admite', 'planted-sensitive-summary ${PLANTED_PERSON}', '2024-02-01', 'h0')
     on conflict do nothing`,
    [CASE_ID]
  );
  await pool.query(
    `insert into justice.case_appeals (case_id, appeal_index, appeal_declared_at, appeal_type, row_hash)
     values ($1, 0, '2024-03-01', 'apel', 'a0') on conflict do nothing`,
    [CASE_ID]
  );
  // dictionary: company + public publishable names (CHECK forbids person kinds).
  await pool.query(
    `insert into justice.party_name_keys (name_key_id, name_key, display_name, party_kind, legal_form, mention_count, classifier_version, normalizer_version)
     overriding system value
     values ($1, 'acme-test-srl', $4, 'company', 'SRL', 5, 'party-kind-v0', 'norm-v0'),
            ($2, 'primaria-test', $5, 'public_entity', null, 3, 'party-kind-v0', 'norm-v0'),
            ($3, 'declined-key', 'SHOULD NOT SURFACE', 'company', 'SRL', 1, 'party-kind-v0', 'norm-v0')
     on conflict (name_key_id) do nothing`,
    [NAME_KEY_COMPANY, NAME_KEY_PUBLIC, NAME_KEY_DECLINED, COMPANY_NAME, PUBLIC_NAME]
  );
  // parties: person (null key), company (publishable rule), public (publishable),
  // company w/ DECLINED rule (name must NOT surface), unknown.
  // row_hash/latest_response_id/parser_version are loader-internal NOT NULL columns.
  await pool.query(
    `insert into justice.case_parties (case_id, party_index, name_key_id, role_normalized, party_kind, classifier_version, classifier_rule, row_hash, latest_response_id, parser_version, first_seen_at, last_seen_at)
     values ($1, 0, null, 'parat', 'person', 'party-kind-v0', 'person_shape', 'p0', 1, 'parser-v0', now(), now()),
            ($1, 1, $2, 'reclamant', 'company', 'party-kind-v0', 'company_legal_form', 'p1', 1, 'parser-v0', now(), now()),
            ($1, 2, $3, 'intervenient', 'public_entity', 'party-kind-v0', 'public_entity_anchor', 'p2', 1, 'parser-v0', now(), now()),
            ($1, 3, $4, 'reclamant', 'company', 'party-kind-v0', 'fallback', 'p3', 1, 'parser-v0', now(), now()),
            ($1, 4, null, null, 'unknown', 'party-kind-v0', 'fallback', 'p4', 1, 'parser-v0', now(), now()),
            -- party 5: a PERSON sharing the publishable company's name_key (the P0-1 case).
            -- The dictionary gate WOULD resolve this key, but the per-row publishability
            -- (person + person_shape) must keep its name null. This is the centerpiece guard.
            ($1, 5, $2, 'parat', 'person', 'party-kind-v0', 'person_shape', 'p5', 1, 'parser-v0', now(), now())
     on conflict do nothing`,
    [CASE_ID, NAME_KEY_COMPANY, NAME_KEY_PUBLIC, NAME_KEY_DECLINED]
  );
  // a published company-litigation candidate whose `candidates` jsonb carries a
  // planted person name (test 6: it must surface NOWHERE).
  await pool.query(
    `insert into justice.party_company_candidates (candidate_id, name_key_id, candidate_cui, candidate_company_name, method, confidence_score, confidence_tier, validation_status, candidates, reviewed_by, resolver_version)
     overriding system value
     values ($1, $2, $3, $4, 'manual', 1.0, 'A', 'published', $5::jsonb, 'analyst-pii-name', 'resolver-v0')
     on conflict (candidate_id) do nothing`,
    [CASE_ID, NAME_KEY_COMPANY, TEST_CUI, COMPANY_NAME, JSON.stringify({ planted: PLANTED_PERSON })]
  );
  // legal refs: one 'object' (served) + one 'solution_summary' (must be excluded).
  await pool.query(
    `insert into justice.case_legal_references (case_legal_reference_id, case_id, source_field, raw_text, act_type, act_number, act_year, resolution_status, resolver_version)
     overriding system value
     values ($1, $2, 'object', 'art. 1 din legea 287/2009', 'lege', '287', 2009, 'unique', 'resolver-v0'),
            ($3, $2, 'solution_summary', 'forbidden span ${PLANTED_PERSON}', 'lege', '999', 2099, 'unique', 'resolver-v0')
     on conflict (case_legal_reference_id) do nothing`,
    [CASE_ID + '1', CASE_ID, CASE_ID + '2']
  );
};

const cleanup = async (): Promise<void> => {
  await pool.query('delete from justice.case_legal_references where case_id = $1::bigint', [CASE_ID]);
  await pool.query('delete from justice.party_company_candidates where candidate_id = $1::bigint', [CASE_ID]);
  await pool.query('delete from justice.case_parties where case_id = $1::bigint', [CASE_ID]);
  await pool.query('delete from justice.party_name_keys where name_key_id = any($1::bigint[])', [
    [NAME_KEY_COMPANY, NAME_KEY_PUBLIC, NAME_KEY_DECLINED],
  ]);
  await pool.query('delete from justice.case_appeals where case_id = $1::bigint', [CASE_ID]);
  await pool.query('delete from justice.case_hearings where case_id = $1::bigint', [CASE_ID]);
  await pool.query('delete from justice.cases where case_id = $1::bigint', [CASE_ID]);
  await pool.query('delete from justice.courts where institution_code = any($1)', [[COURT_TRIB, COURT_JUD]]);
};

/** Recursively assert a value's JSON contains neither the planted person name nor a forbidden key. */
const assertNoLeak = (value: unknown, where: string): void => {
  const json = JSON.stringify(value);
  expect(json, `${where} leaked the planted person name`).not.toContain(PLANTED_PERSON);
  expect(json, `${where} leaked the declined-key name`).not.toContain('SHOULD NOT SURFACE');
  expect(json, `${where} exposed a solutionSummary field`).not.toContain('solutionSummary');
  expect(json, `${where} exposed analyst PII`).not.toContain('analyst-pii-name');
};

d('Judicial golden + tri-surface + runtime leak audit (seeded fixture)', () => {
  beforeAll(async () => {
    const connectionString = (process.env['PROD_DATABASE_URL'] ?? '').replace(/[?&]sslmode=[a-z-]+/iu, '');
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
    await cleanup(); // idempotent: clear any leftover from a crashed run
    await seed();
    const built = await buildRedesignApp({
      kernelConfig: loadRedesignConfig(process.env).kernel,
      logLevel: 'silent',
      // legal owns the LegalAct base type judicial's `targetAct` references; in
      // production both are always merged (plan §11). Boot both here.
      modules: ['legal', 'judicial'],
    });
    app = built.app;
    close = built.app.close.bind(built.app);
    await app.ready();
    process.on('uncaughtException', onUncaught);
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await close?.();
    await pool?.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('uncaughtException', onUncaught);
  });

  it('court tree (GraphQL): tribunal exposes its judecatorie child', async () => {
    const res = await gql<{ judicialCourt: { institutionCode: string; courtLevel: string; children: { institutionCode: string }[] } | null }>(
      `{ judicialCourt(institutionCode:"${COURT_TRIB}") { institutionCode courtLevel children { institutionCode courtLevel } } }`
    );
    expect(res.errors).toBeUndefined();
    const court = res.data?.judicialCourt;
    expect(court?.courtLevel).toBe('tribunal');
    expect(court?.children.map((c) => c.institutionCode)).toContain(COURT_JUD);
  });

  it('case detail (GraphQL): person/unknown name null, company/public name gated, declined key null, NO solution*', async () => {
    const res = await gql<{
      judicialCase: {
        case: { caseNumber: string };
        hearings: { hearingIndex: number; panel: string | null }[];
        parties: { partyKind: string; name: string | null; nameKeyId: string | null }[];
        personPartyCount: number;
        legalReferences: { citation: string; actNumber: string | null }[];
      } | null;
    }>(
      `{ judicialCase(caseId:"${CASE_ID}") {
          case { caseNumber }
          hearings { hearingIndex panel }
          parties { partyKind name nameKeyId }
          personPartyCount
          legalReferences { citation actNumber }
        } }`
    );
    expect(res.errors).toBeUndefined();
    const detail = res.data?.judicialCase;
    expect(detail).toBeTruthy();
    assertNoLeak(detail, 'judicialCase GraphQL');

    const unknown = detail!.parties.find((p) => p.partyKind === 'unknown');
    const publicEntity = detail!.parties.find((p) => p.partyKind === 'public_entity');
    const declinedCompany = detail!.parties.find((p) => p.nameKeyId === NAME_KEY_DECLINED);
    // the publishable company party is the COMPANY-kind row carrying NAME_KEY_COMPANY.
    const publishableCompany = detail!.parties.find(
      (p) => p.partyKind === 'company' && p.nameKeyId === NAME_KEY_COMPANY
    );
    // THE P0-1 CASE: a person row that SHARES the publishable company's name_key.
    const personSharingCompanyKey = detail!.parties.find(
      (p) => p.partyKind === 'person' && p.nameKeyId === NAME_KEY_COMPANY
    );

    expect(unknown?.name).toBeNull();
    expect(publishableCompany?.name).toBe(COMPANY_NAME); // gated publishable
    expect(publicEntity?.name).toBe(PUBLIC_NAME);
    // the DECLINED-rule company party (nameKeyId set, but rule 'fallback') → name null.
    expect(declinedCompany?.name).toBeNull();
    // CENTERPIECE: a person sharing the company's name_key must NOT inherit the name.
    expect(personSharingCompanyKey).toBeTruthy();
    expect(personSharingCompanyKey?.name).toBeNull();
    // every person/unknown party is name-free.
    for (const p of detail!.parties) {
      if (p.partyKind === 'person' || p.partyKind === 'unknown') expect(p.name).toBeNull();
    }
    expect(detail!.personPartyCount).toBe(3); // 2 person + 1 unknown

    // legal refs: only the 'object' citation surfaces; the 'solution_summary' row is excluded.
    expect(detail!.legalReferences.map((r) => r.actNumber)).toContain('287');
    expect(detail!.legalReferences.map((r) => r.actNumber)).not.toContain('999');
  });

  it('company litigation (GraphQL): the published fixture link surfaces the GATED company name (never candidate_company_name path)', async () => {
    const res = await gql<{ judicialCompanyLitigation: { cui: string; caseCount: number; companyName: string | null } }>(
      `{ judicialCompanyLitigation(cui:"${TEST_CUI}") { cui caseCount companyName coverage } }`
    );
    expect(res.errors).toBeUndefined();
    const s = res.data?.judicialCompanyLitigation;
    expect(s?.caseCount).toBe(1);
    expect(s?.companyName).toBe(COMPANY_NAME); // sourced from the gated dictionary
    assertNoLeak(s, 'judicialCompanyLitigation GraphQL');
  });

  it('MCP get_judicial_case ≡ GraphQL (tri-surface) + NO leak', async () => {
    const out = await mcpCall<{ ok: boolean; item: { personPartyCount: number; parties: { partyKind: string; name: string | null }[] } }>(
      'get_judicial_case',
      { caseId: CASE_ID }
    );
    expect(out.ok).toBe(true);
    expect(out.item.personPartyCount).toBe(3);
    const company = out.item.parties.find((p) => p.partyKind === 'company' && p.name === COMPANY_NAME);
    expect(company).toBeTruthy();
    // no person/unknown party carries a name on the MCP surface either.
    for (const p of out.item.parties) {
      if (p.partyKind === 'person' || p.partyKind === 'unknown') expect(p.name).toBeNull();
    }
    assertNoLeak(out, 'get_judicial_case MCP');
  });

  it('MCP get_court_caseload (JD-2): grouped counts; requires a bound', async () => {
    const out = await mcpCall<{ ok: boolean; item: { denominator: number } }>('get_court_caseload', {
      groupBy: 'courtLevel',
      institutionCode: [COURT_JUD],
    });
    expect(out.ok).toBe(true);
    expect(out.item.denominator).toBe(1);
  });

  it('resolve companyName resolves the dictionary (gated), a person name returns empty (S1)', async () => {
    const company = await mcpCall<{ ok: boolean; items: { value: string; label: string }[] }>('resolve_judicial_filters', {
      dim: 'companyName',
      q: 'ACME TEST',
    });
    expect(company.items.some((h) => h.label === COMPANY_NAME)).toBe(true);
    assertNoLeak(company, 'resolve companyName');

    const person = await mcpCall<{ ok: boolean; items: unknown[] }>('resolve_judicial_filters', {
      dim: 'companyName',
      q: 'IONESCU MARIA',
    });
    expect(person.items).toHaveLength(0); // dictionary holds no persons
  });

  it('unbounded case list is rejected (no court/period bound)', async () => {
    const res = await gql<{ judicialCases: unknown }>(`{ judicialCases { edges { node { caseId } } } }`);
    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/court or period bound/u);
  });
});
