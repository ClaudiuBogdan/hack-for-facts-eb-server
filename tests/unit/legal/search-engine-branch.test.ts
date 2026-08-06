/**
 * Which path answered, and does the answer say so.
 *
 * `legalSearch` has one entry point and two retrieval paths. The rule is that
 * the CHOICE is never invisible: an engine-served answer reports
 * `engine: 'opensearch'` with real totals, a Postgres-served one reports
 * `engine: 'postgres'` and refuses to invent a total. The failure this guards
 * against is the platform's oldest one — a silent substitution that answers a
 * different question under the same label.
 */

import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { searchLegal, type LegalSearchDeps } from '@/modules/legal/core/usecases.js';

import type {
  LegalEnginePage,
  LegalRetrievalQuery,
  LegalSearchEngine,
} from '@/modules/legal/core/ports.js';
import type { LegalAct } from '@/modules/legal/core/types.js';

const act: LegalAct = {
  actId: '1',
  actNaturalKey: 'lege/2001/1',
  actType: 'lege',
  actNumber: '1',
  actYear: 2001,
  issuerSlug: 'parlamentul',
  canonicalDocumentId: 'd1',
  displayCitation: 'Legea nr. 1/2001',
  status: 'in-vigoare',
  statusEvidence: {},
  entryIntoForce: null,
  inDegree: 0,
};

const enginePage: LegalEnginePage = {
  hits: [{ documentId: 'd1', actId: '1', sectionKey: null, snippet: null }],
  total: 128,
  totalExhaustive: true,
  asOf: '2026-08-06T04:00:00Z',
};

const engine: LegalSearchEngine = {
  canServeActs: () => true,
  canServeSections: () => false,
  searchActsBm25: () => Promise.resolve(ok(enginePage)),
  searchSectionsBm25: () => Promise.resolve(ok({ ...enginePage, hits: [] })),
  searchSectionsKnn: () => Promise.resolve(ok({ ...enginePage, hits: [] })),
};

const deps = (over: { engine?: LegalSearchEngine }): LegalSearchDeps =>
  ({
    retrieval: {
      searchSections: () => Promise.resolve(ok([])),
      searchDocs: () => Promise.resolve(ok([])),
      hydrateSections: () => Promise.resolve(ok(new Map())),
    },
    acts: {
      getActCard: () => Promise.resolve(ok(null)),
      findActsByIds: () => Promise.resolve(ok([act])),
      summariesForDocuments: () => Promise.resolve(ok(new Map())),
      versionProvenanceForActs: () => Promise.resolve(ok(new Map())),
    },
    synthetic: { embed: () => Promise.resolve(ok([0.1])) },
    capabilities: { forDomain: () => ({ semantic: false }) },
    embeddingModel: 'test-model',
    semanticReady: false,
    clientBaseUrl: 'https://transparenta.eu',
    ...(over.engine !== undefined && { engine: over.engine }),
  }) as unknown as LegalSearchDeps;

const query: LegalRetrievalQuery = {
  q: 'taxe locale',
  filter: {},
  channel: 'docs',
  includeHistorical: true,
  limit: 10,
};

describe('legalSearch — the answer names the path that produced it', () => {
  it('uses the engine when one is configured, and reports a real total', async () => {
    const res = await searchLegal(deps({ engine }), query);
    expect(res.isOk()).toBe(true);
    if (!res.isOk()) return;
    expect(res.value.engine).toBe('opensearch');
    expect(res.value.actsTotal).toBe(128);
    expect(res.value.totalsExhaustive).toBe(true);
    expect(res.value.asOf).toBe('2026-08-06T04:00:00Z');
    expect(res.value.acts).toHaveLength(1);
  });

  it('falls to Postgres when no engine is configured, and reports NO total', async () => {
    const res = await searchLegal(deps({}), query);
    expect(res.isOk()).toBe(true);
    if (!res.isOk()) return;
    expect(res.value.engine).toBe('postgres');
    // A bounded slice is not a count, and must never be passed off as one.
    expect(res.value.actsTotal).toBeNull();
    expect(res.value.totalsExhaustive).toBe(false);
  });

  it('refuses a filter the engine cannot express rather than widening it', async () => {
    const res = await searchLegal(deps({ engine }), {
      ...query,
      filter: { exclude: { actType: { in: ['ordin'] } } },
    });
    expect(res.isErr()).toBe(true);
  });

  it('does not reach the engine at all for an identifier lookup', async () => {
    let called = false;
    const watched: LegalSearchEngine = {
      ...engine,
      searchActsBm25: () => {
        called = true;
        return Promise.resolve(ok(enginePage));
      },
    };
    const cardDeps = deps({ engine: watched });
    const withCard = {
      ...cardDeps,
      acts: {
        ...cardDeps.acts,
        getActCard: () =>
          Promise.resolve(
            ok({ ...act, summary: null, aliases: [], citationKeys: [], amendedAfterPublication: 0 })
          ),
      },
    } as unknown as LegalSearchDeps;
    const res = await searchLegal(withCard, { ...query, q: 'legea 1/2001' });
    expect(res.isOk()).toBe(true);
    if (!res.isOk()) return;
    // A citation resolves to exactly one act by name; retrieval never runs.
    expect(called).toBe(false);
    expect(res.value.engine).toBe('postgres');
    expect(res.value.actsTotal).toBe(1);
  });
});
