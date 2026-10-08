/**
 * Companies — the global search's company contribution (api-repair-08).
 *
 *  - `companySearchValues`: the contract §2 values of one public company
 *    parent, hand-declared literals (activity true / false / unknown,
 *    attributed name, personal-shaped identifiers withheld);
 *  - `makeCompanySearchContribution`: bounded input, ONE pinned scope per
 *    hydration, the recheck of what would be served (a CUI turning private
 *    re-pins once), the final `confirm` over a scope key this API issued;
 *  - `makeCompanySearchReader` over a scripted driver: the parent class of
 *    every CUI (any kind; a NULL class fails closed), values only from the
 *    pinned edition's public views, never a current view or legacy table;
 *  - REGNUM resolution keeps its own checked path (no palette read).
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
  REGISTRY_CAPABILITY_LOST_MESSAGE,
  REGISTRY_MOVED_MESSAGE,
  type CompanyRegistryCuiProfile,
  type CompanyRegistryScopePort,
} from '@/modules/companies/core/registry.js';
import {
  companySearchValues,
  makeCompanySearchContribution,
  type CompanySearchReadPort,
} from '@/modules/companies/core/search-contribution.js';
import { makeCompanyResolve } from '@/modules/companies/core/usecases.js';
import { makeCompanySearchReader } from '@/modules/companies/shell/repo/search-contribution-sql.js';
import {
  confirmGlobalSearchServed,
  makeGlobalSearch,
  type GlobalSearchDeps,
} from '@/modules/shared/core/usecases/global-search.js';

import { MOVED_SCOPE, PUBLISHED_SCOPE, UNPUBLISHED_SCOPE, recheckOf } from './registry-fixtures.js';
import { stubFlows, stubRepo } from './repo-fixtures.js';

import type {
  MeiliClient,
  ProdDatabase,
  SearchCuiParent,
  SearchHit,
} from '@/modules/shared/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Values
// ─────────────────────────────────────────────────────────────────────────────

const PROFILE: CompanyRegistryCuiProfile = {
  identityObservations: 2,
  identifierCount: 1,
  unresolvedIdentifierCount: 0,
  unidentifiedObservations: 0,
  name: { value: 'ACME  ROMANIA SRL', basis: 'single_observation' },
  legalForm: { value: 'SRL', basis: 'single_observation' },
  recordedDate: { value: '2010-05-17', basis: 'single_observation' },
  countyCode: { value: 'CJ', basis: 'single_observation' },
  countyName: 'Cluj',
  uatSirutaCode: { value: '54975', basis: 'single_observation' },
  uatName: 'Cluj-Napoca',
  statusCode: { value: '1048', basis: 'single_observation' },
  caenCoverage: 'complete',
  statusCoverage: 'complete',
  legalPersonEligibility: 'eligible',
  eligibilityReason: null,
  eligibilityPolicyVersion: 'public-legal-person-v1',
};

describe('companySearchValues (contract §2, literal)', () => {
  it('an edition profile with a public 1048: in edition, qualified name, active', () => {
    expect(
      companySearchValues({
        coreName: 'ACME SRL',
        profile: PROFILE,
        hasActiveObservation: true,
        identifiers: ['J12/345/2010', 'RO12345678901', 'ROONRC.J12/345/2010', '12345678901'],
      })
    ).toEqual({
      registryState: 'in_edition',
      name: 'ACME  ROMANIA SRL',
      nameSource: 'onrc_edition',
      legalForm: 'SRL',
      countyCode: 'CJ',
      countyName: 'Cluj',
      active: true,
      // Personal-shaped values are withheld.
      identifiers: ['J12/345/2010', 'ROONRC.J12/345/2010'],
    });
  });

  it('no 1048: inactive only with complete status coverage, else unknown', () => {
    const base = { coreName: 'ACME SRL', hasActiveObservation: false, identifiers: [] };
    expect(companySearchValues({ ...base, profile: PROFILE }).active).toBe(false);
    for (const statusCoverage of ['complete_empty', 'partial', 'unresolved'] as const) {
      expect(companySearchValues({ ...base, profile: { ...PROFILE, statusCoverage } }).active).toBe(
        null
      );
    }
  });

  it('a core-only company is not_in_edition with the attributed core name and nothing else', () => {
    expect(
      companySearchValues({
        coreName: 'CORE ONLY SRL',
        profile: null,
        hasActiveObservation: false,
        identifiers: [],
      })
    ).toEqual({
      registryState: 'not_in_edition',
      name: 'CORE ONLY SRL',
      nameSource: 'core_organization',
      legalForm: null,
      countyCode: null,
      countyName: null,
      active: null,
      identifiers: [],
    });
  });

  it('a profile without a qualified name keeps the core name, attributed as such', () => {
    const values = companySearchValues({
      coreName: 'ACME SRL',
      profile: { ...PROFILE, name: { value: null, basis: 'multiple_values' } },
      hasActiveObservation: false,
      identifiers: [],
    });
    expect([values.registryState, values.name, values.nameSource]).toEqual([
      'in_edition',
      'ACME SRL',
      'core_organization',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────────────

const ACME = companySearchValues({
  coreName: 'ACME SRL',
  profile: PROFILE,
  hasActiveObservation: true,
  identifiers: ['J12/345/2010'],
});

const fakeReader = (answers: readonly ReadonlyMap<string, SearchCuiParent>[]) => {
  const calls: { cuis: readonly string[]; scopeKey: string | null; withValues: boolean }[] = [];
  const reader: CompanySearchReadPort = {
    readSearchCompanies: async (cuis, scope, withValues) => {
      calls.push({ cuis: [...cuis], scopeKey: scope.editionId, withValues });
      return ok(answers[Math.min(calls.length - 1, answers.length - 1)] ?? new Map());
    },
  };
  return { reader, calls };
};

describe('makeCompanySearchContribution', () => {
  it('pins one scope, reads the page and rechecks exactly what would be served', async () => {
    const repo = stubRepo();
    const { reader, calls } = fakeReader([
      new Map<string, SearchCuiParent>([
        ['123', { kind: 'company', values: ACME }],
        ['456', { kind: 'private' }],
        ['789', { kind: 'none' }],
      ]),
    ]);
    const port = makeCompanySearchContribution(repo, reader);
    const res = (await port.hydrate(['123', '456', '789', '123'], true))._unsafeUnwrap();
    expect(res).toEqual({
      scopeKey: 'onrc:published:7:3:11',
      published: true,
      parents: new Map([
        ['123', { kind: 'company', values: ACME }],
        ['456', { kind: 'private' }],
        ['789', { kind: 'none' }],
      ]),
    });
    expect(calls).toEqual([{ cuis: ['123', '456', '789'], scopeKey: '7', withValues: true }]);
    expect(repo.captureRegistryScope).toHaveBeenCalledTimes(1);
    // The private CUI is not served, so it is not part of the recheck.
    expect(repo.confirmRegistryScope).toHaveBeenCalledWith(PUBLISHED_SCOPE, ['123', '789']);
  });

  it('never asks for values under a scope that is not published', async () => {
    const { reader, calls } = fakeReader([new Map()]);
    const port = makeCompanySearchContribution(stubRepo({}, UNPUBLISHED_SCOPE), reader);
    const res = (await port.hydrate([], true))._unsafeUnwrap();
    expect(res).toMatchObject({ scopeKey: 'onrc:unpublished:-:0:11', published: false });
    expect(calls).toEqual([{ cuis: [], scopeKey: null, withValues: false }]);
  });

  it('a served CUI turning private before the recheck re-pins once and is then withheld', async () => {
    const confirmRegistryScope = vi
      .fn()
      .mockResolvedValueOnce(ok(recheckOf(PUBLISHED_SCOPE, ['123'])))
      .mockResolvedValue(ok(recheckOf(PUBLISHED_SCOPE)));
    const { reader, calls } = fakeReader([
      new Map<string, SearchCuiParent>([['123', { kind: 'company', values: ACME }]]),
      new Map<string, SearchCuiParent>([['123', { kind: 'private' }]]),
    ]);
    const port = makeCompanySearchContribution(stubRepo({ confirmRegistryScope }), reader);
    const res = (await port.hydrate(['123'], true))._unsafeUnwrap();
    expect(res.parents.get('123')).toEqual({ kind: 'private' });
    expect(calls).toHaveLength(2);
  });

  it('a scope moving twice is refused (never a page mixing scopes)', async () => {
    const confirmRegistryScope = vi.fn(async () => ok(recheckOf(MOVED_SCOPE)));
    const { reader } = fakeReader([new Map()]);
    const port = makeCompanySearchContribution(stubRepo({ confirmRegistryScope }), reader);
    expect((await port.hydrate([], true))._unsafeUnwrapErr()).toEqual({
      type: 'ServiceUnavailable',
      message: REGISTRY_MOVED_MESSAGE,
    });
  });

  it('accepts short canonical CUIs: the privacy population is not the ONRC company shape', async () => {
    const { reader, calls } = fakeReader([
      new Map<string, SearchCuiParent>([
        ['1', { kind: 'none' }],
        ['4', { kind: 'private' }],
      ]),
    ]);
    const repo = stubRepo();
    const res = (
      await makeCompanySearchContribution(repo, reader).hydrate(['1', '4'], true)
    )._unsafeUnwrap();
    expect(calls).toEqual([{ cuis: ['1', '4'], scopeKey: '7', withValues: true }]);
    expect(res.parents.get('4')).toEqual({ kind: 'private' });
    // The served short CUI is part of the recheck.
    expect(repo.confirmRegistryScope).toHaveBeenCalledWith(PUBLISHED_SCOPE, ['1']);
  });

  it.each([
    ['more than 50 candidates', Array.from({ length: 51 }, (_, i) => String(100 + i))],
    ['a non-CUI value', ['123', 'J12/345/2010']],
    ['a leading-zero value', ['0123']],
    ['zero', ['0']],
    ['a prefixed value', ['RO123']],
    ['an overlength (personal-shaped) value', ['12345678901']],
  ])('refuses %s before any read (never normalized)', async (_label, cuis) => {
    const repo = stubRepo();
    const { reader, calls } = fakeReader([new Map()]);
    const res = await makeCompanySearchContribution(repo, reader).hydrate(cuis, true);
    expect(res._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'cuis' });
    expect(calls).toEqual([]);
    expect(repo.captureRegistryScope).not.toHaveBeenCalled();
  });

  it('confirm: holds, moved, a served CUI now private, a key this API never issued', async () => {
    const holds = stubRepo();
    const port = makeCompanySearchContribution(holds, fakeReader([new Map()]).reader);
    expect((await port.confirm('onrc:published:7:3:11', ['123'])).isOk()).toBe(true);
    // The scope the key names (state, edition and both epochs: what a recheck compares).
    expect(holds.confirmRegistryScope).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'published',
        editionId: '7',
        publicationEpoch: '3',
        accessEpoch: '11',
      }),
      ['123']
    );

    const moved: CompanyRegistryScopePort = stubRepo({
      confirmRegistryScope: vi.fn(async () => ok(recheckOf(MOVED_SCOPE))),
    });
    const priv: CompanyRegistryScopePort = stubRepo({
      confirmRegistryScope: vi.fn(async () => ok(recheckOf(PUBLISHED_SCOPE, ['123']))),
    });
    for (const repo of [moved, priv]) {
      const res = await makeCompanySearchContribution(repo, fakeReader([]).reader).confirm(
        'onrc:published:7:3:11',
        ['123']
      );
      expect(res._unsafeUnwrapErr().message).toBe(REGISTRY_MOVED_MESSAGE);
    }
    expect((await port.confirm('onrc:published:07:3:11', []))._unsafeUnwrapErr().message).toBe(
      REGISTRY_MOVED_MESSAGE
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The SQL reader (scripted driver; executes nothing)
// ─────────────────────────────────────────────────────────────────────────────

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

const PROFILE_ROW = {
  p_cui: '123',
  p_identity_observations: 2,
  p_identifier_count: 1,
  p_unresolved_identifier_count: 0,
  p_unidentified_observations: 0,
  p_name: 'ACME  ROMANIA SRL',
  p_name_basis: 'single_observation',
  p_legal_form: 'SRL',
  p_legal_form_basis: 'single_observation',
  p_recorded_date: '2010-05-17',
  p_recorded_date_basis: 'single_observation',
  p_county_code: 'CJ',
  p_county_basis: 'single_observation',
  p_county_name: 'Cluj',
  p_uat_siruta_code: '54975',
  p_uat_basis: 'single_observation',
  p_uat_name: 'Cluj-Napoca',
  p_status_code: '1048',
  p_status_basis: 'single_observation',
  p_caen_coverage: 'complete',
  p_status_coverage: 'complete',
  p_legal_person_eligibility: 'eligible',
  p_eligibility_reason: null,
  p_eligibility_policy_version: 'public-legal-person-v1',
};

interface ClassificationRow {
  readonly cui: string;
  readonly kind: string;
  readonly is_public: boolean | null;
  readonly core_name: string;
}

const CLASSIFICATION: readonly ClassificationRow[] = [
  { cui: '123', kind: 'company', is_public: true, core_name: 'ACME SRL' },
  { cui: '456', kind: 'company', is_public: false, core_name: 'PRIVATE SRL' },
  { cui: '789', kind: 'public_entity', is_public: true, core_name: 'PRIMARIA' },
  { cui: '999', kind: 'company', is_public: null, core_name: 'NULL CLASS SRL' },
  { cui: '555', kind: 'company', is_public: true, core_name: 'CORE ONLY SRL' },
  // A public company outside the ONRC company shape (one digit): no contribution, not private.
  { cui: '1', kind: 'company', is_public: true, core_name: 'UNU SRL' },
  // A short-CUI institution whose organization is not public.
  { cui: '4', kind: 'public_entity', is_public: false, core_name: 'PRIVATE INSTITUTION' },
];

const scriptedReader = (
  opts: {
    readonly fail?: (sql: string) => boolean;
    readonly classification?: () => readonly ClassificationRow[];
  } = {}
) => {
  const statements: { sql: string; parameters: readonly unknown[] }[] = [];
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new ScriptedDriver((sql) => {
          if (opts.fail?.(sql) === true)
            throw Object.assign(new Error('relation missing'), { code: '42P01' });
          if (sql.includes('from core.organizations o')) {
            return opts.classification?.() ?? CLASSIFICATION;
          }
          // Only 555 has an institution role on a public territory.
          if (sql.includes('from core.public_entities pe')) {
            return [{ cui: '555', county_name: 'Cluj' }];
          }
          if (sql.includes('has_active_observation')) return [{ cui: '123' }];
          if (/\sunion\s/u.test(sql)) {
            return [
              { cui: '123', value: 'J12/345/2010' },
              { cui: '123', value: 'RO12345678901' },
              { cui: '123', value: 'ROONRC.J12/345/2010' },
            ];
          }
          if (sql.includes('onrc_published_profiles')) return [PROFILE_ROW];
          return [];
        }),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') {
        statements.push({
          sql: event.query.sql.replace(/\s+/gu, ' '),
          parameters: event.query.parameters,
        });
      }
    },
  });
  return { reader: makeCompanySearchReader(db), statements };
};

describe('makeCompanySearchReader', () => {
  const CUIS = ['123', '456', '789', '999', '555', '777', '1', '4'];

  it('classifies every parent (short CUIs too) and reads values only through the pinned edition views', async () => {
    const { reader, statements } = scriptedReader();
    const parents = (await reader.readSearchCompanies(CUIS, PUBLISHED_SCOPE, true))._unsafeUnwrap();
    expect(Object.fromEntries(parents)).toEqual({
      '123': {
        kind: 'company',
        values: {
          registryState: 'in_edition',
          name: 'ACME  ROMANIA SRL',
          nameSource: 'onrc_edition',
          legalForm: 'SRL',
          countyCode: 'CJ',
          countyName: 'Cluj',
          active: true,
          identifiers: ['J12/345/2010', 'ROONRC.J12/345/2010'],
        },
        independentCountyName: null,
      },
      '456': { kind: 'private' },
      '789': { kind: 'none' },
      // A NULL privacy class is not declared public: fails closed.
      '999': { kind: 'private' },
      '555': {
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
        // Its own public institution role's territory county (generic-county fallback).
        independentCountyName: 'Cluj',
      },
      '777': { kind: 'none' },
      // One digit: classified for privacy, but outside the ONRC company shape.
      '1': { kind: 'none' },
      // A short-CUI identity of any kind with a non-public organization.
      '4': { kind: 'private' },
    });
    expect(statements).toHaveLength(5);
    const [classify, ...rest] = statements;
    expect(classify?.sql).toContain('from core.organizations o');
    expect(classify?.parameters).toContain(JSON.stringify(CUIS));
    const edition = rest.filter((s) => s.sql.includes('companies_v2.'));
    expect(edition).toHaveLength(3);
    for (const s of edition) {
      expect(s.sql).toMatch(
        /companies_v2\.onrc_published_(profiles|identifier_profiles|identity_observations)/u
      );
      expect(s.sql).toContain('::bigint');
      expect(s.parameters).toContain('7');
      // Only public company parents of the ONRC shape are read from the edition.
      expect(s.parameters).toContain(JSON.stringify(['123', '555']));
    }
    const institution = rest.filter((s) => s.sql.includes('core.public_entities'));
    expect(institution).toHaveLength(1);
    // A PUBLIC territory hub row only; the same company parents.
    expect(institution[0]?.sql).toContain('join core.territories t on t.id = pe.territory_id and');
    expect(institution[0]?.parameters).toEqual(['public', JSON.stringify(['123', '555'])]);
    for (const s of statements) {
      expect(s.sql).not.toMatch(/onrc_current|registrations|status_flags|companies\.\w/u);
      // Never the core organization's own (possibly stale) county.
      expect(s.sql).not.toMatch(/o\.county_name/u);
    }
  });

  it('reads no edition view without values (or without a published scope)', async () => {
    for (const [scope, withValues] of [
      [PUBLISHED_SCOPE, false],
      [UNPUBLISHED_SCOPE, true],
    ] as const) {
      const { reader, statements } = scriptedReader();
      const parents = (await reader.readSearchCompanies(CUIS, scope, withValues))._unsafeUnwrap();
      expect(parents.get('123')).toEqual({ kind: 'company', values: null });
      expect(parents.get('456')).toEqual({ kind: 'private' });
      expect(statements).toHaveLength(1);
    }
  });

  it('an empty page reads nothing; a lost view is a moved scope (re-pinned once)', async () => {
    const empty = scriptedReader();
    expect(
      (await empty.reader.readSearchCompanies([], PUBLISHED_SCOPE, true))._unsafeUnwrap().size
    ).toBe(0);
    expect(empty.statements).toEqual([]);

    const lost = scriptedReader({ fail: (sql) => sql.includes('onrc_published_profiles') });
    expect(
      (await lost.reader.readSearchCompanies(['123'], PUBLISHED_SCOPE, true))._unsafeUnwrapErr()
    ).toEqual({ type: 'ServiceUnavailable', message: REGISTRY_CAPABILITY_LOST_MESSAGE });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The whole chain: global search → real contribution → reader over a driver
// ─────────────────────────────────────────────────────────────────────────────

/** The generation control of PUBLISHED_SCOPE (edition 7, epochs 3 / 11), literal. */
const CONTROL_7: Readonly<Record<string, unknown>> = {
  id: 'palette_generation_control',
  doc_type: 'palette_generation_control',
  doc_key: 'palette_generation_control',
  privacy_class: 'internal',
  control_version: 'palette-generation-control-v1',
  projection_version: 'palette-company-v1',
  generation_id: 'entities_build_1759600000000_ab12cd',
  registry_scope_key: 'onrc:published:7:3:11',
  onrc_edition_id: '7',
  onrc_publication_epoch: '3',
  company_access_epoch: '11',
  onrc_source_snapshot_id: 'onrc:2026-07-08',
  onrc_source_published_at: '2026-07-08',
  onrc_interpretation_version: 'onrc-edition-v1',
  onrc_dimension_policy_version: 'onrc-dimensions-v1',
  entity_count: 10,
  company_count: 4,
  company_value_digest: '00000000000000000000000000000000000000000000000000000000000000aa',
};

