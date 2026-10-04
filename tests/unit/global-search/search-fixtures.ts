/**
 * Literal fixtures for the global search's company contribution (no I/O, no
 * mocking library): generation-control documents, a scripted Meili client, a
 * recording company port and palette-shaped hits. Every expected value in the
 * tests is written out by hand; nothing here derives a control, a scope key
 * or a company value from production code.
 */

import { err, ok, type Result } from 'neverthrow';
import { vi } from 'vitest';

import { databaseError, upstreamError, type ApiError } from '@/modules/shared/core/errors.js';

import type {
  EntitiesSearchResult,
  MeiliClient,
  SearchCompanyContributionPort,
  SearchCuiParent,
} from '@/modules/shared/core/ports.js';
import type { SearchHit, SearchHitCompany } from '@/modules/shared/core/types.js';

/** Scope A: edition 42, publication epoch 3, access epoch 17. */
export const SCOPE_A = 'onrc:published:42:3:17';
/** Scope B: the same edition published again (publication epoch 4), every value identical. */
export const SCOPE_B = 'onrc:published:42:4:17';

/** The 18-key control of generation A (contract §1), written out literally. */
export const CONTROL_A: Readonly<Record<string, unknown>> = {
  id: 'palette_generation_control',
  doc_type: 'palette_generation_control',
  doc_key: 'palette_generation_control',
  privacy_class: 'internal',
  control_version: 'palette-generation-control-v1',
  projection_version: 'palette-company-v1',
  generation_id: 'entities_build_1759600000000_ab12cd',
  registry_scope_key: 'onrc:published:42:3:17',
  onrc_edition_id: '42',
  onrc_publication_epoch: '3',
  company_access_epoch: '17',
  onrc_source_snapshot_id: 'onrc-2026-09-30',
  onrc_source_published_at: '2026-09-30',
  onrc_interpretation_version: 'onrc-edition-v1',
  onrc_dimension_policy_version: 'onrc-dimensions-v1',
  entity_count: 4200000,
  company_count: 3900000,
  company_value_digest: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
};

/** Generation B: built for scope B after the A → B publication with identical values. */
export const CONTROL_B: Readonly<Record<string, unknown>> = {
  ...CONTROL_A,
  generation_id: 'entities_build_1759600900000_ef34gh',
  registry_scope_key: 'onrc:published:42:4:17',
  onrc_publication_epoch: '4',
};

/** Generation A2: a new build for the SAME registry scope A (only the generation moved). */
export const CONTROL_A2: Readonly<Record<string, unknown>> = {
  ...CONTROL_A,
  generation_id: 'entities_build_1759601800000_zz99yy',
  entity_count: 4200001,
};

/** A control read that fails (the engine answered the search but not the exact read). */
export const UNREADABLE = Symbol('unreadable control');

/**
 * A scripted Meili client: `controls` answers successive control reads (the
 * last one repeats); `null` is "no control document", `UNREADABLE` a failed
 * read. `controls: 'absent'` builds a client without the exact read at all.
 */
export const scriptedMeili = (opts: {
  readonly page?: Result<EntitiesSearchResult, ApiError>;
  readonly pages?: readonly Result<EntitiesSearchResult, ApiError>[];
  readonly controls?:
    readonly (Readonly<Record<string, unknown>> | null | typeof UNREADABLE)[] | 'absent';
}) => {
  let searches = 0;
  const searchEntities = vi.fn(async () => {
    const page =
      opts.pages?.[Math.min(searches, opts.pages.length - 1)] ??
      opts.page ??
      ok({ hits: [], facetDistribution: {}, estimatedTotalHits: 0 });
    searches += 1;
    return page;
  });
  let reads = 0;
  const controls = opts.controls ?? [CONTROL_A];
  const readGenerationControl = vi.fn(async (_index: string) => {
    if (controls === 'absent') return ok(null);
    const answer = controls[Math.min(reads, controls.length - 1)] ?? null;
    reads += 1;
    return answer === UNREADABLE
      ? err(upstreamError('meilisearch generation control 500', 'meilisearch'))
      : ok(answer);
  });
  const client =
    controls === 'absent'
      ? ({ searchEntities } as unknown as MeiliClient)
      : ({ searchEntities, readGenerationControl } as unknown as MeiliClient);
  return { client, searchEntities, readGenerationControl };
};

export const page = (
  hits: readonly SearchHit[],
  over: Partial<EntitiesSearchResult> = {}
): Result<EntitiesSearchResult, ApiError> =>
  ok({ hits, facetDistribution: {}, estimatedTotalHits: hits.length, ...over });

