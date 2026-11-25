/**
 * Word search on the legal-v2 test indexes: the query bodies, the index
 * contract guard, hit grouping into acts, hydration from legal_v2 and the
 * bridged post-filters.
 */

import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { searchLegal } from '@/modules/legal/core/usecases.js';
import { mergeBridgedAct } from '@/modules/legal/core/v2/bridge.js';
import {
  buildV2ActsBody,
  buildV2UnitsBody,
  passesBridgedFilters,
  rankV2Acts,
  searchLegalV2Engine,
  splitV2Filter,
  type LegalV2HitVerifier,
  type LegalV2SearchEngine,
  type V2EngineHit,
} from '@/modules/legal/core/v2/search.js';
import { makeLegalV2SearchEngine } from '@/modules/legal/shell/repo/v2/search-engine-v2.js';
import { upstreamError } from '@/modules/shared/index.js';

import type { LegalActsRepo } from '@/modules/legal/core/ports.js';
import type { LegalActSummary } from '@/modules/legal/core/types.js';

const act = (id: string, status: string | null) =>
  mergeBridgedAct(
    {
      actId: id,
      actNaturalKey: `k${id}`,
      actType: 'lege',
      actNumber: id,
      actYear: 2020,
      issuerSlug: 'parlamentul',
      displayCitation: `Legea nr. ${id}/2020`,
      ended: false,
    },
    status === null
      ? null
      : { status: status as never, statusEvidence: {}, entryIntoForce: null, inDegree: 1 }
  );

const hit = (actId: string, citationPath: string | null = null, formId = '77'): V2EngineHit => ({
  actId,
  score: 1,
  citationPath,
  headingPath: null,
  snippet: citationPath === null ? null : `<em>${citationPath}</em>`,
  uses: [{ formId, unitId: '5', provisionSeq: 1, charStart: 0, charEnd: 10, contentKey: 'k1:a' }],
});

describe('query bodies', () => {
  it('filters public documents and the act facts the index holds', () => {
    const split = splitV2Filter(
      { actType: { in: ['lege'] }, issuerSlug: { eq: 'parlamentul' }, year: { eq: 2015 } },
      true
    );
    expect(split.unsupported).toEqual([]);
    const body = JSON.stringify(buildV2UnitsBody('impozit', split.engine, 100));
    expect(body).toContain('{"term":{"privacy_class":"public"}}');
    expect(body).toContain('{"terms":{"act_type":["lege"]}}');
    expect(body).toContain('{"terms":{"issuer_slug":["parlamentul"]}}');
    expect(body).toContain('{"term":{"act_year":2015}}');
    expect(body).toContain('"text.folded^0.5"');
    expect(body).not.toContain('knn');
    expect(JSON.stringify(buildV2ActsBody('codul fiscal', {}, 20))).toContain('act_name^1.5');
  });

  it('keeps status, domain and category for the hydrated page, and refuses what it cannot express', () => {
    const split = splitV2Filter(
      { status: { in: ['abrogat'] }, domain: { in: ['fiscal-si-bugetar'] } },
      true
    );
    expect(split.status).toEqual(['abrogat']);
    expect(split.domain).toEqual(['fiscal-si-bugetar']);
    expect(JSON.stringify(split.engine)).toBe('{}');
    expect(splitV2Filter({ q: { eq: 'x' } }, true).unsupported).toEqual(['q']);
  });

  it('treats an act the old corpus lacks as status necunoscut for the historical gate', () => {
    const live = splitV2Filter({}, false);
    expect(passesBridgedFilters(act('1', null), null, live)).toBe(true);
    expect(passesBridgedFilters(act('2', 'abrogat'), null, live)).toBe(false);
    const domain = splitV2Filter({ domain: { in: ['sanatate'] } }, true);
    const summary = { domains: ['sanatate'], documentCategory: null } as unknown as LegalActSummary;
    expect(passesBridgedFilters(act('3', 'in-vigoare'), summary, domain)).toBe(true);
    expect(passesBridgedFilters(act('4', null), null, domain)).toBe(false);
  });
});

describe('ranking', () => {
  it('lists name hits first, then acts reached through provisions, each with its provisions', () => {
    const ranked = rankV2Acts(
      [hit('5'), hit('6')],
      [hit('7', 'art:1'), hit('5', 'art:2'), hit('7', 'art:3')]
    );
    expect(ranked.order).toEqual(['5', '6', '7']);
    expect(ranked.sections.get('7')?.map((h) => h.citationPath)).toEqual(['art:1', 'art:3']);
  });
});

