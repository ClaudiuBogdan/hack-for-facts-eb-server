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
      displayCitation: `Act ${String(i)}`,
      entryIntoForce: null,
    },
  }) as unknown as LegalIncomingEdge;

/** A graph whose incoming edges arrive in 199-row pages, as the repo serves them. */
const pagedGraph = (total: number): { graph: LegalGraphRepo; calls: (string | undefined)[] } => {
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
      const items = Array.from({ length: end - start }, (_, k) => edge(start + k));
      return ok({ items, next: end < total ? String(end) : null });
    },
  } as unknown as LegalGraphRepo;
  return { graph, calls };
};

const baseWith = (events: number): LegalRepoBase =>
  ({
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
