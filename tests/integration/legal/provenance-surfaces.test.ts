/**
 * Legal — the §5.2-C provenance boundaries, over fakes (no DB, always runs).
 *
 * These cover what unit tests of the pure renderer cannot: that the SDL declares
 * the fields NON-NULL, that GraphQL resolves a whole page of acts with ONE
 * provenance batch rather than one query per act, and that all three MCP
 * provenance surfaces emit machine-readable caveats instead of prose only.
 *
 * The live-DB golden test (`legal-golden.test.ts`) stays env-gated; the SQL
 * behaviour these fakes stand in for is pinned by `mapProvenance` row tests in
 * `tests/unit/legal/provenance.test.ts`.
 */

import { buildSchema } from 'graphql';
import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { LEGAL_ORIGINAL_TEXT_CAVEAT } from '@/modules/legal/core/provenance.js';
import { makeLegalResolvers } from '@/modules/legal/shell/graphql/resolvers.js';
import { legalTypeDefs } from '@/modules/legal/shell/graphql/typedefs.js';
import { makeLegalMcpTools } from '@/modules/legal/shell/mcp/tools.js';

import type { LegalActsRepo, LegalOutlineRepo } from '@/modules/legal/core/ports.js';
import type {
  LegalAct,
  LegalActCard,
  LegalDocHit,
  LegalVersionProvenance,
} from '@/modules/legal/core/types.js';
import type { LegalSearchDeps } from '@/modules/legal/core/usecases.js';
import type { KernelMcpTool } from '@/modules/shared/index.js';

const SOURCE_URL = 'https://legislatie.just.ro/Public/DetaliiDocument/171282';

const provenance = (over: Partial<LegalVersionProvenance> = {}): LegalVersionProvenance => ({
  versionKind: 'corp',
  versionDate: '2015-09-10',
  sourceUrl: SOURCE_URL,
  amendedAfterPublication: 295,
  latestConsolidationDate: null,
  latestConsolidationLoaded: false,
  ...over,
});

const act = (actId: string): LegalAct => ({
  actId,
  actNaturalKey: `lege:${actId}:2015:`,
  actType: 'lege',
  actNumber: '227',
  actYear: 2015,
  issuerSlug: 'parlamentul',
  canonicalDocumentId: '171282',
  displayCitation: `Legea nr. ${actId}/2015`,
  status: 'in-vigoare',
  statusEvidence: {},
  entryIntoForce: '2015-09-10',
  inDegree: 10,
});

const card = (): LegalActCard => ({
  ...act('66150'),
  status: 'abrogat-partial',
  canonical: null,
  summary: null,
  aliases: ['codul fiscal'],
  citationKeys: [],
  versionCount: 2,
  amendedAfterPublication: 295,
});

/** A repo fake that counts how many times each provenance path is hit. */
const makeActsFake = (): { repo: LegalActsRepo; forActs: ReturnType<typeof vi.fn> } => {
  const forActs = vi.fn(async (actIds: readonly string[]) =>
    ok(new Map(actIds.map((id) => [id, provenance()])))
  );
  const repo = {
    getActCard: async () => ok(card()),
    versionProvenanceForActs: forActs,
    versionProvenanceForDocument: async () =>
      ok(provenance({ versionKind: 'republicare', versionDate: '2009-04-29' })),
    countAmendmentsAfter: async () => {
      throw new Error('countAmendmentsAfter must not be called — use the batched loader');
    },
  } as unknown as LegalActsRepo;
  return { repo, forActs };
};

const outlineFake = {
  entryByPath: async () =>
    ok({
      documentId: '171282',
      path: '1',
      nodeKind: 'articol',
      label: 'Articolul 1',
      numberKey: '1',
      numberSystem: 'arabic',
      numberStatus: null,
      depth: 7,
      orderIndex: 0,
      charStart: 0,
      charEnd: 100,
    }),
  outline: async () => ok({ items: [], next: null }),
  entryByArticle: async () => ok(null),
} as unknown as LegalOutlineRepo;

