import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql } from 'graphql';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  getNgoFinancialStatements,
  getNgoOrganizationProfile,
  type NgoOrganizationRepository,
} from '@/modules/ngos/core/organization.js';
import {
  makeNgoOrganizationResolvers,
  ngoOrganizationTypeDefs,
} from '@/modules/ngos/shell/graphql/organization-schema.js';
import { ngoProfileTypeDefs } from '@/modules/ngos/shell/graphql/profile-schema.js';
import { ngoRegistryTypeDefs } from '@/modules/ngos/shell/graphql/schema.js';
import { makeNgoOrganizationMcpTools } from '@/modules/ngos/shell/mcp/organization-tools.js';
import {
  makeNgoOrganizationRepo,
  mapOrganizationProfile,
} from '@/modules/ngos/shell/repo/organization-repo.js';
import { mapPublicRegistryRecord } from '@/modules/ngos/shell/repo/registry-repo.js';

import type {
  NgoFinancialStatement,
  NgoOrganizationProfile,
} from '@/modules/ngos/core/organization-types.js';
import type { NgoOrganizationProfileRow } from '@/modules/ngos/shell/db/organization-rows.js';
import type { NgoPublicRecordRow } from '@/modules/ngos/shell/db/schema.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

const CUI = '4305857';
const RECORD_ID = 'mj_rnong:snapshot:row:10';

const recordRow: NgoPublicRecordRow = {
  legal_record_id: RECORD_ID,
  source_snapshot_id: 'snapshot',
  source_row_number: 10,
  registry_number: '1/A/2001',
  special_registry_number: null,
  source_registration_date: '2001-02-03',
  entity_kind: 'association',
  legal_form: 'Asociație',
  organization_name: 'ASOCIAȚIA EXEMPLU',
  normalized_name: 'asociatia_exemplu',
  name_withheld: false,
  court_name: 'Judecătoria Exemplu',
  source_registry_status: 'Source status',
  county: 'Cluj',
  locality: 'Cluj-Napoca',
  source_cui: null,
  // Legacy semantics: registry-declared links only, so an inferred identity leaves this null.
  linked_organization_cui: null,
  is_branch: false,
  source_reports_public_utility: null,
  source_declared_snapshot_date: null,
  loaded_at: '2026-09-20 00:00:00+00',
  captured_at: '2026-09-20 00:00:00+00',
  refresh_overdue: false,
  accepted_at: '2026-09-20 01:00:00+00',
  snapshot_row_count: 141330,
  is_current: true,
  source_url: 'https://rnong.just.ro/registru-ong',
  coverage_basis: 'provided_artifact',
  national_completeness: 'unverified',
  privacy_class: 'public',
};

/** An inferred identity whose frozen ANAF registration stays admitted after the fiscal pin moved. */
const profileRow = (
  overrides: Partial<NgoOrganizationProfileRow> = {}
): NgoOrganizationProfileRow => ({
  organization_key: 'registry:1/A/2001',
  source_snapshot_id: 'snapshot',
  registry_number: '1/A/2001',
  registry_number_valid: true,
  observation_count: 1,
  legal_record_ids: [RECORD_ID],
  organization_name: 'ASOCIAȚIA EXEMPLU',
  name_withheld: false,
  entity_kind: 'association',
  legal_form: 'Asociație',
  special_registry_number: null,
  court_names: ['Judecătoria Exemplu'],
  source_registration_date: '2001-02-03',
  source_registry_status: null,
  county: 'Cluj',
  locality: 'Cluj-Napoca',
  is_branch: false,
  source_reports_public_utility: null,
  source_cui: null,
  organization_cui: CUI,
  identity_method: 'fiscal_exact_name_county',
  court_differs: false,
  name_differs: false,
  category_differs: false,
  status_differs: true,
  county_differs: false,
  locality_differs: false,
  source_cui_differs: false,
  identity_differs: false,
  cui_conflict: false,
  purpose_availability: 'not_released',
  anaf_registration_availability: 'available',
  anaf_reference: `anaf:tva:2026-09-25:${CUI}`,
  anaf_status_date: '2026-09-25',
  anaf_retrieved_at: '2026-09-25 10:00:00+00',
  anaf_registration_state_text: 'INREGISTRAT',
  anaf_registration_state: 'registered',
  anaf_registration_state_date: '2003-01-01',
  anaf_registration_date: '2003-01-01',
  anaf_legal_form: 'ASOCIATIE',
  anaf_organization_form: 'PERSOANA JURIDICA FARA SCOP PATRIMONIAL',
  anaf_fiscal_office: 'AJFP Cluj',
  anaf_is_inactive: false,
  anaf_inactivated_on: null,
  anaf_reactivated_on: null,
  anaf_inactive_register_removed_on: null,
  fiscal_availability: 'not_loaded',
  fiscal_is_inactive: null,
  fiscal_is_vat_payer: null,
  fiscal_main_caen_code: null,
  fiscal_status_date: null,
  fiscal_retrieved_at: null,
  fiscal_source_snapshot_id: null,
  financials_availability: 'available',
  financial_years: [2025, 2012, 2024],
  ...overrides,
});

