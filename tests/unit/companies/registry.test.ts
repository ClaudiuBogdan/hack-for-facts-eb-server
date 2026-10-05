/**
 * Companies unit tests — the ONRC registry scope contract (core/registry.ts)
 * and its transports, over in-memory fakes (no DB):
 *  - pin once, recheck fresh, retry once, then ServiceUnavailable;
 *  - a returned CUI whose organization turned private fails the recheck;
 *  - continuations (cursor / MCP page) bound to the scope they started under;
 *  - lazy fields reuse the parent's scope and never re-pin;
 *  - the edition's identifier normalization, CUI namespace and exact CAEN
 *    selector; basis-qualified scalars; attributed compatibility labels;
 *  - repo mapping of a profile under each registry state (scripted driver):
 *    conflicts stay explicit, no legacy fallback, fiscal/financial intact.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from 'kysely';
import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  compatStatus,
  displayName,
  isOnrcQualifiedCui,
  onrcIdentifierKey,
  parseOnrcCaenSelector,
  registryScopeKey,
  runPinned,
  scopeStillHolds,
  singleIdentifierKey,
  type CompanyRegistryEnvelope,
} from '@/modules/companies/core/registry.js';
import {
  makeCompanyList,
  makeCompanyProfileData,
  makeCompanyRegistrationDiff,
  makeCompanyRegistry,
} from '@/modules/companies/core/usecases.js';
import { makeCompaniesContributor } from '@/modules/companies/shell/contributor.js';
import { makeCompaniesResolvers } from '@/modules/companies/shell/graphql/resolvers.js';
import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';
import { basisValue, profileFromRow } from '@/modules/companies/shell/repo/registry-sql.js';

import {
  MOVED_SCOPE,
  NEXT_EDITION_SCOPE,
  PUBLISHED_SCOPE,
  UNAVAILABLE_SCOPE,
  UNPUBLISHED_SCOPE,
  WITHDRAWN_SCOPE,
  recheckOf,
} from './registry-fixtures.js';
import { stubFlows, stubRepo } from './repo-fixtures.js';

import type { CompaniesRepository } from '@/modules/companies/core/ports.js';
import type { CompanyRegistryEvidence } from '@/modules/companies/core/types.js';
import type { ContributorRegistry, ProdDatabase } from '@/modules/shared/index.js';

/** A repo whose captures and rechecks follow scripted sequences. */
const sequencedRepo = (
  captures: readonly CompanyRegistryEnvelope[],
  rechecks: readonly (CompanyRegistryEnvelope | { privateCuis: string[] })[],
  over: Partial<CompaniesRepository> = {}
) => {
  let c = 0;
  let r = 0;
  const captureRegistryScope = vi.fn(async () => {
    const scope = captures[Math.min(c, captures.length - 1)] ?? PUBLISHED_SCOPE;
    c += 1;
    return ok(scope);
  });
  const confirmRegistryScope = vi.fn(async (scope: CompanyRegistryEnvelope) => {
    const next = rechecks[Math.min(r, rechecks.length - 1)];
    r += 1;
    if (next !== undefined && 'privateCuis' in next) return ok(recheckOf(scope, next.privateCuis));
    return ok(recheckOf(next ?? scope));
  });
  return {
    repo: stubRepo({ captureRegistryScope, confirmRegistryScope, ...over }),
    captureRegistryScope,
    confirmRegistryScope,
  };
};