/**
 * A recording company port. `parents` answers per CUI (default `none`);
 * `scopes` answers successive hydrations (the last one repeats);
 * `confirm` decides the final check (default: ok).
 */
export const recordingCompanies = (opts: {
  readonly scopes?: readonly { readonly scopeKey: string; readonly published: boolean }[];
  readonly parents?: Readonly<Record<string, SearchCuiParent>>;
  readonly failHydrate?: boolean;
  readonly confirm?: () => Result<void, ApiError>;
}) => {
  const hydrations: { cuis: readonly string[]; withValues: boolean }[] = [];
  const confirmations: { scopeKey: string; cuis: readonly string[] }[] = [];
  const state = { parents: { ...(opts.parents ?? {}) } as Record<string, SearchCuiParent> };
  const scopes = opts.scopes ?? [{ scopeKey: SCOPE_A, published: true }];
  const port: SearchCompanyContributionPort = {
    hydrate: async (cuis, withValues) => {
      hydrations.push({ cuis: [...cuis], withValues });
      if (opts.failHydrate === true) return err(databaseError('company search hydration failed'));
      const scope = scopes[Math.min(hydrations.length - 1, scopes.length - 1)] ?? scopes[0]!;
      return ok({
        scopeKey: scope.scopeKey,
        published: scope.published,
        parents: new Map(cuis.map((cui) => [cui, state.parents[cui] ?? { kind: 'none' }])),
      });
    },
    confirm: async (scopeKey, cuis) => {
      confirmations.push({ scopeKey, cuis: [...cuis] });
      return opts.confirm?.() ?? ok(undefined);
    },
  };
  return { port, hydrations, confirmations, state };
};

/** The current values of CUI 123 (hydrated: what the database says now). */
export const ACME_NOW: SearchHitCompany = {
  registryState: 'in_edition',
  name: 'ACME  ROMANIA SRL',
  nameSource: 'onrc_edition',
  legalForm: 'SRL',
  countyCode: 'CJ',
  countyName: 'Cluj',
  active: true,
  identifiers: ['J12/345/2010', 'ROONRC.J12/345/2010'],
};

/**
 * A palette company document for CUI 123 whose company values are STALE
 * (old name, Bihor, struck off, an old registration number, a legacy status
 * attribute). None of these strings may survive hydration.
 */
export const staleCompanyHit = (over: Partial<SearchHit> = {}): SearchHit => ({
  id: 'company_123_9f86d081884c7d659a2feaa0c55ad015',
  docType: 'company',
  docKey: '123',
  docId: 'company:123',
  title: 'ACME OLD SRL',
  snippet: 'SRL, Bihor',
  subtitle: 'SRL, Bihor',
  score: 0.93,
  source: 'meili',
  countyName: 'Bihor',
  isActive: false,
  rankBoost: 1,
  identifiers: ['123', 'J05/1/1999', 'RO123'],
  cuis: ['123'],
  roles: ['company'],
  isUat: null,
  entityTags: [],
  url: '/companii/123',
  attrs: {
    privacy_class: 'public',
    title: 'ACME OLD SRL',
    subtitle: 'SRL, Bihor',
    county_name: 'Bihor',
    is_active: false,
    rank_boost: 1,
    identifiers: ['123', 'J05/1/1999', 'RO123'],
    company_registry_state: 'in_edition',
    company_name: 'ACME OLD SRL',
    company_name_source: 'onrc_edition',
    company_legal_form: 'SRL',
    company_county_code: 'BH',
    company_active: false,
    company_identifiers: ['J05/1/1999'],
    attrs: { kind: 'srl', status: 'radiat' },
  },
  ...over,
});

/**
 * A mixed-role identity whose document is an INSTITUTION (`organization`)
 * and whose index roles do NOT mention `company` (misleading), while its core
 * parent is a public company (CUI 456).
 */
