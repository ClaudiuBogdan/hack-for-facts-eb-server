/**
 * I-20: an act's timeline merges its status events with EVERY incoming
 * modifica/completeaza/abroga reference. It used to read one 199-edge page and
 * drop the cursor, so the Fiscal Code's 325 references became 199 amendment
 * entries with no sign that any were missing.
 */
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  LEGAL_STATUS_EVENTS_BOUND,
  LEGAL_TIMELINE_EDGE_BOUND,
  type LegalIncomingEdge,
  type LegalStatusEvent,
} from '@/modules/legal/core/types.js';
import { getActTimeline } from '@/modules/legal/core/usecases.js';
import { makeLegalResolvers } from '@/modules/legal/shell/graphql/resolvers.js';
import { makeLegalMcpTools } from '@/modules/legal/shell/mcp/tools.js';
import { databaseError } from '@/modules/shared/index.js';

import type { LegalGraphRepo } from '@/modules/legal/core/ports.js';
import type { LegalRepoBase } from '@/modules/legal/core/repo-base.js';

const edge = (i: number): LegalIncomingEdge =>
  ({
    edge: { relation: 'modifica', targetRaw: `ref ${String(i)}` },
    sourceAct: {
      actId: String(1000 + i),
      actType: 'lege',
      displayCitation: `Act ${String(i)}`,
      entryIntoForce: null,
      issuerSlug: 'parlamentul-romaniei',
    },
  }) as unknown as LegalIncomingEdge;

/** A graph whose incoming edges arrive in 199-row pages, as the repo serves them. */
const pagedGraph = (
  total: number,
  make: (i: number) => LegalIncomingEdge = edge
): { graph: LegalGraphRepo; calls: (string | undefined)[] } => {
  const calls: (string | undefined)[] = [];
  const graph = {
    incomingRefs: async (
      _actId: string,
      _rel: unknown,
      page: { first: number; after?: string }
    ) => {
      calls.push(page.after);
      const start = page.after === undefined ? 0 : Number(page.after);
      const end = Math.min(start + page.first, total);
      const items = Array.from({ length: end - start }, (_, k) => make(start + k));
      return ok({ items, next: end < total ? String(end) : null });
    },
  } as unknown as LegalGraphRepo;
  return { graph, calls };
};

const LAW = { actId: '66150', actType: 'lege', issuerSlug: 'parlamentul-romaniei' };

const baseWith = (events: number, target: Record<string, unknown> | null = LAW): LegalRepoBase =>
  ({
    findActById: async () => ok(target),
    getStatusEvents: async () =>
      ok(
        Array.from(
          { length: events },
          (_, k): LegalStatusEvent =>
            ({
              eventId: String(k),
              actId: '66150',
              eventKind: 'modificare',
              effectiveDate: null,
              sourceActId: null,
              evidence: {},
              eventSource: 'portal',
            }) as unknown as LegalStatusEvent
        )
      ),
  }) as unknown as LegalRepoBase;