describe('runPinned: pin once, recheck fresh, retry once', () => {
  it('returns the value with the scope it was read under when the recheck holds', async () => {
    const { repo, captureRegistryScope } = sequencedRepo([PUBLISHED_SCOPE], [PUBLISHED_SCOPE]);
    const read = vi.fn(async () => ok(['2816464']));
    const res = await runPinned(repo, read, (v) => v);
    expect(res._unsafeUnwrap()).toEqual({ value: ['2816464'], scope: PUBLISHED_SCOPE });
    expect(captureRegistryScope).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(PUBLISHED_SCOPE);
  });

  it('a publication between read and recheck re-pins and re-reads under the NEW scope', async () => {
    const { repo, captureRegistryScope } = sequencedRepo(
      [PUBLISHED_SCOPE, NEXT_EDITION_SCOPE],
      [NEXT_EDITION_SCOPE, NEXT_EDITION_SCOPE]
    );
    const read = vi.fn(async (scope: CompanyRegistryEnvelope) => ok(scope.editionId));
    const res = await runPinned(repo, read, () => []);
    expect(res._unsafeUnwrap()).toEqual({ value: '8', scope: NEXT_EDITION_SCOPE });
    expect(captureRegistryScope).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.map(([s]) => s.editionId)).toEqual(['7', '8']);
  });

  it('a scope moving twice is ServiceUnavailable (never a mixed answer)', async () => {
    const { repo } = sequencedRepo(
      [PUBLISHED_SCOPE, NEXT_EDITION_SCOPE],
      [MOVED_SCOPE, { ...NEXT_EDITION_SCOPE, accessEpoch: '99' }]
    );
    const res = await runPinned(
      repo,
      async () => ok(1),
      () => []
    );
    expect(res.isErr() && res.error.type).toBe('ServiceUnavailable');
  });

  it.each([
    ['publication epoch', { ...PUBLISHED_SCOPE, publicationEpoch: '4' }],
    ['access epoch', { ...PUBLISHED_SCOPE, accessEpoch: '12' }],
    ['edition', NEXT_EDITION_SCOPE],
    ['state (withdrawn)', WITHDRAWN_SCOPE],
  ])('any %s move fails the recheck', (_name, current) => {
    expect(scopeStillHolds(PUBLISHED_SCOPE, recheckOf(current))).toBe(false);
    expect(scopeStillHolds(PUBLISHED_SCOPE, recheckOf(null))).toBe(false);
  });

  it('a returned CUI whose organization is now private fails the recheck, also when ONRC is unavailable', async () => {
    expect(scopeStillHolds(PUBLISHED_SCOPE, recheckOf(PUBLISHED_SCOPE, ['2816464']))).toBe(false);
    expect(scopeStillHolds(UNAVAILABLE_SCOPE, recheckOf(null, ['2816464']))).toBe(false);
    expect(scopeStillHolds(UNAVAILABLE_SCOPE, recheckOf(null, []))).toBe(true);
    const { repo, confirmRegistryScope } = sequencedRepo(
      [PUBLISHED_SCOPE],
      [{ privateCuis: ['2816464'] }, { privateCuis: ['2816464'] }]
    );
    const res = await runPinned(
      repo,
      async () => ok(['2816464']),
      (v) => v
    );
    expect(res.isErr() && res.error.type).toBe('ServiceUnavailable');
    expect(confirmRegistryScope).toHaveBeenCalledWith(PUBLISHED_SCOPE, ['2816464']);
  });

  it('a continuation bound to another scope is refused with restart, never switched', async () => {
    const { repo } = sequencedRepo([NEXT_EDITION_SCOPE], [NEXT_EDITION_SCOPE]);
    const read = vi.fn(async () => ok(1));
    const res = await runPinned(repo, read, () => [], {
      expectedKey: registryScopeKey(PUBLISHED_SCOPE),
    });
    expect(res.isErr() && res.error).toMatchObject({ type: 'InvalidInput', field: 'cursor' });
    expect(read).not.toHaveBeenCalled();
  });

  it('a lazy read under the parent scope never re-pins: a moved scope is an error', async () => {
    const { repo, captureRegistryScope } = sequencedRepo([NEXT_EDITION_SCOPE], [MOVED_SCOPE]);
    const res = await runPinned(
      repo,
      async () => ok(1),
      () => [],
      { scope: PUBLISHED_SCOPE }
    );
    expect(res.isErr() && res.error.type).toBe('ServiceUnavailable');
    expect(captureRegistryScope).not.toHaveBeenCalled();
  });

  it('the scope key changes with every state, edition and epoch', () => {
    const keys = [
      PUBLISHED_SCOPE,
      MOVED_SCOPE,
      NEXT_EDITION_SCOPE,
      { ...PUBLISHED_SCOPE, accessEpoch: '12' },
      UNPUBLISHED_SCOPE,
      WITHDRAWN_SCOPE,
      UNAVAILABLE_SCOPE,
    ].map(registryScopeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(registryScopeKey(PUBLISHED_SCOPE)).toBe('onrc:published:7:3:11');
  });
});