const records = [mapPublicRegistryRecord(recordRow)];
const profile = mapOrganizationProfile(CUI, profileRow(), records)._unsafeUnwrap();

const statement: NgoFinancialStatement = {
  fiscalYear: 2025,
  sourceUrl: 'https://data.gov.ro/situatii_financiare_2025.csv',
  dictionaryUrl: 'https://data.gov.ro/dictionar_2025.csv',
  sourceRowNumber: 17,
  capturedAt: '2026-09-28T04:26:52.000Z',
  indicators: [
    { code: 'I1', label: 'Venituri totale', value: '123456789012345678901' },
    { code: 'I2', label: 'Cheltuieli totale', value: '0' },
    { code: 'I3', label: 'Stocuri', value: null },
  ],
};

const fakeRepo = (value: NgoOrganizationProfile | null = profile) => {
  const statementCalls: (readonly number[] | null)[] = [];
  let profileCalls = 0;
  const repo: NgoOrganizationRepository = {
    profile: () => {
      profileCalls += 1;
      return Promise.resolve(ok(value));
    },
    financialStatements: (_cui, years) => {
      statementCalls.push(years);
      return Promise.resolve(ok([statement]));
    },
  };
  return { repo, statementCalls, profileCalls: () => profileCalls };
};

const schemaFor = (repo: NgoOrganizationRepository) =>
  makeExecutableSchema({
    typeDefs:
      'scalar Date\nscalar DateTime\nscalar CUI\ntype PageInfo { hasNextPage: Boolean! endCursor: String }\ntype Query { ping: String }\n' +
      ngoRegistryTypeDefs +
      ngoProfileTypeDefs +
      ngoOrganizationTypeDefs,
    resolvers: makeNgoOrganizationResolvers(repo),
  });

const tool = (repo: NgoOrganizationRepository) => {
  const found = makeNgoOrganizationMcpTools(repo, 'https://transparenta.eu').find(
    (candidate) => candidate.name === 'get_ngo_organization_profile'
  );
  if (found === undefined) throw new Error('tool missing');
  return found;
};