const searchDepsWith = (docs: readonly LegalDocHit[], repo: LegalActsRepo): LegalSearchDeps =>
  ({
    retrieval: {
      searchSections: async () => ok([]),
      searchDocs: async () => ok(docs),
    },
    acts: repo,
    synthetic: { embed: async () => ok([0.1]) },
    capabilities: { engines: {}, forDomain: () => ({ semantic: false }) },
    embeddingModel: 'nomic-embed-text-v1.5',
    semanticReady: false,
    clientBaseUrl: 'https://transparenta.eu',
  }) as unknown as LegalSearchDeps;

const toolNamed = (tools: readonly KernelMcpTool[], name: string): KernelMcpTool => {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`tool ${name} not registered`);
  return found;
};

// ── SDL contract ──────────────────────────────────────────────────────────────

describe('legal SDL — provenance fields are non-null', () => {
  const schema = buildSchema(`
    scalar BigInt
    scalar JSON
    scalar Date
    type PageInfo { hasNextPage: Boolean!, endCursor: String }
    type Query { _root: String }
    ${legalTypeDefs}
  `);

  const fieldType = (typeName: string, field: string): string => {
    const type = schema.getType(typeName);
    if (type === undefined || type === null) throw new Error(`${typeName} not declared`);
    const fields = (type as { getFields: () => Record<string, { type: unknown }> }).getFields();
    const f = fields[field];
    if (f === undefined) throw new Error(`${typeName}.${field} not declared`);
    return String(f.type);
  };

  it('LegalAct exposes both provenance fields as non-null', () => {
    expect(fieldType('LegalAct', 'versionProvenance')).toBe('LegalVersionProvenance!');
    expect(fieldType('LegalAct', 'textProvenance')).toBe('String!');
  });

  it('LegalVersionProvenance pins nullability per field', () => {
    expect(fieldType('LegalVersionProvenance', 'versionKind')).toBe('String!');
    expect(fieldType('LegalVersionProvenance', 'amendedAfterPublication')).toBe('Int!');
    expect(fieldType('LegalVersionProvenance', 'latestConsolidationLoaded')).toBe('Boolean!');
    // nullable: absent today, and absent is the honest answer
    expect(fieldType('LegalVersionProvenance', 'sourceUrl')).toBe('String');
    expect(fieldType('LegalVersionProvenance', 'latestConsolidationDate')).toBe('Date');
  });
});

// ── GraphQL resolvers ─────────────────────────────────────────────────────────

describe('LegalAct provenance resolvers', () => {
  const resolversFor = (repo: LegalActsRepo): Record<string, (p: LegalAct) => Promise<unknown>> => {
    const r = makeLegalResolvers({
      acts: repo,
      graph: {} as never,
      outline: outlineFake,
      searchDeps: searchDepsWith([], repo),
      resolveDeps: {} as never,
    });
    return (r as { LegalAct: Record<string, (p: LegalAct) => Promise<unknown>> }).LegalAct;
  };

  it('versionProvenance returns every non-null field populated', async () => {
    const { repo } = makeActsFake();
    const value = (await resolversFor(repo)['versionProvenance']?.(
      act('66150')
    )) as LegalVersionProvenance;
    expect(value.versionKind).toBe('corp');
    expect(value.amendedAfterPublication).toBe(295);
    expect(value.latestConsolidationLoaded).toBe(false);
    expect(value.sourceUrl).toBe(SOURCE_URL);
  });

  it('an act with no provenance row still answers with a complete object', async () => {
    const repo = {
      versionProvenanceForActs: async () => ok(new Map()),
    } as unknown as LegalActsRepo;
    const value = (await resolversFor(repo)['versionProvenance']?.(
      act('999')
    )) as LegalVersionProvenance;
    expect(value.versionKind).toBe('');
    expect(value.amendedAfterPublication).toBe(0);
    expect(value.latestConsolidationLoaded).toBe(false);
  });

  it('resolves a whole page of acts with ONE provenance batch', async () => {
    const { repo, forActs } = makeActsFake();
    const fields = resolversFor(repo);
    await Promise.all(['1', '2', '3'].map(async (id) => fields['versionProvenance']?.(act(id))));
    expect(forActs).toHaveBeenCalledTimes(1);
    expect(forActs).toHaveBeenCalledWith(['1', '2', '3']);
  });

  it('amendedAfterPublication reads the card when present — no repo call at all', async () => {
    const { repo, forActs } = makeActsFake();
    const value = await resolversFor(repo)['amendedAfterPublication']?.(card());
    expect(value).toBe(295);
    expect(forActs).not.toHaveBeenCalled();
  });

  it('amendedAfterPublication falls back to the batched loader, never a per-act count', async () => {
    const { repo, forActs } = makeActsFake();
    const value = await resolversFor(repo)['amendedAfterPublication']?.(act('66150'));
    expect(value).toBe(295);
    expect(forActs).toHaveBeenCalledTimes(1);
  });

  it('textProvenance renders the note and links only to the portal', async () => {
    const { repo } = makeActsFake();
    const note = (await resolversFor(repo)['textProvenance']?.(act('66150'))) as string;
    expect(note).toContain('modificat de 295 de ori de atunci');
    expect(note).toContain(SOURCE_URL);
    expect(note).not.toContain('transparenta.eu');
  });
});