describe('the edition input contract', () => {
  it('normalizes identifiers exactly like the edition: the 25 white-space code points out, upper-cased', () => {
    const nbsp = String.fromCodePoint(0xa0);
    const lineSeparator = String.fromCodePoint(0x2028);
    const bom = String.fromCodePoint(0xfeff);
    expect(onrcIdentifierKey(` j40 /${nbsp}123 / 2000${lineSeparator}${bom}`)).toBe('J40/123/2000');
    expect(onrcIdentifierKey('\t\n ')).toBeNull();
    // No format inference: separators and digits stay as given.
    expect(onrcIdentifierKey('J40-123-2000')).toBe('J40-123-2000');
    expect(onrcIdentifierKey('j40/123/2000')).toBe(onrcIdentifierKey('J40/123/2000'));
  });

  it('the qualified CUI namespace: 2-10 digits, no leading zero; held one-digit tokens never link', () => {
    for (const cui of ['1', '4', '01234567', '12345678901'])
      expect(isOnrcQualifiedCui(cui)).toBe(false);
    for (const cui of ['12', '2816464', '1234567890']) expect(isOnrcQualifiedCui(cui)).toBe(true);
  });

  it('the exact CAEN selector accepts rev0..rev3 with a 4-digit code only', () => {
    expect(parseOnrcCaenSelector('rev0:1111')).toEqual({ revision: 'rev0', code: '1111' });
    expect(parseOnrcCaenSelector(' rev3:6201 ')).toEqual({ revision: 'rev3', code: '6201' });
    for (const raw of [
      'rev4:6201',
      'rev2:620',
      'rev2:62011',
      '6201',
      'caen_rev2:6201',
      'unknown:6201',
    ]) {
      expect(parseOnrcCaenSelector(raw)).toBeNull();
    }
  });

  it('refuses a malformed onrcCaen filter value with InvalidInput (published scope)', async () => {
    const repo = makeCompaniesRepo(new Kysely<ProdDatabase>({ dialect: dummyDialect() }));
    const res = await repo.listCompanies(
      { onrcCaen: { eq: '6201' } },
      'name',
      { page: 1, pageSize: 10 },
      PUBLISHED_SCOPE
    );
    expect(res.isErr() && res.error).toMatchObject({ type: 'InvalidInput', field: 'onrcCaen' });
  });
});

describe('qualified scalars and attributed labels', () => {
  it('a basis that admits no value never carries one (a stray value is dropped)', () => {
    expect(basisValue('1048', 'multiple_values')).toEqual({
      value: null,
      basis: 'multiple_values',
    });
    expect(basisValue('1048', 'unresolved')).toEqual({ value: null, basis: 'unresolved' });
    expect(basisValue('SRL', 'partial_observations')).toEqual({
      value: 'SRL',
      basis: 'partial_observations',
    });
    // An unknown vocabulary value fails closed.
    expect(basisValue('1048', 'priority_pick')).toEqual({ value: null, basis: 'unresolved' });
  });

  it('no profile column means no profile (fail closed)', () => {
    expect(profileFromRow({} as never)).toBeNull();
  });

  it('compatibility status labels are attributed (API nomenclature or the code), never observed', () => {
    expect(compatStatus('1048')).toEqual({
      code: '1048',
      label: 'funcțiune',
      labelSource: 'api_nomenclature',
    });
    expect(compatStatus('9999')).toEqual({ code: '9999', label: '9999', labelSource: 'code' });
  });

  it('the display name is the qualified edition name, else the attributed directory name', () => {
    expect(displayName('CORE SRL', null)).toEqual({
      name: 'CORE SRL',
      nameSource: 'core_organization',
    });
  });

  it('codInmatriculare only for exactly one resolved identifier and nothing unresolved', () => {
    const evidence = (identifiers: number, unresolved: number, keys: string[]) =>
      ({
        profile: { identifierCount: identifiers, unresolvedIdentifierCount: unresolved },
        identifiers: keys.map((identifierKey) => ({ identifierKey })),
      }) as unknown as CompanyRegistryEvidence;
    expect(singleIdentifierKey(evidence(1, 0, ['J40/1/2000']))).toBe('J40/1/2000');
    expect(singleIdentifierKey(evidence(2, 0, ['J40/1/2000', 'J40/2/2001']))).toBeNull();
    expect(singleIdentifierKey(evidence(2, 1, ['J40/1/2000']))).toBeNull();
  });
});

// ── repo mapping over a scripted driver ───────────────────────────────────────

class ScriptedDriver extends DummyDriver {
  constructor(private readonly rowsFor: (sql: string) => readonly unknown[]) {
    super();
  }

  override acquireConnection(): Promise<DatabaseConnection> {
    const rowsFor = this.rowsFor;
    return Promise.resolve({
      executeQuery: (query) => Promise.resolve({ rows: [...rowsFor(query.sql)] as never[] }),
      streamQuery: async function* () {
        // never streamed
      },
    });
  }
}