describe('NGO organization profile mapping', () => {
  it('keeps an inferred identity distinct from registry declarations and sections independent', () => {
    expect(profile.identity).toEqual({ cui: CUI, method: 'fiscal_exact_name_county' });
    expect(profile.sourceCui).toBeNull();
    expect(profile.registryRecords[0]?.linkedOrganizationCui).toBeNull();
    // Frozen bridge-pinned registration remains while the current fiscal observation is not admitted.
    expect(profile.anafRegistration).toMatchObject({
      availability: 'available',
      data: {
        sourceSnapshotId: `anaf:tva:2026-09-25:${CUI}`,
        queryDate: '2026-09-25',
        capturedAt: '2026-09-25T10:00:00.000Z',
        documentationUrl: 'https://static.anaf.ro/static/10/Anaf/Informatii_R/servicii_web.html',
      },
    });
    expect(profile.fiscal).toEqual({ availability: 'not_loaded', data: null });
    expect(profile.purpose).toEqual({ availability: 'not_released' });
    expect(profile.financials).toEqual({
      availability: 'available',
      fiscalYears: [2012, 2024, 2025],
    });
    expect(profile.conflicts).toEqual(['status']);
    expect(profile.snapshot.id).toBe('snapshot');
  });

  it('never carries office, purpose, custody or hash values even if a row contains them', () => {
    const leakyRow = {
      ...profileRow(),
      office_street: 'Strada Privată',
      office_street_number: '7',
      office_postal_code: '400001',
      purpose_text: 'Scop nepublicat',
      anaf_custody_kind: 'archive',
      identity_anaf_reference: 'anaf:tva:private',
      raw_line_sha256: 'a'.repeat(64),
      object_key: 'raw/ngos/secret.json',
    };
    const mapped = mapOrganizationProfile(CUI, leakyRow, records)._unsafeUnwrap();
    const serialized = JSON.stringify(mapped);
    for (const secret of [
      'Strada Privată',
      '400001',
      'Scop nepublicat',
      'archive',
      'anaf:tva:private',
      'a'.repeat(64),
      'raw/ngos',
    ])
      expect(serialized).not.toContain(secret);
  });

  it.each([
    ['an unknown identity method', { identity_method: 'name_similarity' }],
    ['a different organization CUI', { organization_cui: '999' }],
    ['no organization CUI', { organization_cui: null }],
    ['a withheld registry name', { name_withheld: true }],
    ['released purpose (no public text contract)', { purpose_availability: 'available' }],
    ['an unknown section state', { anaf_registration_availability: 'not_linked' }],
    ['registration without provenance', { anaf_reference: null }],
    [
      'fiscal data without provenance',
      { fiscal_availability: 'available', fiscal_source_snapshot_id: null },
    ],
    ['available financials without years', { financial_years: [] }],
    ['missing financials with years', { financials_availability: 'not_loaded' }],
    ['an incomplete observation set', { legal_record_ids: [RECORD_ID, 'other-row'] }],
  ])('fails closed on %s', (_label, overrides) => {
    const result = mapOrganizationProfile(CUI, profileRow(overrides), records);
    expect(result.isErr() && result.error.type).toBe('Database');
  });
});

describe('NGO organization usecases', () => {
  it('rejects malformed CUIs and year lists before repository access', async () => {
    const { repo, statementCalls, profileCalls } = fakeRepo();
    for (const cui of ['', 'RO4305857', '04305857', '12345678901'])
      expect((await getNgoOrganizationProfile(repo, cui)).isErr()).toBe(true);
    for (const years of [
      [],
      [2024, 2024],
      [2024.5],
      [1800],
      Array.from({ length: 21 }, (_, i) => 2000 + i),
    ])
      expect((await getNgoFinancialStatements(repo, CUI, years)).isErr()).toBe(true);
    expect(profileCalls()).toBe(0);
    expect(statementCalls).toHaveLength(0);
  });
});

