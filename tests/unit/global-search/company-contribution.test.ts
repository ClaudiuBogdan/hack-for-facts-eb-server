/**
 * Kernel global search — the company contribution (scrapper
 * `search-generation-control-contract.md` §6, turn api-repair-08).
 *
 * Hand-written expectations over literal fixtures (`search-fixtures.ts`):
 *  - the generation control is parsed strictly (18 keys, versions, bigints,
 *    civil date) and read before AND after the candidate fetch;
 *  - only engine candidates are cached, keyed by generation + scope;
 *  - every request hydrates fresh (cache hits and empty pages included);
 *  - company-owned values come only from that hydration, other roles' values
 *    stay when separable, a known private parent vetoes any candidate;
 *  - the state is current / partial / unavailable, never a healthy stale zero;
 *  - continuation follows the candidates, not the visible hits.
 */

import { err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { serviceUnavailable } from '@/modules/shared/core/errors.js';
import {
  parseGenerationControl,
  witnessGeneration,
} from '@/modules/shared/core/search-generation.js';
import {
  confirmGlobalSearchServed,
  makeGlobalSearch,
  type GlobalSearchDeps,
} from '@/modules/shared/core/usecases/global-search.js';
import { createCache } from '@/modules/shared/shell/middleware/cache.js';

import {
  ACME_NOW,
  CONTROL_A,
  CONTROL_A2,
  CONTROL_B,
  SCOPE_A,
  SCOPE_B,
  UNREADABLE,
  billHit,
  enterpriseHit,
  mixedInstitutionHit,
  ngoHit,
  page,
  recordingCompanies,
  registryNgoHit,
  scriptedMeili,
  shortKeyInstitutionHit,
  staleCompanyHit,
} from './search-fixtures.js';

import type { SearchHit, SearchHitCompany } from '@/modules/shared/core/types.js';

const RATB_NOW: SearchHitCompany = {
  registryState: 'in_edition',
  name: 'REGIA AUTONOMA DE TRANSPORT SA',
  nameSource: 'onrc_edition',
  legalForm: 'SA',
  countyCode: 'CJ',
  countyName: 'Cluj',
  active: null,
  identifiers: ['J12/9/1991'],
};

const ALL_HITS = () => [
  staleCompanyHit(),
  mixedInstitutionHit(),
  ngoHit(),
  enterpriseHit(),
  billHit(),
];
const PARENTS = {
  '123': { kind: 'company', values: ACME_NOW },
  '456': { kind: 'company', values: RATB_NOW },
  '789': { kind: 'none' },
  '321': { kind: 'none' },
} as const;

const setup = (
  meili: Parameters<typeof scriptedMeili>[0],
  companies: Parameters<typeof recordingCompanies>[0] = { parents: PARENTS }
) => {
  const m = scriptedMeili(meili);
  const c = recordingCompanies(companies);
  const deps: GlobalSearchDeps = {
    meiliClient: m.client,
    meiliIndexes: ['entities'],
    companySearch: c.port,
  };
  return { deps, meili: m, companies: c };
};

// ─────────────────────────────────────────────────────────────────────────────
// The control document
// ─────────────────────────────────────────────────────────────────────────────

describe('generation control parsing (18 keys, strict)', () => {
  it('accepts the literal control and keeps bigints and the date as text', () => {
    expect(parseGenerationControl(CONTROL_A)).toEqual({
      state: 'valid',
      control: {
        generationId: 'entities_build_1759600000000_ab12cd',
        registryScopeKey: 'onrc:published:42:3:17',
        editionId: '42',
        publicationEpoch: '3',
        accessEpoch: '17',
        sourceSnapshotId: 'onrc-2026-09-30',
        sourcePublishedAt: '2026-09-30',
        entityCount: 4200000,
        companyCount: 3900000,
        companyValueDigest: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
      },
    });
    expect(parseGenerationControl({ ...CONTROL_A, onrc_source_published_at: null }).state).toBe(
      'valid'
    );
    expect(parseGenerationControl(null)).toEqual({ state: 'missing' });
  });

  it.each([
    ['an old control version', { control_version: 'palette-generation-control-v0' }, 'unsupported'],
    ['a newer projection version', { projection_version: 'palette-company-v2' }, 'unsupported'],
    ['an extra key', { title: 'x' }, 'malformed'],
    ['a public privacy class', { privacy_class: 'public' }, 'malformed'],
    ['a leading-zero edition', { onrc_edition_id: '042' }, 'malformed'],
    ['edition 0', { onrc_edition_id: '0' }, 'malformed'],
    ['a bigint overflow', { company_access_epoch: '9223372036854775808' }, 'malformed'],
    ['a numeric epoch', { onrc_publication_epoch: 3 }, 'malformed'],
    ['a scope key that disagrees', { registry_scope_key: 'onrc:published:42:3:18' }, 'malformed'],
    ['an impossible date', { onrc_source_published_at: '2026-02-30' }, 'malformed'],
    ['year 0000', { onrc_source_published_at: '0000-01-01' }, 'malformed'],
    ['a control character', { onrc_source_snapshot_id: 'onrc\u0007' }, 'malformed'],
    ['an empty snapshot', { onrc_source_snapshot_id: '' }, 'malformed'],
    ['an unsafe count', { entity_count: 2 ** 53 }, 'malformed'],
    ['a negative count', { company_count: -1 }, 'malformed'],
    ['an uppercase digest', { company_value_digest: 'F'.repeat(64) }, 'malformed'],
    ['a bad generation id', { generation_id: 'entities build' }, 'malformed'],
  ])('refuses %s', (_label, change, state) => {
    expect(parseGenerationControl({ ...CONTROL_A, ...change }).state).toBe(state);
  });

  it('refuses an omitted key', () => {
    const without = Object.fromEntries(
      Object.entries(CONTROL_A).filter(([key]) => key !== 'company_value_digest')
    );
    expect(Object.keys(without)).toHaveLength(17);
    expect(parseGenerationControl(without).state).toBe('malformed');
  });

  it('witnesses only two equal valid reads', () => {
    const a = parseGenerationControl(CONTROL_A);
    const b = parseGenerationControl(CONTROL_B);
    expect(witnessGeneration(a, a)).toMatchObject({ witnessed: true });
    expect(witnessGeneration(a, b)).toEqual({ witnessed: false, reason: 'control_incoherent' });
    expect(witnessGeneration({ state: 'missing' }, a)).toEqual({
      witnessed: false,
      reason: 'control_missing',
    });
    expect(witnessGeneration(a, { state: 'unreadable' })).toEqual({
      witnessed: false,
      reason: 'control_unreadable',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Current: the whole matrix of owners
// ─────────────────────────────────────────────────────────────────────────────

describe('a witnessed generation built for the fresh published scope', () => {
  it('refreshes every company-owned field and keeps the other contributors exactly', async () => {
    const { deps, meili, companies } = setup({ page: page(ALL_HITS()) });
    const result = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();

    expect(meili.readGenerationControl).toHaveBeenCalledTimes(2);
    expect(companies.hydrations).toEqual([
      { cuis: ['123', '456', '789', '321'], withValues: true },
    ]);
    expect(result).toMatchObject({
      generation: {
        generationId: 'entities_build_1759600000000_ab12cd',
        registryScopeKey: 'onrc:published:42:3:17',
      },
      companyScope: 'onrc:published:42:3:17',
      companyContribution: 'current',
      companyContributionReason: null,
      continuation: { candidatesReturned: 5, nextOffset: null },
    });
    expect(result.hits).toEqual([
      {
        id: 'company_123_9f86d081884c7d659a2feaa0c55ad015',
        docType: 'company',
        docKey: '123',
        docId: 'company:123',
        title: 'ACME ROMANIA SRL',
        snippet: 'SRL, Cluj',
        subtitle: 'SRL, Cluj',
        score: 0.93,
        source: 'meili',
        countyName: 'Cluj',
        isActive: true,
        identifiers: ['123', 'RO123', 'J12/345/2010', 'ROONRC.J12/345/2010'],
        cuis: ['123'],
        roles: ['company'],
        isUat: null,
        entityTags: [],
        url: '/companii/123',
        attrs: { privacy_class: 'public' },
        company: ACME_NOW,
      },
      {
        id: 'organization_456_0cc175b9c0f1b6a831c399e269772661',
        docType: 'organization',
        docKey: '456',
        // The institution's own title, subtitle, link and tags stay.
        title: 'REGIA AUTONOMA DE TRANSPORT',
        snippet: 'Instituție publică',
        subtitle: 'Instituție publică',
        score: 0.71,
        source: 'meili',
        // Generic county of a company-kind identity: the company's, refreshed.
        countyName: 'Cluj',
        // The index OR was true while its company term was false: another role is active.
        isActive: true,
        identifiers: ['456', 'RNONG-1', 'J12/9/1991'],
        cuis: ['456'],
        roles: ['organization'],
        isUat: false,
        entityTags: ['kind::regie'],
        url: '/entitati/456',
        attrs: { privacy_class: 'public', attrs: { kind: 'regie' } },
        company: RATB_NOW,
      },
      {
        ...ngoHit(),
        attrs: { privacy_class: 'public', attrs: { kind: 'asociatie' } },
        company: null,
      },
      { ...enterpriseHit(), attrs: { privacy_class: 'public' }, company: null },
      billHit(),
    ]);
  });

  it('leaves no stale company-owned title, county, identifier, activity or attribute', async () => {
    const { deps } = setup({ page: page(ALL_HITS()) });
    const result = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
    const text = JSON.stringify(result.hits);
    for (const stale of [
      'ACME OLD SRL',
      'Bihor',
      'J05/1/1999',
      'J05/9/1991',
      'radiat',
      'RATB OLD',
      '"BH"',
    ]) {
      expect(text).not.toContain(stale);
    }
    expect(text).not.toMatch(/company_(name|active|identifiers|county_code|registry_state)/u);
  });

  it('keeps an applicable unknown activity unknown (null), never inactive', async () => {
    const { deps } = setup(
      { page: page([staleCompanyHit(), mixedInstitutionHit()]) },
      {
        parents: {
          '123': { kind: 'company', values: { ...ACME_NOW, active: null } },
          '456': { kind: 'company', values: RATB_NOW },
        },
      }
    );
    const hits = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap().hits;
    // 123: index OR false (every term false) ∨ unknown company → unknown.
    expect(hits[0]).toMatchObject({ isActive: null, company: { active: null } });
    // 456: an active independent role ∨ unknown company → active.
    expect(hits[1]).toMatchObject({ isActive: true, company: { active: null } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ownership and vetoes decided by the fresh domain, not the index
// ─────────────────────────────────────────────────────────────────────────────

describe('the fresh domain decides, whatever the index doc_type or roles say', () => {
  it('a known private parent withholds the candidate, whatever role it plays', async () => {
    const { deps } = setup(
      { page: page([ngoHit(), mixedInstitutionHit(), billHit()]) },
      { parents: { '789': { kind: 'private' }, '456': { kind: 'private' } } }
    );
    const result = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap();
    expect(result.hits.map((h) => h.id)).toEqual(['bill_8277e0910d750195b448797616e091ad']);
  });

  it('a company document whose parent is no longer a company has nothing to show', async () => {
    const { deps } = setup(
      { page: page([staleCompanyHit()]) },
      { parents: { '123': { kind: 'none' } } }
    );
    expect((await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap().hits).toEqual([]);
  });

  it('a company document without a CUI identity cannot be hydrated and is withheld', async () => {
    const { deps, companies } = setup({
      page: page([staleCompanyHit({ docKey: 'acme' }), billHit()]),
    });
    const result = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
    expect(result.hits.map((h) => h.docType)).toEqual(['bill']);
    expect(companies.hydrations).toEqual([{ cuis: [], withValues: true }]);
  });

  it('a former company contribution of a non-company identity loses its company-derived fields', async () => {
    // The index still carries 456's company term; the fresh parent is not a company.
    const { deps } = setup({ page: page([mixedInstitutionHit()]) }, { parents: {} });
    const [hit] = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap().hits;
    expect(hit).toMatchObject({
      title: 'REGIA AUTONOMA DE TRANSPORT',
      isActive: true,
      identifiers: ['456', 'RNONG-1'],
      company: null,
    });
    expect(hit).not.toHaveProperty('countyName');
    expect(hit).not.toHaveProperty('rankBoost');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Not current: never a healthy current answer
// ─────────────────────────────────────────────────────────────────────────────

describe('a generation that is not witnessed current', () => {
  it.each([
    ['no control document', [null], 'control_missing'],
    ['an unreadable control', [UNREADABLE], 'control_unreadable'],
    [
      'an old control version',
      [{ ...CONTROL_A, control_version: 'palette-generation-control-v0' }],
      'control_unsupported',
    ],
    ['a malformed control', [{ ...CONTROL_A, onrc_edition_id: '042' }], 'control_malformed'],
  ] as const)('%s: company contribution unavailable', async (_label, controls, reason) => {
    const { deps, companies } = setup({ page: page(ALL_HITS()), controls: [...controls] });
    const result = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
    expect(result).toMatchObject({
      generation: null,
      companyScope: SCOPE_A,
      companyContribution: 'unavailable',
      companyContributionReason: reason,
    });
    // Values are not even read; the parents still are (the veto is independent).
    expect(companies.hydrations).toEqual([
      { cuis: ['123', '456', '789', '321'], withValues: false },
    ]);
    // The company document disappears; nothing company-owned or unseparable stays.
    expect(result.hits.map((h) => h.docKey)).toEqual(['456', '789', '321', 'PLx-100/2026']);
    expect(result.hits[0]).toMatchObject({ isActive: null, identifiers: ['456'], company: null });
    expect(result.hits[0]).not.toHaveProperty('countyName');
    // Without a witnessed v1 projection another role's activity and identifiers
    // cannot be told apart from a stale company term: only the CUI is certain.
    expect(result.hits[1]).toMatchObject({
      title: 'ASOCIATIA PRIETENII',
      countyName: 'Iași',
      isActive: null,
      identifiers: ['789'],
      company: null,
    });
    expect(result.hits[3]).toEqual(billHit());
  });

  it('a client without the exact control read is never a witness', async () => {
    const { deps } = setup({ page: page([staleCompanyHit()]), controls: 'absent' });
    expect((await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap()).toMatchObject({
      hits: [],
      companyContribution: 'unavailable',
      companyContributionReason: 'control_missing',
    });
  });

  it('published A → B with identical values still moves the scope: partial, fresh values', async () => {
    const { deps } = setup(
      { page: page([staleCompanyHit()]) },
      { scopes: [{ scopeKey: SCOPE_B, published: true }], parents: PARENTS }
    );
    const result = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
    expect(result).toMatchObject({
      generation: { registryScopeKey: SCOPE_A },
      companyScope: SCOPE_B,
      companyContribution: 'partial',
      companyContributionReason: 'generation_scope_stale',
    });
    expect(result.hits[0]).toMatchObject({ title: 'ACME ROMANIA SRL', company: ACME_NOW });
  });

  it('an unpublished company scope serves no company value', async () => {
    const { deps } = setup(
      { page: page([staleCompanyHit(), ngoHit()]) },
      { scopes: [{ scopeKey: 'onrc:unpublished:-:0:11', published: false }], parents: PARENTS }
    );
    const result = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
    expect(result).toMatchObject({
      companyContribution: 'unavailable',
      companyContributionReason: 'registry_not_published',
    });
    expect(result.hits.map((h) => h.docKey)).toEqual(['789']);
  });

  it('an EMPTY page under a stale scope is partial, never a healthy current zero', async () => {
    const { deps, companies } = setup(
      { page: page([]) },
      { scopes: [{ scopeKey: SCOPE_B, published: true }] }
    );
    const result = (await makeGlobalSearch(deps, { q: 'nimic' }))._unsafeUnwrap();
    expect(result).toMatchObject({
      hits: [],
      companyContribution: 'partial',
      companyContributionReason: 'generation_scope_stale',
      continuation: { candidatesReturned: 0, nextOffset: null },
    });
    // The fresh scope is read for an empty page too.
    expect(companies.hydrations).toEqual([{ cuis: [], withValues: true }]);
  });

  it('a swap between the two control reads is retried once, then witnessed', async () => {
    const { deps, meili } = setup(
      { page: page([staleCompanyHit()]), controls: [CONTROL_A, CONTROL_B, CONTROL_B, CONTROL_B] },
      { scopes: [{ scopeKey: SCOPE_B, published: true }], parents: PARENTS }
    );
    const result = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
    expect(meili.searchEntities).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      generation: { registryScopeKey: SCOPE_B },
      companyContribution: 'current',
    });
  });

  it('a generation that keeps changing between the reads is unavailable', async () => {
    const { deps, meili } = setup({
      page: page([staleCompanyHit(), billHit()]),
      controls: [CONTROL_A, CONTROL_B, CONTROL_A, CONTROL_B],
    });
    const result = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
    expect(meili.searchEntities).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      generation: null,
      companyContribution: 'unavailable',
      companyContributionReason: 'control_incoherent',
    });
    expect(result.hits.map((h) => h.docType)).toEqual(['bill']);
  });

  it('an unreadable fresh check withholds every CUI identity (fail closed)', async () => {
    const { deps } = setup({ page: page(ALL_HITS()) }, { failHydrate: true });
    const result = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
    expect(result).toMatchObject({
      companyScope: null,
      companyContribution: 'unavailable',
      companyContributionReason: 'company_check_unavailable',
    });
    expect(result.hits).toEqual([billHit()]);
  });

  it('no company port: CUI identities are withheld, other documents served', async () => {
    const m = scriptedMeili({ page: page([ngoHit(), billHit()]) });
    const result = (
      await makeGlobalSearch({ meiliClient: m.client, meiliIndexes: ['entities'] }, { q: 'x' })
    )._unsafeUnwrap();
    expect(result.hits.map((h) => h.docType)).toEqual(['bill']);
    expect(result.companyContributionReason).toBe('company_check_unavailable');
  });

  it('an empty query is a syntactic no-search, not a proven zero', async () => {
    const { deps, meili, companies } = setup({});
    const result = (await makeGlobalSearch(deps, { q: '  ' }))._unsafeUnwrap();
    expect(result).toMatchObject({
      hits: [],
      companyContribution: 'unavailable',
      companyContributionReason: 'no_search',
      generation: null,
      companyScope: null,
    });
    expect(meili.readGenerationControl).not.toHaveBeenCalled();
    expect(companies.hydrations).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The candidate cache
// ─────────────────────────────────────────────────────────────────────────────

describe('the candidate cache', () => {
  it('a warm cache hit is hydrated fresh: name, public → private and access changes', async () => {
    const m = scriptedMeili({ page: page([staleCompanyHit()]) });
    const c = recordingCompanies({
      scopes: [
        { scopeKey: SCOPE_A, published: true },
        { scopeKey: SCOPE_A, published: true },
        { scopeKey: SCOPE_A, published: true },
        { scopeKey: 'onrc:published:42:3:18', published: true },
      ],
      parents: PARENTS,
    });
    const deps: GlobalSearchDeps = {
      meiliClient: m.client,
      meiliIndexes: ['entities'],
      companySearch: c.port,
      candidateCache: createCache({ ttlMs: 60_000, maxEntries: 10 }),
    };
    const search = async () => (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();

    expect((await search()).hits[0]?.title).toBe('ACME ROMANIA SRL');
    c.state.parents['123'] = { kind: 'company', values: { ...ACME_NOW, name: 'ACME NOU SRL' } };
    expect((await search()).hits[0]?.title).toBe('ACME NOU SRL');
    c.state.parents['123'] = { kind: 'private' };
    expect((await search()).hits).toEqual([]);
    c.state.parents['123'] = { kind: 'company', values: ACME_NOW };
    // The access epoch moved (18): the cached generation A is now stale.
    expect(await search()).toMatchObject({
      companyContribution: 'partial',
      companyScope: 'onrc:published:42:3:18',
    });
    // One engine fetch; four fresh hydrations.
    expect(m.searchEntities).toHaveBeenCalledTimes(1);
    expect(c.hydrations).toHaveLength(4);
  });

  it('is keyed by the generation: a new generation fetches again', async () => {
    const m = scriptedMeili({
      page: page([staleCompanyHit()]),
      controls: [CONTROL_A, CONTROL_A, CONTROL_B, CONTROL_B],
    });
    const deps: GlobalSearchDeps = {
      meiliClient: m.client,
      meiliIndexes: ['entities'],
      companySearch: recordingCompanies({ parents: PARENTS }).port,
      candidateCache: createCache({ ttlMs: 60_000, maxEntries: 10 }),
    };
    await makeGlobalSearch(deps, { q: 'acme' });
    await makeGlobalSearch(deps, { q: 'acme' });
    expect(m.searchEntities).toHaveBeenCalledTimes(2);
  });

  it('never caches an unwitnessed candidate answer', async () => {
    const m = scriptedMeili({ page: page([billHit()]), controls: [null] });
    const deps: GlobalSearchDeps = {
      meiliClient: m.client,
      meiliIndexes: ['entities'],
      companySearch: recordingCompanies({}).port,
      candidateCache: createCache({ ttlMs: 60_000, maxEntries: 10 }),
    };
    await makeGlobalSearch(deps, { q: 'lege' });
    await makeGlobalSearch(deps, { q: 'lege' });
    expect(m.searchEntities).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Estimates, continuation and the internal control
// ─────────────────────────────────────────────────────────────────────────────

describe('estimates and continuation', () => {
  it('a page whose candidates were all withheld still continues', async () => {
    const { deps } = setup(
      {
        page: page([staleCompanyHit(), ngoHit()], {
          estimatedTotalHits: 40,
          facetDistribution: { doc_type: { company: 25, ngo: 15 } },
        }),
      },
      { parents: { '123': { kind: 'private' }, '789': { kind: 'private' } } }
    );
    const result = (await makeGlobalSearch(deps, { q: 'acme', limit: 2 }))._unsafeUnwrap();
    expect(result.hits).toEqual([]);
    expect(result.continuation).toEqual({ candidatesReturned: 2, nextOffset: 2 });
    // Generation estimates, not post-hydration counts.
    expect(result.estimatedTotalHits).toBe(40);
    expect(result.facets).toEqual([
      { field: 'doc_type', value: 'company', count: 25 },
      { field: 'doc_type', value: 'ngo', count: 15 },
    ]);
  });

  it('stops at a short candidate page and at the offset bound', async () => {
    const short = setup({ page: page([billHit()]) });
    expect(
      (await makeGlobalSearch(short.deps, { q: 'lege', limit: 2 }))._unsafeUnwrap().continuation
    ).toEqual({ candidatesReturned: 1, nextOffset: null });
    const deep = setup({ page: page([billHit(), billHit()]) });
    expect(
      (await makeGlobalSearch(deep.deps, { q: 'lege', limit: 2, offset: 999 }))._unsafeUnwrap()
        .continuation
    ).toEqual({ candidatesReturned: 2, nextOffset: null });
  });

  it('never serves the internal control as a hit or a facet', async () => {
    const control = {
      ...billHit(),
      id: 'palette_generation_control',
      docType: 'palette_generation_control',
      docKey: 'palette_generation_control',
      attrs: { privacy_class: 'internal' },
    };
    const { deps } = setup({
      page: page([control, billHit()], {
        facetDistribution: { doc_type: { bill: 1, palette_generation_control: 1 } },
      }),
    });
    const result = (await makeGlobalSearch(deps, { q: 'lege' }))._unsafeUnwrap();
    expect(result.hits).toEqual([billHit()]);
    expect(result.facets).toEqual([{ field: 'doc_type', value: 'bill', count: 1 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The final decision
// ─────────────────────────────────────────────────────────────────────────────

describe('confirmGlobalSearchServed', () => {
  it('rechecks the captured scope and the served CUI identities (empty answers too)', async () => {
    const { deps, companies } = setup({ page: page(ALL_HITS()) });
    const result = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
    expect((await confirmGlobalSearchServed(deps, result)).isOk()).toBe(true);
    expect(companies.confirmations).toEqual([
      { scopeKey: SCOPE_A, cuis: ['123', '456', '789', '321'] },
    ]);

    const empty = setup({ page: page([]) });
    const none = (await makeGlobalSearch(empty.deps, { q: 'nimic' }))._unsafeUnwrap();
    await confirmGlobalSearchServed(empty.deps, none);
    expect(empty.companies.confirmations).toEqual([{ scopeKey: SCOPE_A, cuis: [] }]);
  });

  it('returns the refusal of a moved scope', async () => {
    const refusal = serviceUnavailable(
      'the ONRC registry publication or company access changed during the request; retry'
    );
    const { deps } = setup({ page: page([]) }, { confirm: () => err(refusal) });
    const result = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap();
    expect((await confirmGlobalSearchServed(deps, result))._unsafeUnwrapErr()).toEqual(refusal);
  });

  it('an answer without a captured scope served no identity: nothing to recheck', async () => {
    const { deps, companies } = setup({ page: page([billHit()]) }, { failHydrate: true });
    const result = (await makeGlobalSearch(deps, { q: 'lege' }))._unsafeUnwrap();
    expect((await confirmGlobalSearchServed(deps, result)).isOk()).toBe(true);
    expect(companies.confirmations).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R1 (api-repair-09): the privacy population is every canonical CUI identity
// ─────────────────────────────────────────────────────────────────────────────

/** `hit` without a `doc_key` (a malformed identity document). */
const keyless = (hit: SearchHit): SearchHit =>
  Object.fromEntries(
    Object.entries(hit).filter(([key]) => key !== 'docKey')
  ) as unknown as SearchHit;

describe('the privacy population is every canonical CUI identity, not the ONRC company shape', () => {
  const MIXED_PAGE = () => [
    shortKeyInstitutionHit(),
    shortKeyInstitutionHit({ id: 'organization_4', docKey: '4', title: 'PRIMARIA PATRU' }),
    staleCompanyHit(),
    registryNgoHit(),
    billHit(),
    shortKeyInstitutionHit({ id: 'org_0123', docKey: '0123', title: 'LEADING ZERO' }),
    shortKeyInstitutionHit({ id: 'org_long', docKey: '12345678901', title: 'OVERLENGTH' }),
    shortKeyInstitutionHit({ id: 'org_ro', docKey: 'RO1', title: 'PREFIXED' }),
    keyless(shortKeyInstitutionHit({ id: 'org_keyless', title: 'KEYLESS' })),
  ];

  it('a known private short-CUI parent withholds the independent institution; malformed keys are withheld unread', async () => {
    const { deps, companies } = setup(
      { page: page(MIXED_PAGE()) },
      {
        parents: {
          '1': { kind: 'private' },
          '4': { kind: 'none' },
          '123': { kind: 'company', values: ACME_NOW },
        },
      }
    );
    const result = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap();
    // The short CUIs are classified with the company page; malformed keys are never sent.
    expect(companies.hydrations).toEqual([{ cuis: ['1', '4', '123'], withValues: true }]);
    expect(result.hits.map((h) => h.docKey)).toEqual([
      '4',
      '123',
      'registry:12345',
      'PLx-100/2026',
    ]);
    expect(JSON.stringify(result.hits)).not.toMatch(
      /PRIVATE PARENT NAME|LEADING ZERO|OVERLENGTH|PREFIXED|KEYLESS/u
    );
    // The final check rechecks every served CUI identity, short ones included.
    await confirmGlobalSearchServed(deps, result);
    expect(companies.confirmations).toEqual([{ scopeKey: SCOPE_A, cuis: ['4', '123'] }]);
  });

  it('a healthy public short-CUI institution keeps its own role with no company part', async () => {
    const { deps } = setup({ page: page([shortKeyInstitutionHit()]) }, { parents: {} });
    const result = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap();
    expect(result.hits).toEqual([{ ...shortKeyInstitutionHit(), company: null }]);
    expect(result.companyContribution).toBe('current');
  });

  it('an unreadable or unregistered parent check withholds the short-CUI identity too', async () => {
    const hits = [shortKeyInstitutionHit(), registryNgoHit(), billHit()];
    const failed = setup({ page: page(hits) }, { failHydrate: true });
    expect(
      (await makeGlobalSearch(failed.deps, { q: 'x' }))._unsafeUnwrap().hits.map((h) => h.docKey)
    ).toEqual(['registry:12345', 'PLx-100/2026']);
    const m = scriptedMeili({ page: page(hits) });
    const unregistered = (
      await makeGlobalSearch({ meiliClient: m.client, meiliIndexes: ['entities'] }, { q: 'x' })
    )._unsafeUnwrap();
    expect(unregistered.hits.map((h) => h.docKey)).toEqual(['registry:12345', 'PLx-100/2026']);
  });

  it('a late private transition of a served short CUI reaches the final guard and refuses', async () => {
    const refusal = serviceUnavailable(
      'the ONRC registry publication or company access changed during the request; retry'
    );
    const { deps, companies } = setup(
      { page: page([shortKeyInstitutionHit()]) },
      { parents: {}, confirm: () => err(refusal) }
    );
    const result = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap();
    expect((await confirmGlobalSearchServed(deps, result))._unsafeUnwrapErr()).toEqual(refusal);
    expect(companies.confirmations).toEqual([{ scopeKey: SCOPE_A, cuis: ['1'] }]);
  });

  it('served CUI identities without a captured scope are refused, never passed unread', async () => {
    const { deps } = setup({ page: page([shortKeyInstitutionHit()]) }, { parents: {} });
    const result = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap();
    expect(
      (await confirmGlobalSearchServed(deps, { ...result, companyScope: null }))._unsafeUnwrapErr()
    ).toEqual(
      serviceUnavailable('the access of the served identities could not be rechecked; retry')
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 (api-repair-09): a warm cache hit takes both control reads fresh
// ─────────────────────────────────────────────────────────────────────────────

describe('a warm cache hit takes both control reads fresh', () => {
  const warm = (
    pages: readonly ReturnType<typeof page>[],
    controls: NonNullable<Parameters<typeof scriptedMeili>[0]['controls']>
  ) => {
    const m = scriptedMeili({ pages, controls });
    const c = recordingCompanies({ parents: PARENTS });
    const deps: GlobalSearchDeps = {
      meiliClient: m.client,
      meiliIndexes: ['entities'],
      companySearch: c.port,
      candidateCache: createCache({ ttlMs: 60_000, maxEntries: 10 }),
    };
    return { deps, meili: m, companies: c };
  };

  it('a generation swap during a cache return (same scope) is seen and retried onto the new generation', async () => {
    const { deps, meili, companies } = warm(
      [page([staleCompanyHit()]), page([ngoHit()])],
      [CONTROL_A, CONTROL_A, CONTROL_A, CONTROL_A2, CONTROL_A2, CONTROL_A2]
    );
    const first = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
    expect(first.hits.map((h) => h.docKey)).toEqual(['123']);
    // The cold path reads the control exactly twice.
    expect(meili.readGenerationControl).toHaveBeenCalledTimes(2);

    const second = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
    // Fresh before (A) + fresh after (A2) on the cache hit, then the retry's own pair.
    expect(meili.readGenerationControl).toHaveBeenCalledTimes(6);
    expect(meili.searchEntities).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({
      generation: {
        generationId: 'entities_build_1759601800000_zz99yy',
        registryScopeKey: SCOPE_A,
      },
      companyContribution: 'current',
    });
    // Generation A's cached candidates are not served as current.
    expect(second.hits.map((h) => h.docKey)).toEqual(['789']);
    expect(companies.hydrations).toHaveLength(2);
  });

  it('a swap that keeps going is incoherent: never the cached answer as current', async () => {
    const { deps } = warm(
      [page([staleCompanyHit()]), page([staleCompanyHit()])],
      [CONTROL_A, CONTROL_A, CONTROL_A, CONTROL_A2, CONTROL_A2, CONTROL_A]
    );
    await makeGlobalSearch(deps, { q: 'acme' });
    const second = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
    expect(second).toMatchObject({
      hits: [],
      generation: null,
      companyContribution: 'unavailable',
      companyContributionReason: 'control_incoherent',
    });
  });

  it('a failed after-read on a cached EMPTY page is never a healthy current zero', async () => {
    const { deps, meili } = warm([page([])], [CONTROL_A, CONTROL_A, CONTROL_A, UNREADABLE]);
    expect((await makeGlobalSearch(deps, { q: 'nimic' }))._unsafeUnwrap().companyContribution).toBe(
      'current'
    );
    const second = (await makeGlobalSearch(deps, { q: 'nimic' }))._unsafeUnwrap();
    expect(meili.searchEntities).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      hits: [],
      generation: null,
      companyContribution: 'unavailable',
      companyContributionReason: 'control_unreadable',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4 (api-repair-09): generic county of a mixed company + institution identity
// ─────────────────────────────────────────────────────────────────────────────

describe('generic county: an independent public institution fallback, ONRC company county kept', () => {
  const RATB_NO_COUNTY: SearchHitCompany = { ...RATB_NOW, countyCode: null, countyName: null };

  it('ONRC county unknown: the institution territory county is the generic county, company county stays null', async () => {
    const { deps } = setup(
      { page: page([mixedInstitutionHit()]) },
      {
        parents: {
          '456': { kind: 'company', values: RATB_NO_COUNTY, independentCountyName: 'Cluj' },
        },
      }
    );
    const [hit] = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap().hits;
    expect(hit).toMatchObject({
      countyName: 'Cluj',
      // The institution's own title, link, tags and identifiers are unchanged.
      title: 'REGIA AUTONOMA DE TRANSPORT',
      url: '/entitati/456',
      entityTags: ['kind::regie'],
      identifiers: ['456', 'RNONG-1', 'J12/9/1991'],
      company: { countyCode: null, countyName: null },
    });
  });

  it('a private or missing institution territory gives no label (the index county is never proof)', async () => {
    const { deps } = setup(
      { page: page([mixedInstitutionHit()]) },
      {
        parents: {
          '456': { kind: 'company', values: RATB_NO_COUNTY, independentCountyName: null },
        },
      }
    );
    const [hit] = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap().hits;
    expect(hit).not.toHaveProperty('countyName');
    expect(JSON.stringify(hit)).not.toContain('Bihor');
  });

  it('no institution role and no ONRC county: unknown', async () => {
    const { deps } = setup(
      { page: page([mixedInstitutionHit()]) },
      { parents: { '456': { kind: 'company', values: RATB_NO_COUNTY } } }
    );
    const [hit] = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap().hits;
    expect(hit).not.toHaveProperty('countyName');
  });

  it('the ONRC company county wins over the institution county', async () => {
    const { deps } = setup(
      { page: page([mixedInstitutionHit()]) },
      { parents: { '456': { kind: 'company', values: RATB_NOW, independentCountyName: 'Iași' } } }
    );
    const [hit] = (await makeGlobalSearch(deps, { q: 'x' }))._unsafeUnwrap().hits;
    expect(hit?.countyName).toBe('Cluj');
  });

  it('a company document: generic county from the institution, its subtitle stays ONRC-only', async () => {
    const { deps } = setup(
      { page: page([staleCompanyHit()]) },
      {
        parents: {
          '123': {
            kind: 'company',
            values: { ...ACME_NOW, countyCode: null, countyName: null },
            independentCountyName: 'Cluj',
          },
        },
      }
    );
    const [hit] = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap().hits;
    expect(hit).toMatchObject({
      countyName: 'Cluj',
      subtitle: 'SRL',
      snippet: 'SRL',
      company: { countyCode: null, countyName: null },
    });
  });

  it('no fallback while the company contribution is unavailable; a private parent is still a veto', async () => {
    const unavailable = setup(
      { page: page([mixedInstitutionHit()]), controls: [null] },
      {
        parents: {
          '456': { kind: 'company', values: RATB_NO_COUNTY, independentCountyName: 'Cluj' },
        },
      }
    );
    const [hit] = (await makeGlobalSearch(unavailable.deps, { q: 'x' }))._unsafeUnwrap().hits;
    expect(hit).not.toHaveProperty('countyName');

    const vetoed = setup(
      { page: page([mixedInstitutionHit()]) },
      { parents: { '456': { kind: 'private' } } }
    );
    expect((await makeGlobalSearch(vetoed.deps, { q: 'x' }))._unsafeUnwrap().hits).toEqual([]);
  });
});
