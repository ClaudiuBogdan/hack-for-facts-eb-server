/**
 * Companies repo — `resolveByName` Meili branch (the F11 re-point).
 *
 * Pins the palette-index contract that replaced the retired
 * `multiSearch(['organizations','companies'])` path
 * (SEARCH_LAYER_REVIEW_2026-08-25.md F11/D9): the query goes to the
 * CONFIGURED palette index with the privacy-pinned, role-filtered array
 * filter, and the CUI comes from `hit.docKey` (palette docs carry no
 * `attrs.cui` — that was the retired per-source shape).
 */

import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';
import { upstreamError } from '@/modules/shared/core/errors.js';

import type { MeiliClient } from '@/modules/shared/index.js';

/** Minimal chainable Kysely stub: every builder step returns itself. */
const makeDbStub = (rows: readonly Record<string, unknown>[]) => {
  const chain: Record<string, unknown> = {};
  for (const step of ['selectFrom', 'select', 'where', 'limit', 'offset', 'orderBy']) {
    chain[step] = vi.fn(() => chain);
  }
  chain['execute'] = vi.fn(async () => rows);
  chain['executeTakeFirst'] = vi.fn(async () => rows[0]);
  return chain;
};

describe('resolveByName over the palette index', () => {
  it('queries the configured index with the privacy-pinned company-role filter and resolves via docKey', async () => {
    const searchEntities = vi.fn(async () =>
      ok({
        hits: [
          {
            id: 'company_2816464_x',
            docType: 'company',
            title: 'DEDEMAN SRL',
            snippet: null,
            score: 0.66,
            source: 'meili' as const,
            attrs: {},
            docKey: '2816464',
            cuis: ['2816464'],
          },
        ],
        facetDistribution: {},
        estimatedTotalHits: 1,
      })
    );
    const meili = { searchEntities, healthCheck: vi.fn() } as unknown as MeiliClient;
    const db = makeDbStub([{ cui: '2816464', name: 'DEDEMAN SRL' }]);

    const repo = makeCompaniesRepo(db as never, { meiliEntitiesIndex: 'entities' });
    const res = await repo.resolveByName('dedeman', 8, meili);

    expect(searchEntities).toHaveBeenCalledWith('dedeman', 'entities', {
      filter: ['privacy_class = "public"', 'roles IN ["company"]'],
      limit: 8,
    });
    const { hits, degraded } = res._unsafeUnwrap();
    expect(degraded).toBe(false);
    expect(hits).toEqual([
      {
        dim: 'name',
        value: '2816464',
        label: 'DEDEMAN SRL',
        cui: '2816464',
        confidence: 0.66,
      },
    ]);
  });

  it('drops a hit whose CUI fails the kind=company validation', async () => {
    const searchEntities = vi.fn(async () =>
      ok({
        hits: [
          {
            id: 'organization_4305857_x',
            docType: 'organization',
            title: 'MUNICIPIUL CLUJ-NAPOCA',
            snippet: null,
            score: 0.9,
            source: 'meili' as const,
            attrs: {},
            docKey: '4305857',
            cuis: ['4305857'],
          },
        ],
        facetDistribution: {},
        estimatedTotalHits: 1,
      })
    );
    const meili = { searchEntities, healthCheck: vi.fn() } as unknown as MeiliClient;
    // The validation query returns no kind='company' row for this CUI, so the
    // Meili branch yields nothing and the repo falls through to the pg path —
    // whose own query also returns [] here. The engine answered, so this is
    // NOT a degraded read (M42): `degraded` reports an engine outage, not an
    // empty answer, and the usecase turns it into a "search service
    // unavailable" caveat that would be false here.
    const db = makeDbStub([]);

    const repo = makeCompaniesRepo(db as never, { meiliEntitiesIndex: 'entities' });
    const res = await repo.resolveByName('cluj', 8, meili);

    const { hits, degraded } = res._unsafeUnwrap();
    expect(hits).toEqual([]);
    expect(degraded).toBe(false);
  });

  it('reports degraded only when the engine itself failed', async () => {
    const searchEntities = vi.fn(async () =>
      err(upstreamError('meili unreachable', 'meilisearch'))
    );
    const meili = { searchEntities, healthCheck: vi.fn() } as unknown as MeiliClient;
    const db = makeDbStub([]);

    const repo = makeCompaniesRepo(db as never, { meiliEntitiesIndex: 'entities' });
    const res = await repo.resolveByName('cluj', 8, meili);

    expect(res._unsafeUnwrap().degraded).toBe(true);
    expect(searchEntities).toHaveBeenCalledTimes(1);
  });

  it('reports degraded when no engine is configured at all', async () => {
    const repo = makeCompaniesRepo(makeDbStub([]) as never, { meiliEntitiesIndex: 'entities' });
    const res = await repo.resolveByName('cluj', 8, null);
    expect(res._unsafeUnwrap().degraded).toBe(true);
  });
});