const hitOf = (docType: string, docKey: string, title: string): SearchHit => ({
  id: `${docType}_${docKey}`,
  docType,
  docKey,
  title,
  snippet: null,
  score: 0.5,
  source: 'meili',
  attrs: { privacy_class: 'public' },
});

/** An independent institution keyed by the short CUI 1, a registry NGO and a company control. */
const CHAIN_PAGE = [
  hitOf('organization', '1', 'PRIVATE PARENT NAME'),
  hitOf('ngo', 'registry:12345', 'Registry only'),
  {
    ...hitOf('company', '123', 'ACME STALE'),
    countyName: 'Cluj',
    attrs: {
      privacy_class: 'public',
      company_registry_state: 'in_edition',
      company_name: 'ACME  ROMANIA SRL',
      company_name_source: 'onrc_edition',
      company_legal_form: 'SRL',
      company_county_code: 'CJ',
      company_active: true,
      company_identifiers: ['J12/345/2010'],
    },
  },
];

const chain = (
  opts: {
    readonly classification?: () => readonly ClassificationRow[];
    readonly fail?: (sql: string) => boolean;
    readonly finalPrivate?: readonly string[];
  } = {}
) => {
  const { reader, statements } = scriptedReader(opts);
  const confirmRegistryScope = vi
    .fn()
    // The hydration's own recheck holds; the final decision sees `finalPrivate`.
    .mockResolvedValueOnce(ok(recheckOf(PUBLISHED_SCOPE)))
    .mockResolvedValue(ok(recheckOf(PUBLISHED_SCOPE, opts.finalPrivate ?? [])));
  const repo = stubRepo({ confirmRegistryScope });
  const meili = {
    searchEntities: async () =>
      ok({ hits: CHAIN_PAGE, facetDistribution: {}, estimatedTotalHits: 3 }),
    readGenerationControl: async () => ok(CONTROL_7),
  } as unknown as MeiliClient;
  let snapshotReads = 0;
  const deps: GlobalSearchDeps = {
    meiliClient: meili,
    meiliIndexes: ['entities'],
    companySearch: {
      ...makeCompanySearchContribution(repo, reader),
      readAccessSnapshot: () => {
        snapshotReads += 1;
        if (opts.fail?.('from core.organizations o') === true) return null;
        const rows = opts.classification?.() ?? CLASSIFICATION;
        return {
          scopeKey: 'onrc:published:7:3:11',
          published: true,
          privateCuis: new Set([
            ...rows.filter((row) => row.is_public !== true).map((row) => row.cui),
            ...(snapshotReads > 1 ? (opts.finalPrivate ?? []) : []),
          ]),
          privateInstitutionCuis: new Set<string>(),
        };
      },
    },
  };
  return { deps, statements, confirmRegistryScope };
};