describe('getActTimeline — completeness (I-20)', () => {
  it('walks every page: 325 references all become amendment entries', async () => {
    const { graph, calls } = pagedGraph(325);
    const res = await getActTimeline(baseWith(279), graph, '66150');
    const timeline = res._unsafeUnwrap();
    expect(timeline.entries.filter((e) => e.kind === 'amendment')).toHaveLength(325);
    expect(timeline.entries.filter((e) => e.kind === 'status_event')).toHaveLength(279);
    expect(timeline.complete).toBe(true);
    expect(calls).toEqual([undefined, '199']);
  });

  it('the largest live act (3,200 references) is read completely', async () => {
    const { graph } = pagedGraph(3_200);
    const timeline = (await getActTimeline(baseWith(0), graph, '213501'))._unsafeUnwrap();
    expect(timeline.entries).toHaveLength(3_200);
    expect(timeline.complete).toBe(true);
  });

  it('keeps every edge, once, in page order', async () => {
    const { graph } = pagedGraph(600);
    const timeline = (await getActTimeline(baseWith(0), graph, '66150'))._unsafeUnwrap();
    const ids = timeline.entries.map((e) => e.relatedActId);
    expect(ids).toEqual(Array.from({ length: 600 }, (_, k) => String(1000 + k)));
  });

  it('enforces the edge bound exactly: at the bound complete, one past it not', async () => {
    const atBound = (
      await getActTimeline(baseWith(0), pagedGraph(LEGAL_TIMELINE_EDGE_BOUND).graph, '1')
    )._unsafeUnwrap();
    expect(atBound.entries).toHaveLength(LEGAL_TIMELINE_EDGE_BOUND);
    expect(atBound.complete).toBe(true);
    const past = (
      await getActTimeline(baseWith(0), pagedGraph(LEGAL_TIMELINE_EDGE_BOUND + 1).graph, '1')
    )._unsafeUnwrap();
    expect(past.entries).toHaveLength(LEGAL_TIMELINE_EDGE_BOUND);
    expect(past.complete).toBe(false);
  });

  it('fails instead of serving a partial timeline when a later page fails', async () => {
    const { graph } = pagedGraph(400);
    const failing = {
      incomingRefs: async (actId: string, rel: unknown, page: { first: number; after?: string }) =>
        page.after === undefined
          ? graph.incomingRefs(actId, rel as never, page)
          : err(databaseError('incomingRefs failed', new Error('boom'))),
    } as unknown as LegalGraphRepo;
    const res = await getActTimeline(baseWith(0), failing, '1');
    expect(res.isErr()).toBe(true);
  });

  it('says so when the status-event read reaches its bound', async () => {
    const { graph } = pagedGraph(0);
    const timeline = (
      await getActTimeline(baseWith(LEGAL_STATUS_EVENTS_BOUND), graph, '1')
    )._unsafeUnwrap();
    expect(timeline.complete).toBe(false);
  });
});

describe('timeline surfaces — one read, completeness exposed', () => {
  it('GraphQL timeline and timelineComplete share one read per act', async () => {
    const { graph, calls } = pagedGraph(250);
    const resolvers = makeLegalResolvers({
      acts: baseWith(3) as never,
      graph,
      outline: {} as never,
      render: {} as never,
      searchDeps: {} as never,
      resolveDeps: {} as never,
    }) as { LegalAct: Record<string, (parent: object) => Promise<unknown>> };
    const parent = { actId: '66150' };
    const [entries, complete] = await Promise.all([
      resolvers.LegalAct['timeline']?.(parent),
      resolvers.LegalAct['timelineComplete']?.(parent),
    ]);
    expect(entries).toHaveLength(253);
    expect(complete).toBe(true);
    expect(calls).toEqual([undefined, '199']);
  });

  it('the MCP timeline tool reports completeness', async () => {
    const { graph } = pagedGraph(LEGAL_TIMELINE_EDGE_BOUND + 1);
    const acts = {
      ...baseWith(0),
      resolveActRef: async () => ok({ actId: '1', displayCitation: 'Act 1' }),
      findActById: async () => ok({ actId: '1', displayCitation: 'Act 1' }),
      resolveActCandidates: async () => ok([{ actId: '1', displayCitation: 'Act 1' }]),
    };
    const tool = makeLegalMcpTools({
      acts: acts as never,
      graph,
      outline: {} as never,
      searchDeps: {} as never,
      resolveDeps: {} as never,
      clientBaseUrl: 'https://transparenta.eu',
    }).find((t) => t.name === 'get_legal_act_timeline');
    const out = (await tool?.handler({ actId: '1' })) as {
      meta?: Record<string, unknown>;
      summary?: string;
    };
    expect(out.meta?.['complete']).toBe(false);
    expect(out.summary).toContain('incomplete');
  });
});