describe('NGO organization GraphQL and MCP', () => {
  const query = `{
    ngoOrganizationProfile(cui: "${CUI}") {
      identity { cui method }
      sourceCui
      purpose { availability }
      fiscal { availability data { sourceSnapshotId } }
      anafRegistration { availability data { sourceSnapshotId documentationUrl } }
      financials { availability fiscalYears statements(fiscalYears: [2025]) { fiscalYear sourceUrl dictionaryUrl indicators { code label value } } }
      registryRecords { id linkedOrganizationCui }
    }
  }`;

  it('returns the same profile and statements through GraphQL and MCP', async () => {
    const gqlRepo = fakeRepo();
    const result = await graphql({ schema: schemaFor(gqlRepo.repo), source: query });
    expect(result.errors).toBeUndefined();
    const gql = result.data?.['ngoOrganizationProfile'] as Record<string, unknown>;
    expect(gql['identity']).toEqual({ cui: CUI, method: 'fiscal_exact_name_county' });
    expect(gql['purpose']).toEqual({ availability: 'not_released' });
    expect(gql['financials']).toEqual({
      availability: 'available',
      fiscalYears: [2012, 2024, 2025],
      statements: [
        {
          fiscalYear: 2025,
          sourceUrl: statement.sourceUrl,
          dictionaryUrl: statement.dictionaryUrl,
          indicators: statement.indicators,
        },
      ],
    });
    expect(gqlRepo.statementCalls).toEqual([[2025]]);

    const mcpRepo = fakeRepo();
    const mcp = await tool(mcpRepo.repo).handler({ cui: CUI, financialYears: [2025] });
    // The client CUI page still renders the legacy overview, so the link opens the observation.
    expect(mcp).toMatchObject({
      ok: true,
      link: `https://transparenta.eu/ong-uri/registru/${encodeURIComponent(RECORD_ID)}`,
    });
    expect(mcp.item).toEqual({
      ...profile,
      financials: { ...profile.financials, statements: [statement] },
    });
    expect(mcpRepo.statementCalls).toEqual([[2025]]);
  });

  it('does not fetch statements unless requested and available', async () => {
    const plain = fakeRepo();
    const mcp = await tool(plain.repo).handler({ cui: CUI });
    expect(mcp.item).toEqual(profile);
    expect(plain.statementCalls).toHaveLength(0);

    const notLoaded = mapOrganizationProfile(
      CUI,
      profileRow({ financials_availability: 'not_loaded', financial_years: [] }),
      records
    )._unsafeUnwrap();
    const empty = fakeRepo(notLoaded);
    const gql = await graphql({ schema: schemaFor(empty.repo), source: query });
    expect(gql.errors).toBeUndefined();
    const gqlProfile = gql.data?.['ngoOrganizationProfile'] as { financials: unknown };
    expect(gqlProfile.financials).toEqual({
      availability: 'not_loaded',
      fiscalYears: [],
      statements: [],
    });
    const mcpEmpty = await tool(empty.repo).handler({ cui: CUI, financialYears: [2025] });
    expect((mcpEmpty.item as { financials: unknown }).financials).toEqual({
      availability: 'not_loaded',
      fiscalYears: [],
      statements: [],
    });
    expect(empty.statementCalls).toHaveLength(0);
  });

  it('rejects invalid year lists even when financials are not loaded or no profile exists', async () => {
    const notLoaded = mapOrganizationProfile(
      CUI,
      profileRow({ financials_availability: 'not_loaded', financial_years: [] }),
      records
    )._unsafeUnwrap();
    for (const years of ['[]', '[2024, 2024]', '[1800]']) {
      const gqlRepo = fakeRepo(notLoaded);
      const result = await graphql({
        schema: schemaFor(gqlRepo.repo),
        source: `{ ngoOrganizationProfile(cui: "${CUI}") { financials { statements(fiscalYears: ${years}) { fiscalYear } } } }`,
      });
      expect(result.errors?.[0]?.extensions?.['code']).toBe('INVALID_INPUT');
      expect(gqlRepo.statementCalls).toHaveLength(0);
    }
    for (const financialYears of [[], [2024, 2024], [1800], [2022, 2023, 2024, 2025], ['2024']]) {
      for (const value of [null, notLoaded]) {
        const mcpRepo = fakeRepo(value);
        expect(await tool(mcpRepo.repo).handler({ cui: CUI, financialYears })).toMatchObject({
          ok: false,
          errorType: 'InvalidInput',
        });
        // A malformed request does no work: neither the profile nor the statements are read.
        expect(mcpRepo.profileCalls()).toBe(0);
        expect(mcpRepo.statementCalls).toHaveLength(0);
      }
    }
  });

  it('distinguishes no eligible profile from read failures', async () => {
    const missing = fakeRepo(null);
    const gql = await graphql({ schema: schemaFor(missing.repo), source: query });
    expect(gql.errors).toBeUndefined();
    expect(gql.data?.['ngoOrganizationProfile']).toBeNull();
    expect(await tool(missing.repo).handler({ cui: CUI })).toMatchObject({
      ok: true,
      item: null,
      link: 'https://transparenta.eu/ong-uri/registru',
    });

    const failing: NgoOrganizationRepository = {
      profile: () => Promise.resolve(err({ type: 'Database', message: 'failed' })),
      financialStatements: () => Promise.resolve(ok([])),
    };
    const failed = await graphql({ schema: schemaFor(failing), source: query });
    expect(failed.errors?.[0]?.extensions?.['code']).toBe('INTERNAL_SERVER_ERROR');
    expect(await tool(failing).handler({ cui: CUI })).toMatchObject({
      ok: false,
      errorType: 'Database',
    });
  });

  it('exposes no private fields in the public schema', async () => {
    const schema = schemaFor(fakeRepo().repo);
    for (const selection of [
      'purpose { text }',
      'anafRegistration { data { officeStreet } }',
      'anafRegistration { data { custodyKind } }',
      'financials { statements { rawLineSha256 } }',
      'financials { statements { objectKey } }',
      'financials { statements { indicators { normalizedName } } }',
      'purposeText',
      'officeCounty',
    ]) {
      const result = await graphql({
        schema,
        source: `{ ngoOrganizationProfile(cui: "${CUI}") { ${selection} } }`,
      });
      expect(result.errors?.length).toBeGreaterThan(0);
    }
  });
});