const classificationWith = (one: ClassificationRow | null) => () => [
  ...CLASSIFICATION.filter((row) => row.cui !== '1'),
  ...(one === null ? [] : [one]),
];

describe('the global search reads only the access mirror while its database driver remains idle', () => {
  it.each([
    ['a non-public parent', { cui: '1', kind: 'public_entity', is_public: false, core_name: 'X' }],
    ['a NULL-class parent', { cui: '1', kind: 'company', is_public: null, core_name: 'X' }],
  ] as const)(
    'the short-CUI institution with %s is withheld; it was in the privacy batch',
    async (_label, row) => {
      const { deps, statements } = chain({ classification: classificationWith(row) });
      const result = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap();
      expect(result.hits.map((h) => h.docKey)).toEqual(['registry:12345', '123']);
      expect(statements).toEqual([]);
    }
  );

  it.each([
    [
      'a public non-company parent',
      { cui: '1', kind: 'public_entity', is_public: true, core_name: 'X' },
    ],
    ['no core organization', null],
  ] as const)('with %s the institution keeps its own role, company null', async (_label, row) => {
    const { deps } = chain({ classification: classificationWith(row) });
    const result = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap();
    expect(result.hits.map((h) => [h.docKey, h.title, h.company ?? null])).toEqual([
      ['1', 'PRIVATE PARENT NAME', null],
      ['registry:12345', 'Registry only', null],
      ['123', 'ACME ROMANIA SRL', expect.objectContaining({ name: 'ACME  ROMANIA SRL' })],
    ]);
  });

  it('an unreadable parent check withholds it (and every CUI identity)', async () => {
    const { deps } = chain({ fail: (sql) => sql.includes('from core.organizations o') });
    const result = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap();
    expect(result.companyContributionReason).toBe('company_check_unavailable');
    expect(result.hits.map((h) => h.docKey)).toEqual(['registry:12345']);
  });

  it('a late private transition reaches the final check with the short CUI and refuses', async () => {
    const { deps, confirmRegistryScope } = chain({
      classification: classificationWith({
        cui: '1',
        kind: 'public_entity',
        is_public: true,
        core_name: 'X',
      }),
      finalPrivate: ['1'],
    });
    const result = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap();
    expect((await confirmGlobalSearchServed(deps, result))._unsafeUnwrapErr()).toEqual({
      type: 'ServiceUnavailable',
      message: 'the access of the served identities could not be rechecked; retry',
    });
    expect(confirmRegistryScope).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REGNUM keeps its own checked path
// ─────────────────────────────────────────────────────────────────────────────

it('REGNUM resolution never reads the palette or its control', async () => {
  const searchEntities = vi.fn();
  const readGenerationControl = vi.fn();
  const meili = { searchEntities, readGenerationControl } as unknown as MeiliClient;
  const findByRegistrationNumber = vi.fn(async () =>
    ok([
      {
        dim: 'regnum' as const,
        value: '123',
        label: 'ACME  ROMANIA SRL',
        cui: '123',
        confidence: 1,
        labelSource: 'onrc_edition' as const,
      },
    ])
  );
  const res = await makeCompanyResolve(
    { repo: stubRepo({ findByRegistrationNumber }), flowsRepo: stubFlows(), meili },
    'regnum',
    'J12/345/2010',
    5
  );
  expect(res._unsafeUnwrap()).toMatchObject({ degraded: false, matches: [{ cui: '123' }] });
  expect(searchEntities).not.toHaveBeenCalled();
  expect(readGenerationControl).not.toHaveBeenCalled();
});