describe('getActTimeline — court reports are not amendments (I-28)', () => {
  // Issuers as stored in production (the scrapper's I-28 fixtures).
  const ISSUERS = {
    accounts: ['curtea-de-conturi', 'decizie'],
    appeal: ['curtea-de-apel-bucuresti-sectia-a-ii-a-penala', 'decizie'],
    ccr: ['curtea-constitutionala', 'decizie'],
    ccrPlenary: ['curtea-constitutionala', 'hotarare'],
    cedo: ['curtea-europeana-a-drepturilor-omului', 'hotarare'],
    contencios: [
      'curtea-de-apel-bucuresti-sectia-a-viii-a-contencios-administrativ-si-fiscal',
      'sentinta',
    ],
    csj: ['curtea-suprema-de-justitie', 'decizie'],
    csm: ['consiliul-superior-al-magistraturii', 'hotarare'],
    government: ['guvernul-romaniei', 'oug'],
    iccjContencios: [
      'inalta-curte-de-casatie-si-justitie-sectia-de-contencios-administrativ-si-fiscal',
      'decizie',
    ],
    iccjPlenary: ['inalta-curte-de-casatie-si-justitie', 'hotarare'],
    iccjRil: [
      'inalta-curte-de-casatie-si-justitie-completul-competent-sa-judece-recursul-in-interesul-legii',
      'decizie',
    ],
    joint: [
      'ministerul-justitieinr-1-213-c-din-24-aprilie-2008consiliul-superior-al-magistraturiinr-12-920-1-154-din-23-aprilie-2008inalta-curte-de-casatie-si-justitienr-7',
      'ordin',
    ],
    judecatorie: ['judecatoria-sectorului-1-bucuresti', 'sentinta'],
    law: ['parlamentul-romaniei', 'lege'],
    tribunal: ['tribunalul-bucuresti', 'sentinta'],
  } as const;
  type Issuer = keyof typeof ISSUERS;
  const act = (name: Issuer, actId: string = name) => ({
    actId,
    actType: ISSUERS[name][1],
    displayCitation: name,
    entryIntoForce: '2021-01-01',
    issuerSlug: ISSUERS[name][0],
  });
  const ref = (relation: string, source: Issuer | null) =>
    ({
      edge: { relation, targetRaw: 'Legea nr. 1/2000' },
      sourceAct: source === null ? null : act(source),
    }) as unknown as LegalIncomingEdge;
  const graphOf = (edges: LegalIncomingEdge[]): LegalGraphRepo =>
    ({ incomingRefs: async () => ok({ items: edges, next: null }) }) as unknown as LegalGraphRepo;
  const amendments = async (
    edges: LegalIncomingEdge[],
    target: Record<string, unknown> | null = act('law', '1')
  ) =>
    (await getActTimeline(baseWith(0, target), graphOf(edges), '1'))
      ._unsafeUnwrap()
      .entries.filter((e) => e.kind === 'amendment')
      .map((e) => e.label);

  const JUDICIAL: Issuer[] = ['appeal', 'ccr', 'cedo', 'csj', 'iccjRil', 'judecatorie', 'tribunal'];
  const NOT_JUDICIAL: Issuer[] = [
    'accounts',
    'ccrPlenary',
    'contencios',
    'csm',
    'government',
    'iccjContencios',
    'iccjPlenary',
    'joint',
    'law',
  ];

  it("omits a judicial court's modifica/completeaza reference to a non-court act", async () => {
    for (const source of JUDICIAL) {
      for (const relation of ['modifica', 'completeaza']) {
        expect(await amendments([ref(relation, source)]), `${source} ${relation}`).toEqual([]);
      }
    }
  });

  it('keeps repeals, other issuers, unknown sources and court targets', async () => {
    for (const source of JUDICIAL) {
      expect(await amendments([ref('abroga', source)]), source).toEqual([`abroga de ${source}`]);
    }
    for (const source of NOT_JUDICIAL) {
      expect(await amendments([ref('modifica', source)]), source).toEqual([
        `modifica de ${source}`,
      ]);
    }
    // A citing act the join could not find: unclassifiable, kept.
    expect(await amendments([ref('modifica', null)])).toEqual(['modifica de Legea nr. 1/2000']);
    // A court's effect on another court decision (appeals), an administrative
    // court's or the ECtHR's act as target.
    for (const target of ['ccr', 'contencios', 'cedo'] as const) {
      expect(await amendments([ref('modifica', 'ccr')], act(target, '1')), target).toEqual([
        'modifica de ccr',
      ]);
    }
    // The act itself cannot be read: nothing is filtered.
    expect(await amendments([ref('modifica', 'ccr')], null)).toEqual(['modifica de ccr']);
  });

  it('never filters stored status events, and still walks every page', async () => {
    const pages = [
      Array.from({ length: 199 }, () => ref('modifica', 'ccr')),
      [ref('modifica', 'law'), ref('completeaza', 'iccjRil')],
    ];
    const calls: (string | undefined)[] = [];
    const graph = {
      incomingRefs: async (_a: string, _r: unknown, page: { after?: string }) => {
        calls.push(page.after);
        const index = page.after === undefined ? 0 : 1;
        return ok({ items: pages[index] ?? [], next: index === 0 ? 'p2' : null });
      },
    } as unknown as LegalGraphRepo;
    const timeline = (
      await getActTimeline(baseWith(3, act('law', '1')), graph, '1')
    )._unsafeUnwrap();
    expect(calls).toEqual([undefined, 'p2']);
    expect(timeline.entries.filter((e) => e.kind === 'status_event')).toHaveLength(3);
    expect(timeline.entries.filter((e) => e.kind === 'amendment').map((e) => e.label)).toEqual([
      'modifica de law',
    ]);
    expect(timeline.complete).toBe(true);
  });

  it('bounds the raw references walked, not the entries left after the filter', async () => {
    const court = () => ref('modifica', 'ccr');
    const target = act('law', '1');
    const atBound = (
      await getActTimeline(
        baseWith(0, target),
        pagedGraph(LEGAL_TIMELINE_EDGE_BOUND, court).graph,
        '1'
      )
    )._unsafeUnwrap();
    expect(atBound.entries).toEqual([]);
    expect(atBound.complete).toBe(true);
    const { graph, calls } = pagedGraph(LEGAL_TIMELINE_EDGE_BOUND + 1, court);
    const past = (await getActTimeline(baseWith(0, target), graph, '1'))._unsafeUnwrap();
    expect(past.entries).toEqual([]);
    expect(past.complete).toBe(false);
    // 50 pages of 199, then the last 50 rows: 51 reads, exactly the bound.
    expect(calls).toHaveLength(Math.ceil(LEGAL_TIMELINE_EDGE_BOUND / 199));
  });

  it('fails when the act itself cannot be read', async () => {
    const base = {
      ...baseWith(0),
      findActById: async () => err(databaseError('findActById failed', new Error('boom'))),
    } as unknown as LegalRepoBase;
    expect((await getActTimeline(base, graphOf([ref('modifica', 'law')]), '1')).isErr()).toBe(true);
  });

  it('GraphQL and MCP serve the same filtered entries', async () => {
    const edges = [ref('modifica', 'ccr'), ref('modifica', 'law'), ref('abroga', 'ccr')];
    const target = act('law', '1');
    const acts = {
      ...baseWith(1, target),
      resolveActRef: async () => ok(target),
      resolveActCandidates: async () => ok([target]),
    };
    const resolvers = makeLegalResolvers({
      acts: acts as never,
      graph: graphOf(edges),
      outline: {} as never,
      render: {} as never,
      searchDeps: {} as never,
      resolveDeps: {} as never,
    }) as { LegalAct: Record<string, (parent: object) => Promise<unknown>> };
    // A parent without issuer or type: the use case reads the act itself.
    const viaGraphql = (await resolvers.LegalAct['timeline']?.({ actId: '1' })) as {
      label: string;
    }[];
    const tool = makeLegalMcpTools({
      acts: acts as never,
      graph: graphOf(edges),
      outline: {} as never,
      searchDeps: {} as never,
      resolveDeps: {} as never,
      clientBaseUrl: 'https://transparenta.eu',
    }).find((t) => t.name === 'get_legal_act_timeline');
    const viaMcp = (await tool?.handler({ actId: '1' })) as unknown as {
      items?: { label: string }[];
    };
    const labels = (rows: { label: string }[] | undefined) => (rows ?? []).map((r) => r.label);
    // Dated entries first; the undated status event sorts last.
    expect(labels(viaGraphql)).toEqual(['modifica de law', 'abroga de ccr', 'modificare']);
    expect(labels(viaMcp?.items)).toEqual(labels(viaGraphql));
  });
});