describe('NGO organization repository', () => {
  const scripted = (respond: (sql: string) => unknown[] | Error) => {
    const executed: string[] = [];
    class ScriptedDriver extends DummyDriver {
      override acquireConnection() {
        return Promise.resolve({
          executeQuery: (query: CompiledQuery) => {
            executed.push(query.sql);
            const response = respond(query.sql);
            return response instanceof Error
              ? Promise.reject(response)
              : Promise.resolve({ rows: response as never[] });
          },
          streamQuery: () => {
            throw new Error('unused');
          },
        });
      }
    }
    const db = new Kysely<ProdDatabase>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new ScriptedDriver(),
        createIntrospector: (d) => new PostgresIntrospector(d),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    return { db, executed };
  };
  const pgError = (code: string) => Object.assign(new Error(code), { code });

  it('issues no SQL while the capability flag is off', async () => {
    const { db, executed } = scripted(() => []);
    const repo = makeNgoOrganizationRepo(db, false);
    for (const result of [await repo.profile(CUI), await repo.financialStatements(CUI, null)])
      expect(result.isErr() && result.error.type).toBe('InvalidInput');
    expect(executed).toHaveLength(0);
  });

  it.each([
    ['42883', 'InvalidInput'],
    ['42P01', 'InvalidInput'],
    ['57014', 'Timeout'],
    ['42501', 'Database'],
  ])('maps data-layer error %s to %s', async (code, type) => {
    const { db } = scripted((sql) => (sql.includes('ngo.public_') ? pgError(code) : []));
    const repo = makeNgoOrganizationRepo(db, true);
    for (const result of [await repo.profile(CUI), await repo.financialStatements(CUI, [2025])])
      expect(result.isErr() && result.error.type).toBe(type);
  });

  it('reads the eligible organization with its complete public observations', async () => {
    const { db } = scripted((sql) =>
      sql.includes('ngo.public_organization_profile')
        ? [profileRow()]
        : sql.includes('rnong_public_records')
          ? [recordRow]
          : []
    );
    const result = await makeNgoOrganizationRepo(db, true).profile(CUI);
    expect(result._unsafeUnwrap()).toEqual(profile);

    const none = scripted(() => []);
    expect((await makeNgoOrganizationRepo(none.db, true).profile(CUI))._unsafeUnwrap()).toBeNull();

    const twice = scripted((sql) =>
      sql.includes('ngo.public_organization_profile') ? [profileRow(), profileRow()] : [recordRow]
    );
    const ambiguous = await makeNgoOrganizationRepo(twice.db, true).profile(CUI);
    expect(ambiguous.isErr() && ambiguous.error.type).toBe('Database');
  });
});