export const mixedInstitutionHit = (): SearchHit => ({
  id: 'organization_456_0cc175b9c0f1b6a831c399e269772661',
  docType: 'organization',
  docKey: '456',
  title: 'REGIA AUTONOMA DE TRANSPORT',
  snippet: 'Instituție publică',
  subtitle: 'Instituție publică',
  score: 0.71,
  source: 'meili',
  countyName: 'Bihor',
  isActive: true,
  rankBoost: 3,
  identifiers: ['456', 'J05/9/1991', 'RNONG-1'],
  cuis: ['456'],
  roles: ['organization'],
  isUat: false,
  entityTags: ['kind::regie'],
  url: '/entitati/456',
  attrs: {
    privacy_class: 'public',
    company_registry_state: 'in_edition',
    company_name: 'RATB OLD',
    company_name_source: 'onrc_edition',
    company_legal_form: 'RA',
    company_county_code: 'BH',
    company_active: false,
    company_identifiers: ['J05/9/1991'],
    attrs: { kind: 'regie' },
  },
});

/** An independent NGO identity (CUI 789): no company contribution in the index. */
export const ngoHit = (): SearchHit => ({
  id: 'ngo_789_92eb5ffee6ae2fec3ad71c777531578f',
  docType: 'ngo',
  docKey: '789',
  title: 'ASOCIATIA PRIETENII',
  snippet: 'ONG',
  subtitle: 'ONG',
  score: 0.5,
  source: 'meili',
  countyName: 'Iași',
  isActive: true,
  rankBoost: 2,
  identifiers: ['789', 'RNONG-777'],
  cuis: ['789'],
  roles: ['ngo'],
  isUat: null,
  entityTags: ['kind::ngo'],
  url: '/ong/789',
  ngoRegistryNumber: '777',
  attrs: {
    privacy_class: 'public',
    company_registry_state: null,
    company_name: null,
    company_name_source: null,
    company_legal_form: null,
    company_county_code: null,
    company_active: null,
    company_identifiers: null,
    attrs: { kind: 'asociatie' },
  },
});

/** An independent public enterprise (CUI 321), no company contribution. */
export const enterpriseHit = (): SearchHit => ({
  id: 'public_enterprise_321_4a8a08f09d37b73795649038408b5f33',
  docType: 'public_enterprise',
  docKey: '321',
  title: 'COMPANIA NATIONALA X',
  snippet: 'Întreprindere publică',
  subtitle: 'Întreprindere publică',
  score: 0.4,
  source: 'meili',
  countyName: 'București',
  isActive: true,
  rankBoost: 2,
  identifiers: ['321'],
  cuis: ['321'],
  roles: ['public_enterprise'],
  isUat: null,
  entityTags: [],
  url: '/intreprinderi/321',
  attrs: {
    privacy_class: 'public',
    company_registry_state: null,
    company_name: null,
    company_name_source: null,
    company_legal_form: null,
    company_county_code: null,
    company_active: null,
    company_identifiers: null,
  },
});

/** A non-identity document (a bill): never a company candidate. */
export const billHit = (): SearchHit => ({
  id: 'bill_8277e0910d750195b448797616e091ad',
  docType: 'bill',
  docKey: 'PLx-100/2026',
  title: 'Proiect de lege privind registrul comerțului',
  snippet: null,
  score: 0.3,
  source: 'meili',
  identifiers: ['PLx-100/2026'],
  cuis: [],
  roles: ['bill'],
  isUat: null,
  entityTags: [],
  url: '/legi/PLx-100-2026',
  attrs: { privacy_class: 'public' },
});

/**
 * An independent institution keyed by a SHORT canonical CUI (outside the ONRC
 * company shape): `docKey` defaults to `'1'`. The index still says public.
 */
export const shortKeyInstitutionHit = (over: Partial<SearchHit> = {}): SearchHit => ({
  id: 'organization_1_c4ca4238a0b923820dcc509a6f75849b',
  docType: 'organization',
  docKey: '1',
  title: 'PRIVATE PARENT NAME',
  snippet: 'Instituție publică',
  subtitle: 'Instituție publică',
  score: 0.8,
  source: 'meili',
  countyName: 'Alba',
  isActive: true,
  identifiers: ['1'],
  cuis: [],
  roles: ['organization'],
  isUat: false,
  entityTags: [],
  url: '/entitati/1',
  attrs: { privacy_class: 'public' },
  ...over,
});

/** An NGO of the registry key domain (`registry:<number>`): it names no core organization. */
export const registryNgoHit = (): SearchHit => ({
  id: 'registry',
  docType: 'ngo',
  docKey: 'registry:12345',
  title: 'Registry only',
  snippet: null,
  score: 0.2,
  source: 'meili',
  identifiers: ['12345'],
  cuis: [],
  roles: ['ngo'],
  isUat: null,
  entityTags: ['source::rnong'],
  ngoRegistryNumber: '12345',
  attrs: { privacy_class: 'public' },
});