describe('the engine transport', () => {
  const answer = (hits: unknown[]) =>
    JSON.stringify({
      timed_out: false,
      _shards: { total: 1, successful: 1, failed: 0 },
      hits: { total: { value: hits.length, relation: 'eq' }, hits },
    });
  const mapping = (contract: string) =>
    JSON.stringify({
      idx: { mappings: { _meta: { index_contract: contract, built_at: '2026-11-18T10:00:00Z' } } },
    });

  it('reads the v2 indexes and refuses an index of another contract', async () => {
    const calls: string[] = [];
    const engine = makeLegalV2SearchEngine(
      { url: 'https://os', actsIndex: 'legal-v2-test-acts-20261118', unitsIndex: 'legal-sections' },
      (method, path) => {
        calls.push(`${method} ${path}`);
        if (path.endsWith('/_mapping')) {
          return Promise.resolve({
            status: 200,
            text: mapping(path.includes('acts') ? 'legal-v2-test/acts/1' : 'legal/sections/1'),
          });
        }
        return Promise.resolve({
          status: 200,
          text: answer([
            {
              _score: 2,
              _source: { act_id: 7, citation_path: 'art:1' },
              highlight: { text: ['<em>x</em>'] },
            },
          ]),
        });
      }
    );
    const acts = await engine.searchActs('x', {}, 5);
    expect(acts._unsafeUnwrap()).toMatchObject({ total: 1, asOf: '2026-11-18T10:00:00Z' });
    expect(acts._unsafeUnwrap().hits[0]).toMatchObject({ actId: '7', snippet: '<em>x</em>' });
    const units = await engine.searchUnits('x', {}, 5);
    expect(units._unsafeUnwrapErr().message).toContain('index is not legal-v2-test/units/1');
    expect(calls).toContain('GET /legal-v2-test-acts-20261118/_mapping');
  });

  it('accepts an answer without a total when the leg did not count', async () => {
    const engine = makeLegalV2SearchEngine(
      { url: 'https://os', actsIndex: 'legal-v2-test-acts-1', unitsIndex: 'u' },
      (_method, path) =>
        Promise.resolve(
          path.endsWith('/_mapping')
            ? { status: 200, text: mapping('legal-v2-test/acts/1') }
            : {
                status: 200,
                text: JSON.stringify({
                  _shards: { total: 1, successful: 1, failed: 0 },
                  hits: { hits: [{ _score: 1, _source: { act_id: 3 } }] },
                }),
              }
        )
    );
    expect((await engine.searchActs('x', {}, 5))._unsafeUnwrap()).toMatchObject({
      total: null,
      totalExhaustive: false,
    });
    expect(JSON.stringify(buildV2ActsBody('x', {}, 5))).toContain('"track_total_hits":false');
    expect(JSON.stringify(buildV2UnitsBody('x', {}, 5, false))).toContain(
      '"track_total_hits":false'
    );
  });

  it('fails on a 403, never substituting an answer', async () => {
    const engine = makeLegalV2SearchEngine(
      { url: 'https://os', actsIndex: 'a', unitsIndex: 'u' },
      () => Promise.resolve({ status: 403, text: '{}' })
    );
    expect((await engine.searchActs('x', {}, 5))._unsafeUnwrapErr().message).toContain('http 403');
  });
});