const dummyDialect = (rowsFor: (sql: string) => readonly unknown[] = () => []) => ({
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => new ScriptedDriver(rowsFor),
  createIntrospector: (db: Kysely<unknown>) => new PostgresIntrospector(db),
  createQueryCompiler: () => new PostgresQueryCompiler(),
});

/** One CUI with a conflicting status (1048 + 1070 on one identifier), as the views return it. */
const conflictRows = (sql: string, statements: string[]): readonly unknown[] => {
  statements.push(sql);
  if (sql.includes('from "core"."organizations"')) {
    return [{ org_id: '1', cui: '2816464', name: 'CORE NAME' }];
  }
  if (sql.includes('"companies_v2"."fiscal_status" as "f"')) {
    return [
      {
        is_vat_payer: true,
        is_inactive: false,
        main_caen_code: '4752',
        main_caen_rev: '',
        main_caen_label: null,
        registered_name: null,
        status_date: '2026-06-15',
      },
    ];
  }
  if (sql.includes('from companies_v2.onrc_published_profiles p')) {
    return [
      {
        p_cui: '2816464',
        p_identity_observations: 2,
        p_identifier_count: 1,
        p_unresolved_identifier_count: 0,
        p_unidentified_observations: 0,
        p_name: 'DEDEMAN SRL',
        p_name_basis: 'consistent_observations',
        p_legal_form: 'SRL',
        p_legal_form_basis: 'single_observation',
        p_recorded_date: '1992-11-05',
        p_recorded_date_basis: 'single_observation',
        p_county_code: 'BC',
        p_county_basis: 'single_observation',
        p_county_name: 'BACĂU',
        p_uat_siruta_code: null,
        p_uat_basis: 'missing',
        p_uat_name: null,
        p_status_code: null,
        p_status_basis: 'multiple_values',
        p_caen_coverage: 'complete',
        p_status_coverage: 'complete',
        p_legal_person_eligibility: 'eligible',
        p_eligibility_reason: null,
        p_eligibility_policy_version: 'public-legal-person-v1',
      },
    ];
  }
  if (sql.includes('from companies_v2.onrc_published_identifier_profiles i')) {
    return [
      {
        identifier_key: 'J04/2621/1992',
        identity_row_count: 1,
        status_codes: ['1070', '1048'],
        has_active_observation: true,
        status_summary_code: '1070',
        status_summary_basis: 'priority_summary',
        status_observations: 2,
        unparsed_status_observations: 0,
        county_codes: ['BC'],
        county_basis: 'single_observation',
        caen_observations: 1,
        unparsed_caen_observations: 0,
        unknown_revision_caen_observations: 0,
      },
    ];
  }
  if (sql.includes('from companies_v2.onrc_published_status_observations s')) {
    return ['1048', '1070'].map((code, i) => ({
      identifier_key: 'J04/2621/1992',
      status_parse_state: 'code',
      status_code: code,
      status_label: null,
      status_label_source: null,
      source_row_number: i + 1,
      resource_key: 'OD_STARE_FIRMA',
      source_row_sha256: 'e'.repeat(64),
      source_url: 'https://data.gov.ro/stare.csv',
      source_file_sha256: 'f'.repeat(64),
      source_published_at: '2026-07-08',
    }));
  }
  return [];
};