// ── MCP surfaces ──────────────────────────────────────────────────────────────

describe('MCP provenance envelopes', () => {
  const toolsFor = (repo: LegalActsRepo, docs: readonly LegalDocHit[] = []) =>
    makeLegalMcpTools({
      acts: repo,
      graph: {} as never,
      outline: outlineFake,
      searchDeps: searchDepsWith(docs, repo),
      resolveDeps: {} as never,
      clientBaseUrl: 'https://transparenta.eu',
    });

  const metaOf = (out: {
    meta?: Readonly<Record<string, unknown>>;
  }): Readonly<Record<string, unknown>> => {
    if (out.meta === undefined) throw new Error('tool returned no meta envelope');
    return out.meta;
  };

  it('get_legal_act carries machine-readable caveats, not only prose', async () => {
    const { repo } = makeActsFake();
    const out = await toolNamed(toolsFor(repo), 'get_legal_act').handler({ actId: '66150' });
    const meta = metaOf(out);
    expect(meta['caveats']).toEqual([
      expect.stringContaining('modificat de 295 de ori de atunci'),
      LEGAL_ORIGINAL_TEXT_CAVEAT,
    ]);
    expect(meta['textProvenance']).toContain(SOURCE_URL);
    expect(meta['versionProvenance']).toMatchObject({ versionKind: 'corp' });
  });

  it("get_legal_node stamps the addressed document's own version, neutrally worded", async () => {
    const { repo } = makeActsFake();
    const out = await toolNamed(toolsFor(repo), 'get_legal_node').handler({
      documentId: '105215',
      path: '1',
    });
    const meta = metaOf(out);
    const note = meta['textProvenance'] as string;
    // a republication is a LATER expression: no "de atunci" over-claim
    expect(note).toContain('text republicat din 2009-04-29');
    expect(note).toContain('operațiuni de modificare/completare înregistrate pentru act');
    expect(note).not.toContain('de atunci');
    expect(meta['caveats']).toHaveLength(2);
  });

  it('search_legal_acts stamps every hit and exposes the set caveats', async () => {
    const { repo } = makeActsFake();
    const docs: readonly LegalDocHit[] = [
      { act: act('66150'), summary: null, score: 0.9, provenance: null },
    ];
    const out = await toolNamed(toolsFor(repo, docs), 'search_legal_acts').handler({
      q: 'cota de TVA',
      channel: 'docs',
    });
    const item = out.item as { acts: { textProvenance: string | null }[] };
    expect(item.acts[0]?.textProvenance).toContain('modificat de 295 de ori de atunci');
    expect(metaOf(out)['caveats']).toContain(LEGAL_ORIGINAL_TEXT_CAVEAT);
  });
});
