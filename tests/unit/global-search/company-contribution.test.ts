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

import { describe, expect, it } from 'vitest';

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
  CONTROL_B,
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

import type { SearchHitCompany } from '@/modules/shared/core/types.js';

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

describe('Meili-only company serving', () => {
  it('serves the witnessed projected values without invoking either database port', async () => {
    const { deps, companies } = setup({ page: page(ALL_HITS()) });
    const result = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
    expect(result.companyContribution).toBe('current');
    expect(result.hits[0]).toMatchObject({
      title: 'ACME OLD SRL',
      countyName: 'Bihor',
      company: {
        name: 'ACME OLD SRL',
        countyCode: 'BH',
        active: false,
        identifiers: ['J05/1/1999'],
      },
    });
    expect(result.hits.map((hit) => hit.docType)).toEqual([
      'company',
      'organization',
      'ngo',
      'public_enterprise',
      'bill',
    ]);
    expect((await confirmGlobalSearchServed(deps, result)).isOk()).toBe(true);
    expect(companies.hydrations).toEqual([]);
    expect(companies.confirmations).toEqual([]);
    expect(companies.accessReads).toBe(2);
  });

  it('uses the current privacy mirror even when engine candidates were cached', async () => {
    const { deps, companies, meili } = setup({ page: page([staleCompanyHit()]) });
    const cached = { ...deps, candidateCache: createCache({ ttlMs: 60_000, maxEntries: 100 }) };
    expect((await makeGlobalSearch(cached, { q: 'acme' }))._unsafeUnwrap().hits).toHaveLength(1);
    companies.state.parents['123'] = { kind: 'private' };
    expect((await makeGlobalSearch(cached, { q: 'acme' }))._unsafeUnwrap().hits).toEqual([]);
    expect(meili.searchEntities).toHaveBeenCalledTimes(1);
    expect(companies.hydrations).toEqual([]);
  });

  it('withholds company values when the background scope changes, retaining separable other roles', async () => {
    const { deps } = setup(
      { page: page(ALL_HITS()) },
      { scopes: [{ scopeKey: SCOPE_B, published: true }] }
    );
    const result = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
    expect(result).toMatchObject({
      companyContribution: 'unavailable',
      companyContributionReason: 'generation_scope_stale',
    });
    expect(result.hits.some((hit) => hit.docType === 'company')).toBe(false);
    expect(result.hits.find((hit) => hit.docType === 'organization')?.company).toBeNull();
    expect(result.hits.find((hit) => hit.docType === 'ngo')?.title).toBe('ASOCIATIA PRIETENII');
  });

  it.each([null])(
    'withholds CUI identities without a current access snapshot (%s)',
    async (snapshot) => {
      const { deps } = setup({
        page: page([staleCompanyHit(), ngoHit(), billHit(), registryNgoHit()]),
      });
      const result = (
        await makeGlobalSearch(
          {
            ...deps,
            companySearch: { ...deps.companySearch!, readAccessSnapshot: () => snapshot },
          },
          { q: 'acme' }
        )
      )._unsafeUnwrap();
      expect(result.hits.map((hit) => hit.docType)).toEqual(['bill', 'ngo']);
      expect(result.companyContribution).toBe('unavailable');
    }
  );

  it.each([null, UNREADABLE, { ...CONTROL_A, projection_version: 'unsupported' }] as const)(
    'withholds all CUI identities without a witnessed generation',
    async (control) => {
      const { deps } = setup({
        page: page([staleCompanyHit(), shortKeyInstitutionHit(), billHit()]),
        controls: [control],
      });
      const result = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
      expect(result.hits.map((hit) => hit.docType)).toEqual(['bill']);
    }
  );

  it('vetoes private parents of every role including short CUIs', async () => {
    const { deps } = setup(
      { page: page([staleCompanyHit(), ngoHit(), shortKeyInstitutionHit(), billHit()]) },
      {
        parents: {
          '123': { kind: 'private' },
          '789': { kind: 'private' },
          '1': { kind: 'private' },
        },
      }
    );
    expect((await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap().hits).toEqual([billHit()]);
  });

  it('rejects a malformed company projection and personal-shaped identifiers', async () => {
    const hit = staleCompanyHit();
    const { deps } = setup({
      page: page([{ ...hit, attrs: { ...hit.attrs, company_active: 'yes' } }, billHit()]),
    });
    expect((await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap().hits).toEqual([billHit()]);
    const safe = setup({
      page: page([
        {
          ...hit,
          attrs: {
            ...hit.attrs,
            company_identifiers: ['J05/1/1999', 'RO1234567890123', '1234567890123'],
          },
        },
      ]),
    });
    expect(
      (await makeGlobalSearch(safe.deps, { q: 'acme' }))._unsafeUnwrap().hits[0]?.company
        ?.identifiers
    ).toEqual(['J05/1/1999']);
  });

  it('preserves unknown company activity', async () => {
    const hit = staleCompanyHit();
    const { deps } = setup({
      page: page([{ ...hit, isActive: null, attrs: { ...hit.attrs, company_active: null } }]),
    });
    expect(
      (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap().hits[0]?.company?.active
    ).toBeNull();
  });

  it('refuses final serialization if access expires, a scope moves or a CUI becomes private', async () => {
    for (const change of ['expired', 'scope', 'private'] as const) {
      const { deps, companies } = setup({ page: page([staleCompanyHit()]) });
      const result = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();
      if (change === 'private') companies.state.parents['123'] = { kind: 'private' };
      const port =
        change === 'expired'
          ? { ...companies.port, readAccessSnapshot: () => null }
          : change === 'scope'
            ? {
                ...companies.port,
                readAccessSnapshot: () => ({
                  scopeKey: SCOPE_B,
                  published: true,
                  privateCuis: new Set<string>(),
                  privateInstitutionCuis: new Set<string>(),
                }),
              }
            : companies.port;
      expect((await confirmGlobalSearchServed({ companySearch: port }, result)).isErr()).toBe(true);
      expect(companies.confirmations).toEqual([]);
    }
  });
});