describe('profile mapping under each registry state (scripted driver)', () => {
  it('published: conflicts stay explicit; no priority-picked status; recorded date; envelope', async () => {
    const statements: string[] = [];
    const db = new Kysely<ProdDatabase>({
      dialect: dummyDialect((sql) => conflictRows(sql, statements)),
    });
    const profile = (
      await makeCompaniesRepo(db).getProfileData('2816464', PUBLISHED_SCOPE)
    )._unsafeUnwrap();
    expect(profile?.registry.cuiState).toBe('in_edition');
    expect(profile?.name).toBe('DEDEMAN SRL');
    expect(profile?.nameSource).toBe('onrc_edition');
    // multiple_values: no CUI status, even though the identifier SUMMARY says 1070.
    expect(profile?.headlineStatus).toBeNull();
    expect(profile?.statusFlags.map((f) => f.code)).toEqual(['1048', '1070']);
    expect(profile?.registry.identifiers[0]?.hasActiveObservation).toBe(true);
    expect(profile?.registry.identifiers[0]?.statusCodes).toEqual(['1048', '1070']);
    expect(profile?.registrationDate).toBe('1992-11-05');
    expect(profile?.codInmatriculare).toBe('J04/2621/1992');
    expect(profile?.territory).toEqual({
      sirutaCode: null,
      uatName: null,
      countyName: 'Bacău',
      matchConfidence: 'unmatched',
    });
    expect(profile?.asOf).toEqual({ onrc: '2026-07-08', anaf: '2026-06-15' });
    // ANAF stays its own fact: never merged into an ONRC activity state.
    expect(profile?.fiscal?.declaredFiscallyInactive).toBe(false);
    expect(profile?.euBranches).toEqual([]);
    // Dates are read as civil text; provenance-only columns; no tokens or addresses.
    const all = statements.join('\n');
    expect(all).toContain('recorded_date::text');
    expect(all).not.toMatch(/_token|address_|manifest ->|match_method|object_uri/u);
  });

  it.each([UNPUBLISHED_SCOPE, WITHDRAWN_SCOPE, UNAVAILABLE_SCOPE])(
    '$state: the registry state only — no ONRC value, no legacy fallback, fiscal and financials intact',
    async (scope) => {
      const statements: string[] = [];
      const db = new Kysely<ProdDatabase>({
        dialect: dummyDialect((sql) => conflictRows(sql, statements)),
      });
      const profile = (
        await makeCompaniesRepo(db).getProfileData('2816464', scope)
      )._unsafeUnwrap();
      expect(profile?.registry.cuiState).toBe(scope.state);
      expect(profile?.name).toBe('CORE NAME');
      expect(profile?.nameSource).toBe('core_organization');
      expect(profile?.legalForm).toBeNull();
      expect(profile?.headlineStatus).toBeNull();
      expect(profile?.registrationDate).toBeNull();
      expect(profile?.codInmatriculare).toBeNull();
      expect(profile?.territory).toBeNull();
      expect(profile?.asOf.onrc).toBeNull();
      expect(profile?.fiscal?.vatPayer).toBe(true);
      const all = statements.join('\n');
      expect(all).not.toMatch(
        /onrc_|registrations|registration_history|status_flags|caen_profile|eu_branches/u
      );
      expect(all).toContain('"companies_v2"."financials" as "fin"');
    }
  );
});

