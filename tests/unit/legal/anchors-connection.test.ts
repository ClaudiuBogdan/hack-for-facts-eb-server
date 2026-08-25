/**
 * The incoming-anchors connection and the repaired links pagination.
 *
 * Two honesty contracts:
 *  - `incomingAnchors.totalCount` is the repo's REAL count (never the page
 *    size), and every per-edge cursor is a resumable keyset cursor bound to
 *    the act (decodeCursor round-trip with the repo's sort/fhash).
 *  - `links.pageInfo.hasNextPage` is a measured fact (limit+1 probe) and its
 *    totalCount is NULL — a bounded read must not claim to know a hub's true
 *    fan-out (act-detail.md §9.1).
 */

import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeLegalResolvers } from '@/modules/legal/shell/graphql/resolvers.js';
import { decodeCursor, filterHash } from '@/modules/shared/index.js';

import type { LegalGraphRepo } from '@/modules/legal/core/ports.js';
import type {
  LegalAct,
  LegalIncomingAnchor,
  LegalReferenceEdge,
} from '@/modules/legal/core/types.js';

const anchor = (edgeId: string): LegalIncomingAnchor => ({
  edgeId,
  sourceDocumentId: `doc-${edgeId}`,
  sourceActId: '77',
  sourceNodePath: null,
  ordinal: 0,
  linkText: 'Legea nr. 17/2001',
  targetFragment: null,
  targetNodePath: null,
  targetResolution: 'held',
  charStart: 10,
  charEnd: 27,
});

const refEdge = (refIndex: number): LegalReferenceEdge => ({
  sourceDocumentId: '100023',
  refIndex,
  relation: 'modifica',
  targetRaw: 'Legea nr. 1/2000',
  targetClass: 'act',
  targetActId: '1',
  targetExternalActId: null,
  targetFragment: null,
  resolution: 'unique',
  confidence: 1,
  resolverVersion: 'v1',
});

const act: LegalAct = {
  actId: '424242',
  actNaturalKey: 'lege/2001/17',
  actType: 'lege',
  actNumber: '17',
  actYear: 2001,
  issuerSlug: 'parlamentul',
  canonicalDocumentId: '100023',
  displayCitation: 'Legea nr. 17/2001',
  status: 'in-vigoare',
  statusEvidence: {},
  entryIntoForce: null,
  inDegree: 3,
};

const makeGraphFake = (overrides: Partial<LegalGraphRepo>): LegalGraphRepo => ({
  outgoingRefs: () => Promise.resolve(ok({ items: [], next: null })),
  incomingRefs: () => Promise.resolve(ok({ items: [], next: null })),
  externalAct: () => Promise.resolve(ok(null)),
  incomingAnchors: () => Promise.resolve(ok({ items: [], next: null, totalCount: 0 })),
  ...overrides,
});

const resolversWith = (graph: LegalGraphRepo) => {
  const r = makeLegalResolvers({
    acts: {
      findActsByIds: () => Promise.resolve(ok([act])),
    } as never,
    graph,
    outline: {} as never,
    render: {} as never,
    searchDeps: {} as never,
    resolveDeps: {} as never,
  });
  return (
    r as {
      LegalAct: Record<
        string,
        (parent: LegalAct, args: Record<string, unknown>) => Promise<unknown>
      >;
    }
  ).LegalAct;
};

interface AnchorConnection {
  edges: { node: LegalIncomingAnchor; cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: number | null;
}

describe('LegalAct.incomingAnchors', () => {
  it('serves the REAL totalCount and resumable per-edge cursors', async () => {
    const fhash = filterHash('anchors:424242');
    const graph = makeGraphFake({
      incomingAnchors: (_actId, page) =>
        Promise.resolve(
          ok({
            items: [anchor('101'), anchor('102')],
            next: `cursor-for-${String(page.first)}`,
            totalCount: 23_527,
          })
        ),
    });
    const resolvers = resolversWith(graph);
    const connection = (await resolvers['incomingAnchors']?.(act, {
      first: 2,
    })) as AnchorConnection;

    expect(connection.totalCount).toBe(23_527);
    expect(connection.pageInfo.hasNextPage).toBe(true);
    expect(connection.edges).toHaveLength(2);

    // Each cursor decodes under the repo's exact keyset contract.
    for (const [i, edge] of connection.edges.entries()) {
      const decoded = decodeCursor(edge.cursor, { sort: 'edge_id', dir: 'asc', fhash });
      expect(decoded.isOk()).toBe(true);
      if (decoded.isOk()) {
        expect(decoded.value.keys[0]).toBe(connection.edges[i]?.node.edgeId);
      }
    }
  });

  it('hydrates sourceAct through the batched act loader', async () => {
    const r = makeLegalResolvers({
      acts: { findActsByIds: () => Promise.resolve(ok([act])) } as never,
      graph: makeGraphFake({}),
      outline: {} as never,
      render: {} as never,
      searchDeps: {} as never,
      resolveDeps: {} as never,
    }) as {
      LegalIncomingAnchor: {
        sourceAct: (parent: { sourceActId: string | null }) => Promise<LegalAct | null>;
      };
    };
    await expect(r.LegalIncomingAnchor.sourceAct({ sourceActId: '424242' })).resolves.toEqual(act);
    await expect(r.LegalIncomingAnchor.sourceAct({ sourceActId: null })).resolves.toBeNull();
  });
});

describe('LegalAct.links pagination honesty', () => {
  it('reports hasNextPage from the repo page and totalCount null, never the page size', async () => {
    const graph = makeGraphFake({
      // The repo's probe found more rows → a REAL next cursor rides the page.
      outgoingRefs: (_actId, _rels, page) =>
        Promise.resolve(
          ok({ items: Array.from({ length: page.first }, (_, i) => refEdge(i)), next: 'more' })
        ),
    });
    const resolvers = resolversWith(graph);
    const connection = (await resolvers['links']?.(act, {
      direction: 'OUT',
      first: 3,
    })) as AnchorConnection;
    expect(connection.edges).toHaveLength(3);
    expect(connection.pageInfo.hasNextPage).toBe(true);
    // The self-contradiction this surface shipped with — hasNextPage true,
    // endCursor null — must never come back.
    expect(connection.pageInfo.endCursor).not.toBeNull();
    expect(connection.totalCount).toBeNull();
  });

  it('reports hasNextPage false on the final page — with endCursor still REAL', async () => {
    const graph = makeGraphFake({
      outgoingRefs: () => Promise.resolve(ok({ items: [refEdge(0), refEdge(1)], next: null })),
    });
    const resolvers = resolversWith(graph);
    const connection = (await resolvers['links']?.(act, {
      direction: 'OUT',
      first: 3,
    })) as AnchorConnection;
    expect(connection.edges).toHaveLength(2);
    expect(connection.pageInfo.hasNextPage).toBe(false);
    expect(connection.pageInfo.endCursor).not.toBeNull();
  });
});