describe('searchLegalV2Engine', () => {
  const engine = (actsHits: V2EngineHit[], unitHits: V2EngineHit[]): LegalV2SearchEngine => ({
    searchActs: () =>
      Promise.resolve(
        ok({ hits: actsHits, total: actsHits.length, totalExhaustive: true, asOf: '2026-11-18' })
      ),
    searchUnits: () =>
      Promise.resolve(ok({ hits: unitHits, total: 40, totalExhaustive: true, asOf: '2026-11-18' })),
  });
  const repo = (
    known: ReturnType<typeof act>[],
    summaries: ReadonlyMap<string, LegalActSummary> = new Map()
  ): LegalActsRepo =>
    ({
      findActsByIds: (ids: readonly string[]) =>
        Promise.resolve(ok(known.filter((a) => ids.includes(a.actId)))),
      versionProvenanceForActs: () => Promise.resolve(ok(new Map())),
      // Summaries are read by act; a path through the default form would trip these.
      canonicalDocumentsForActs: () => Promise.reject(new Error('read through the default form')),
      summariesForDocuments: () => Promise.reject(new Error('read through the default form')),
      summariesForActs: (ids: readonly string[]) =>
        Promise.resolve(ok(new Map([...summaries].filter(([id]) => ids.includes(id))))),
    }) as unknown as LegalActsRepo;

  /** Verifies the uses whose form id is in `servable`; drops the rest. */
  const verifier = (servable: readonly string[]): LegalV2HitVerifier => ({
    verifyUses: (candidates) =>
      Promise.resolve(
        ok(
          new Map(
            candidates.flatMap((c) => {
              const use = c.uses.find((u) => servable.includes(u.formId));
              return use === undefined
                ? []
                : [
                    [
                      c.key,
                      {
                        use,
                        path: `b${use.formId}`,
                        composed: false,
                        charStart: 21,
                        charEnd: 24,
                        // The verified occurrence's own facts.
                        address: `art:v${use.formId}`,
                        label: 'Articolul verificat',
                        sameWording: use.formId === '77',
                        servedForm: {
                          versionKind: 'consolidare',
                          versionDate: '2024-03-01',
                          sourceUrl: null,
                          amendedAfterPublication: null,
                          latestConsolidationDate: null,
                          latestConsolidationLoaded: false,
                          documentId: `f${use.formId}`,
                          caveat: 'unofficial_consolidation',
                          portalLabelRaw: null,
                          portalLabelDate: '2024-03-01',
                        },
                      },
                    ] as const,
                  ];
            })
          )
        )
      ),
  });

  it('hydrates acts from legal_v2 and post-filters bridged status, counting nothing it drops', async () => {
    const res = await searchLegalV2Engine(
      {
        engine: engine([hit('1'), hit('2')], [hit('3', 'art:4'), hit('9', 'art:1')]),
        acts: repo([act('1', 'in-vigoare'), act('2', 'abrogat'), act('3', null)]),
        verifier: verifier(['77']),
        clientBaseUrl: 'https://t',
      },
      { q: 'x', filter: {}, channel: 'auto', includeHistorical: false, limit: 20 }
    );
    const value = res._unsafeUnwrap();
    expect(value.acts.map((h) => h.act.actId)).toEqual(['1', '3']);
    expect(value.unhydratedHits).toBe(0);
    // Displayed fields come from the verified occurrence, not the index doc.
    expect(
      value.sections.map((s) => [
        s.actId,
        s.sectionKey,
        s.nodePath,
        s.nodeLabel,
        s.documentId,
        s.snippet,
      ])
    ).toEqual([['3', 'art:v77', 'b77', 'Articolul verificat', 'f77', '<em>art:4</em>']]);
    expect(value.sections[0]).toMatchObject({ charStart: 21, charEnd: 24 });
    expect(value.sections[0]?.portalDeepLink).toBe(
      `https://t/legislation/acts/3?doc=${encodeURIComponent('"f77"')}`
    );
    expect(value.sections[0]?.servedForm).toMatchObject({
      documentId: 'f77',
      caveat: 'unofficial_consolidation',
      portalLabelDate: '2024-03-01',
    });
    expect(value).toMatchObject({
      engine: 'opensearch',
      actsTotal: null,
      sectionsTotal: null,
      totalsExhaustive: false,
      degraded: false,
    });
    expect(value.caveats).toContain('semantic search unavailable');
  });

  it('serves no wording it cannot verify, and drops an act reached only through it', async () => {
    const res = await searchLegalV2Engine(
      {
        engine: engine([], [hit('3', 'art:4', '66'), hit('4', 'art:9', '77')]),
        acts: repo([act('3', 'in-vigoare'), act('4', 'in-vigoare')]),
        verifier: verifier(['77']),
        clientBaseUrl: 'https://t',
      },
      { q: 'x', filter: {}, channel: 'auto', includeHistorical: true, limit: 20 }
    );
    const value = res._unsafeUnwrap();
    expect(value.acts.map((h) => h.act.actId)).toEqual(['4']);
    expect(value.sections.map((s) => s.snippet)).toEqual(['<em>art:9</em>']);
    expect(JSON.stringify(value)).not.toContain('art:4');
  });

  it('merges the act amendment facts into the section provenance, and withholds a snippet of other wording', async () => {
    const prov = {
      versionKind: 'consolidare',
      versionDate: '2024-03-01',
      sourceUrl: null,
      amendedAfterPublication: 5,
      latestConsolidationDate: '2025-01-01',
      latestConsolidationLoaded: true,
    };
    const res = await searchLegalV2Engine(
      {
        engine: engine([], [hit('3', 'art:4', '78')]),
        acts: {
          ...repo([act('3', 'in-vigoare')]),
          versionProvenanceForActs: () => Promise.resolve(ok(new Map([['3', prov]]))),
        },
        verifier: verifier(['78']),
        clientBaseUrl: 'https://t',
      },
      { q: 'x', filter: {}, channel: 'auto', includeHistorical: true, limit: 20 }
    );
    const section = res._unsafeUnwrap().sections[0];
    expect(section?.servedForm).toMatchObject({
      documentId: 'f78',
      amendedAfterPublication: 5,
      latestConsolidationDate: '2025-01-01',
    });
    expect(section?.snippet).toBeNull();
  });

  it('keeps the bridged summary by act, so a domain filter keeps an act without a readable default form', async () => {
    // Act 10 has a readable older form only; act 12 has no v2 text. Both have a bridged summary.
    const fiscal = {
      domains: ['fiscal-si-bugetar'],
      documentCategory: 'cod',
    } as unknown as LegalActSummary;
    const res = await searchLegalV2Engine(
      {
        engine: engine([hit('12')], [hit('10', 'art:2', '110')]),
        acts: repo(
          [act('10', 'in-vigoare'), act('12', 'in-vigoare'), act('13', 'in-vigoare')],
          new Map([
            ['10', fiscal],
            ['12', fiscal],
          ])
        ),
        verifier: verifier(['110']),
        clientBaseUrl: 'https://t',
      },
      {
        q: 'x',
        filter: { domain: { in: ['fiscal-si-bugetar'] } },
        channel: 'auto',
        includeHistorical: true,
        limit: 20,
      }
    );
    const value = res._unsafeUnwrap();
    expect(value.acts.map((h) => [h.act.actId, h.summary?.domains])).toEqual([
      ['12', ['fiscal-si-bugetar']],
      ['10', ['fiscal-si-bugetar']],
    ]);
    expect(value.sections.map((s) => [s.actId, s.documentId])).toEqual([['10', 'f110']]);
  });

  it('fails closed on a repo without by-act summaries', async () => {
    const legacy: LegalActsRepo = { ...repo([act('1', 'in-vigoare')]) };
    delete legacy.summariesForActs;
    const res = await searchLegalV2Engine(
      {
        engine: engine([hit('1')], []),
        acts: legacy,
        verifier: verifier([]),
        clientBaseUrl: 'https://t',
      },
      { q: 'x', filter: {}, channel: 'auto', includeHistorical: true, limit: 5 }
    );
    expect(res._unsafeUnwrapErr()).toMatchObject({ type: 'ServiceUnavailable' });
  });

  it('passes an engine failure through', async () => {
    const failing: LegalV2SearchEngine = {
      searchActs: () => Promise.resolve(err(upstreamError('boom', 'opensearch'))),
      searchUnits: () =>
        Promise.resolve(ok({ hits: [], total: 0, totalExhaustive: true, asOf: 'x' })),
    };
    const res = await searchLegalV2Engine(
      { engine: failing, acts: repo([]), verifier: verifier([]), clientBaseUrl: 'https://t' },
      { q: 'x', filter: {}, channel: 'docs', includeHistorical: true, limit: 5 }
    );
    expect(res.isErr()).toBe(true);
  });
});

describe('fail closed without the v2 indexes', () => {
  it('answers ServiceUnavailable for words, never the legacy retrieval or the embedder', async () => {
    const touched: string[] = [];
    const trap = new Proxy(
      {},
      {
        get: (_t, prop) => {
          touched.push(String(prop));
          return () => Promise.reject(new Error(`touched ${String(prop)}`));
        },
      }
    );
    const res = await searchLegal(
      {
        retrieval: trap as never,
        acts: trap as never,
        synthetic: trap as never,
        capabilities: trap as never,
        embeddingModel: 'm',
        semanticReady: true,
        clientBaseUrl: 'https://t',
        v2Mode: true,
      },
      { q: 'impozit pe venit', filter: {}, channel: 'auto', includeHistorical: false, limit: 5 }
    );
    expect(res._unsafeUnwrapErr()).toMatchObject({ type: 'ServiceUnavailable' });
    expect(touched).toEqual([]);
  });
});