describe('transports carry and bind the scope', () => {
  it('companies cursors bind the scope: a page under a moved scope is refused (restart)', async () => {
    const { repo } = sequencedRepo([PUBLISHED_SCOPE, MOVED_SCOPE], [PUBLISHED_SCOPE, MOVED_SCOPE], {
      listCompanies: vi.fn(async () =>
        ok({
          rows: Array.from({ length: 2 }, (_, i) => ({
            cui: String(100 + i),
            orgId: String(i),
            name: 'X',
            nameSource: 'core_organization' as const,
            legalForm: null,
            headlineStatus: null,
            county: null,
            vatPayer: null,
            declaredFiscallyInactive: null,
            registrationDate: null,
            registrationDatePresent: false,
            registryCuiState: 'not_in_edition' as const,
            hasActiveObservation: null,
            statusBasis: null,
            countyBasis: null,
            recordedDateBasis: null,
          })),
          total: 50,
          estimated: false,
        })
      ),
    });
    const resolvers = makeCompaniesResolvers({
      repo,
      flowsRepo: stubFlows(),
      meili: null,
      registry: {} as ContributorRegistry,
      hubStats: { get: vi.fn() },
    }) as { Query: Record<string, (r: unknown, a: Record<string, unknown>) => Promise<unknown>> };
    const page1 = (await resolvers.Query['companies']?.(null, { first: 2 })) as {
      pageInfo: { endCursor: string };
      registry: CompanyRegistryEnvelope;
    };
    expect(page1.registry).toBe(PUBLISHED_SCOPE);
    await expect(
      resolvers.Query['companies']?.(null, { first: 2, after: page1.pageInfo.endCursor })
    ).rejects.toMatchObject({ extensions: { code: 'INVALID_INPUT' } });
  });

  it('a pre-cutover cursor (no scope key) is refused, never served under a new scope', async () => {
    const { repo } = sequencedRepo([PUBLISHED_SCOPE], [PUBLISHED_SCOPE]);
    const resolvers = makeCompaniesResolvers({
      repo,
      flowsRepo: stubFlows(),
      meili: null,
      registry: {} as ContributorRegistry,
      hubStats: { get: vi.fn() },
    }) as { Query: Record<string, (r: unknown, a: Record<string, unknown>) => Promise<unknown>> };
    const { buildNextCursor, fhashFor } = await import('@/modules/shared/index.js');
    const { companiesFilterSpec } = await import('@/modules/companies/core/filters.js');
    const legacy = buildNextCursor({
      sort: 'name',
      dir: 'asc',
      fhash: fhashFor(companiesFilterSpec, {}),
      lastKeys: ['1'],
    });
    await expect(resolvers.Query['companies']?.(null, { after: legacy })).rejects.toMatchObject({
      extensions: { code: 'INVALID_INPUT' },
    });
  });

  it('the lazy registrationDiff runs under the PARENT scope and is refused if it moved', async () => {
    const getRegistrationDiffData = vi.fn(async (_cui: string, scope: CompanyRegistryEnvelope) =>
      ok({ registry: scope, later: null, earlier: null })
    );
    const { repo, captureRegistryScope } = sequencedRepo([NEXT_EDITION_SCOPE], [MOVED_SCOPE], {
      getRegistrationDiffData,
    });
    const res = await makeCompanyRegistrationDiff({ repo }, '2816464', PUBLISHED_SCOPE);
    expect(res.isErr() && res.error.type).toBe('ServiceUnavailable');
    expect(getRegistrationDiffData).toHaveBeenCalledWith('2816464', PUBLISHED_SCOPE);
    expect(captureRegistryScope).not.toHaveBeenCalled();
  });

  it('the list echoes its scope for empty pages too (not an unscoped empty)', async () => {
    const { repo } = sequencedRepo([WITHDRAWN_SCOPE], [WITHDRAWN_SCOPE]);
    const res = (
      await makeCompanyList(
        { repo, flowsRepo: stubFlows(), meili: null },
        { filter: {}, sort: 'name', page: { page: 1, pageSize: 10 } }
      )
    )._unsafeUnwrap();
    expect(res.rows).toEqual([]);
    expect(res.registry.state).toBe('withdrawn');
    expect(res.scopeKey).toBe(registryScopeKey(WITHDRAWN_SCOPE));
  });

  it('the registry capabilities read is fresh and reports the edition-bound filters and revisions', async () => {
    const { repo, captureRegistryScope } = sequencedRepo([PUBLISHED_SCOPE], [PUBLISHED_SCOPE]);
    const caps = (await makeCompanyRegistry({ repo }))._unsafeUnwrap();
    expect(caps.scopeKey).toBe('onrc:published:7:3:11');
    expect(caps.registryFilterFields).toContain('onrcCaen');
    expect(caps.caenRevisions).toEqual(['rev0', 'rev1', 'rev2', 'rev3']);
    await makeCompanyRegistry({ repo });
    expect(captureRegistryScope).toHaveBeenCalledTimes(2); // never cached
  });

  it('the contributor never states an ONRC status without consensus and names the registry state', async () => {
    const { repo } = sequencedRepo([UNPUBLISHED_SCOPE], [UNPUBLISHED_SCOPE], {
      profileSlicesForCuis: vi.fn(async () =>
        ok(
          new Map([
            [
              '2816464',
              {
                cui: '2816464',
                name: 'CORE NAME',
                nameSource: 'core_organization' as const,
                legalForm: null,
                headlineStatus: null,
                vatPayer: true,
                declaredFiscallyInactive: false,
                registrationDate: null,
                registrationDatePresent: false,
                territory: null,
                latestFinancial: null,
                registryCuiState: 'unpublished' as const,
                registry: UNPUBLISHED_SCOPE,
                asOf: { onrc: null, anaf: null },
              },
            ],
          ])
        )
      ),
    });
    const slice = (await makeCompaniesContributor(repo).profileSlice?.('2816464'))?._unsafeUnwrap();
    expect(slice?.summary).toBe(
      'CORE NAME (directory name), ONRC registry: unpublished, VAT payer.'
    );
    expect(slice?.summary).not.toMatch(/status/u);
  });

  it('a profile pins once for its own fan-out', async () => {
    const { repo, captureRegistryScope, confirmRegistryScope } = sequencedRepo(
      [PUBLISHED_SCOPE],
      [PUBLISHED_SCOPE],
      { getProfileData: vi.fn(async () => ok(null)) }
    );
    await makeCompanyProfileData({ repo }, '2816464');
    expect(captureRegistryScope).toHaveBeenCalledTimes(1);
    expect(confirmRegistryScope).toHaveBeenCalledTimes(1);
  });
});
