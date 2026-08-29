/**
 * LegalAct.links — real keyset pagination over the citation graph.
 *
 * The defect class this file exists to kill: hasNextPage computed honestly
 * while endCursor was hardcoded null, so only the first <=199-row window of a
 * 26,277-edge hub was ever reachable. The keyset is the `act_references` PK
 * `(source_document_id, ref_index)` — the ONE tuple unique in both directions.
 * Ties on `ref_index` are the NORMAL case for IN (every citing document
 * restarts at 0), so the tie boundary is tested as the main path, not an edge
 * case. totalCount stays null by design (act-detail.md §9.1) — only the
 * missing cursor was the defect.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { ok } from 'neverthrow';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeLegalResolvers } from '@/modules/legal/shell/graphql/resolvers.js';
import { LINKS_SORT, linksFhash } from '@/modules/legal/shell/repo/filter-helpers.js';
import { makeLegalGraphRepo } from '@/modules/legal/shell/repo/graph-repo.js';
import { buildNextCursor, decodeCursor, type ProdDatabase } from '@/modules/shared/index.js';

import type { LegalGraphRepo } from '@/modules/legal/core/ports.js';
import type { LegalIncomingEdge, LegalReferenceEdge } from '@/modules/legal/core/types.js';

interface Captured {
  sql: string;
  parameters: readonly unknown[];
}

// ── a capture-only db (DummyDriver: every query answers zero rows) ───────────

let statements: Captured[] = [];

const makeDb = (): Kysely<ProdDatabase> =>
  new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      statements.push({ sql: event.query.sql, parameters: event.query.parameters });
    },
  });

const lastSql = (): string => {
  const captured = statements[statements.length - 1];
  expect(captured).toBeDefined();
  return (captured?.sql ?? '').replace(/\s+/gu, ' ').trim();
};

const lastParams = (): readonly unknown[] => statements[statements.length - 1]?.parameters ?? [];

// ── a row-feeding db: the REAL repo over queued fake result sets ─────────────

const makeRowsDb = (): {
  db: Kysely<ProdDatabase>;
  executed: Captured[];
  results: unknown[][];
} => {
  const executed: Captured[] = [];
  const results: unknown[][] = [];
  const connection: DatabaseConnection = {
    executeQuery: <R>(compiled: CompiledQuery): Promise<QueryResult<R>> => {
      executed.push({ sql: compiled.sql, parameters: compiled.parameters });
      return Promise.resolve({ rows: (results.shift() ?? []) as R[] });
    },
    streamQuery: () => {
      throw new Error('streamQuery is not under test');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, executed, results };
};

/** One raw act_references row as the repo selects it. */
const refRow = (doc: string, refIndex: number): Record<string, unknown> => ({
  source_document_id: doc,
  ref_index: refIndex,
  relation: 'modifica',
  target_raw: 'Legea nr. 1/2000',
  target_class: 'act',
  target_act_id: '1',
  target_external_act_id: null,
  target_fragment: null,
  resolution: 'unique',
  confidence: 1,
  resolver_version: 'v1',
  // sa_* columns ride along for the IN query; the OUT mapper ignores them.
  sa_act_id: null,
});

beforeEach(() => {
  statements = [];
});

// ── SQL shape ────────────────────────────────────────────────────────────────

describe('links keyset — SQL shape', () => {
  it('OUT orders by the PK tuple and probes limit+1', async () => {
    const repo = makeLegalGraphRepo(makeDb());
    await repo.outgoingRefs('105735', undefined, { first: 50 });

    const sql = lastSql();
    expect(sql).toContain('inner join "legal"."acts" as "a"');
    expect(sql).toContain('order by "r"."source_document_id" asc, "r"."ref_index" asc');
    expect(lastParams()).toContain(51);
  });

  it('IN orders by the SAME PK tuple — never bare ref_index, which ties per citing doc', async () => {
    const repo = makeLegalGraphRepo(makeDb());
    await repo.incomingRefs('105735', undefined, { first: 50 });

    const sql = lastSql();
    expect(sql).toContain('"r"."target_act_id" = $1');
    expect(sql).toContain('order by "r"."source_document_id" asc, "r"."ref_index" asc');
    expect(lastParams()).toContain(51);
  });

  it('a resumed cursor compiles the strictly-after PK predicate (no repeat, no skip)', async () => {
    const repo = makeLegalGraphRepo(makeDb());
    const after = buildNextCursor({
      sort: LINKS_SORT,
      dir: 'asc',
      fhash: linksFhash('in', '105735', undefined),
      lastKeys: ['doc-42', '7'],
    });
    await repo.incomingRefs('105735', undefined, { first: 50, after });

    const sql = lastSql();
    // The doc key binds twice (one bind per interpolation) — $2 and $3 carry
    // the same value, as the parameter assertion below pins.
    expect(sql).toContain(
      '(r.source_document_id > $2 or (r.source_document_id = $3 and r.ref_index > $4))'
    );
    expect(lastParams()).toEqual(['105735', 'doc-42', 'doc-42', 7, 51]);
  });

  it('clamps the page to 199 so the probe stays inside the 200-row hub guard', async () => {
    const repo = makeLegalGraphRepo(makeDb());
    await repo.outgoingRefs('105735', undefined, { first: 5000 });
    expect(lastParams()).toContain(200); // 199 + the probe row
  });

  it('rejects a cursor minted under a DIFFERENT relation set, direction, or act', async () => {
    const repo = makeLegalGraphRepo(makeDb());
    const mint = (fhash: string): string =>
      buildNextCursor({ sort: LINKS_SORT, dir: 'asc', fhash, lastKeys: ['doc-1', '0'] });

    const foreignRelations = await repo.incomingRefs('105735', undefined, {
      first: 5,
      after: mint(linksFhash('in', '105735', ['modifica'])),
    });
    expect(foreignRelations.isErr() && foreignRelations.error.message).toContain(
      'cursor/filter mismatch'
    );

    const foreignDirection = await repo.incomingRefs('105735', undefined, {
      first: 5,
      after: mint(linksFhash('out', '105735', undefined)),
    });
    expect(foreignDirection.isErr() && foreignDirection.error.message).toContain(
      'cursor/filter mismatch'
    );

    const foreignAct = await repo.incomingRefs('105735', undefined, {
      first: 5,
      after: mint(linksFhash('in', '66150', undefined)),
    });
    expect(foreignAct.isErr() && foreignAct.error.message).toContain('cursor/filter mismatch');
    expect(statements).toHaveLength(0); // all rejected before any SQL
  });

  it('the fhash canonicalizes relations: order/duplicates/empty never fork the hash', () => {
    expect(linksFhash('in', '1', ['modifica', 'abroga', 'modifica'])).toBe(
      linksFhash('in', '1', ['abroga', 'modifica'])
    );
    expect(linksFhash('in', '1', [])).toBe(linksFhash('in', '1', undefined));
    expect(linksFhash('in', '1', ['modifica'])).not.toBe(linksFhash('in', '1', undefined));
    expect(linksFhash('in', '1', undefined)).not.toBe(linksFhash('out', '1', undefined));
  });

  it('rejects malformed cursor keys instead of binding them', async () => {
    const repo = makeLegalGraphRepo(makeDb());
    const fhash = linksFhash('in', '105735', undefined);
    const mint = (lastKeys: readonly string[]): string =>
      buildNextCursor({ sort: LINKS_SORT, dir: 'asc', fhash, lastKeys });

    const emptyDoc = await repo.incomingRefs('105735', undefined, {
      first: 5,
      after: mint(['', '7']),
    });
    expect(emptyDoc.isErr() && emptyDoc.error.message).toContain('empty document key');

    const badRef = await repo.incomingRefs('105735', undefined, {
      first: 5,
      after: mint(['doc-1', 'abc']),
    });
    expect(badRef.isErr() && badRef.error.message).toContain('non-numeric ref key');
    expect(statements).toHaveLength(0);
  });
});

// ── cursor behaviour over real repo + fed rows: the TIE boundary ─────────────

describe('links keyset — paging across a ref_index tie', () => {
  it('resumes strictly after the last SERVED row where source documents tie and change', async () => {
    const { db, executed, results } = makeRowsDb();
    const repo = makeLegalGraphRepo(db);

    // Page 1 (first=2): rows share doc-a — the tie case is the NORMAL case.
    // The probe row proves more exist.
    results.push([refRow('doc-a', 0), refRow('doc-a', 1), refRow('doc-a', 2)]);
    const page1 = (await repo.incomingRefs('105735', undefined, { first: 2 }))._unsafeUnwrap();

    expect(page1.items.map((i) => [i.edge.sourceDocumentId, i.edge.refIndex])).toEqual([
      ['doc-a', 0],
      ['doc-a', 1],
    ]);
    expect(page1.next).not.toBeNull();
    const decoded = decodeCursor(page1.next ?? '', {
      sort: LINKS_SORT,
      dir: 'asc',
      fhash: linksFhash('in', '105735', undefined),
    });
    // The cursor is the last SERVED row — not the probe row.
    expect(decoded._unsafeUnwrap().keys).toEqual(['doc-a', '1']);

    // Page 2 crosses BOTH boundaries: the remaining tie row (doc-a, 2) must
    // still be reachable (the =+tiebreak clause) and the next document's rows
    // follow (strict >) — no repeat of (doc-a, 1), no skip of (doc-a, 2).
    results.push([refRow('doc-a', 2), refRow('doc-b', 0)]);
    const page2 = (
      await repo.incomingRefs('105735', undefined, { first: 2, after: page1.next ?? '' })
    )._unsafeUnwrap();

    expect(page2.items.map((i) => [i.edge.sourceDocumentId, i.edge.refIndex])).toEqual([
      ['doc-a', 2],
      ['doc-b', 0],
    ]);
    expect(page2.next).toBeNull(); // two rows, no probe → genuinely exhausted
    const second = executed[executed.length - 1];
    expect(second?.parameters).toEqual(['105735', 'doc-a', 'doc-a', 1, 3]);
  });

  it('OUT mints and honours the same tuple (constant source document)', async () => {
    const { db, results } = makeRowsDb();
    const repo = makeLegalGraphRepo(db);

    results.push([refRow('100023', 0), refRow('100023', 1), refRow('100023', 2)]);
    const page1 = (await repo.outgoingRefs('424242', undefined, { first: 2 }))._unsafeUnwrap();
    const decoded = decodeCursor(page1.next ?? '', {
      sort: LINKS_SORT,
      dir: 'asc',
      fhash: linksFhash('out', '424242', undefined),
    });
    expect(decoded._unsafeUnwrap().keys).toEqual(['100023', '1']);
  });
});

// ── the GraphQL connection: endCursor is REAL on every page ──────────────────

interface LinksConnection {
  edges: readonly Record<string, unknown>[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: number | null;
}

const outEdge = (doc: string, refIndex: number): LegalReferenceEdge => ({
  sourceDocumentId: doc,
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

const inEdge = (doc: string, refIndex: number): LegalIncomingEdge => ({
  edge: outEdge(doc, refIndex),
  sourceAct: null,
});

const linksResolverWith = (
  graph: Partial<LegalGraphRepo>
): ((parent: unknown, args: Record<string, unknown>) => Promise<unknown>) => {
  const r = makeLegalResolvers({
    acts: { findActsByIds: () => Promise.resolve(ok([])) } as never,
    graph: graph as never,
    outline: {} as never,
    render: {} as never,
    searchDeps: {} as never,
    resolveDeps: {} as never,
  }) as {
    LegalAct: { links: (parent: unknown, args: Record<string, unknown>) => Promise<unknown> };
  };
  return r.LegalAct.links;
};

const parent = { actId: '105735' };

describe('LegalAct.links resolver — the endCursor contract', () => {
  it('endCursor decodes to the LAST edge and stays real on the final page', async () => {
    const seenPages: Record<string, unknown>[] = [];
    const links = linksResolverWith({
      incomingRefs: (_a, _r, page) => {
        seenPages.push(page as unknown as Record<string, unknown>);
        return Promise.resolve(ok({ items: [inEdge('doc-a', 3), inEdge('doc-b', 0)], next: null }));
      },
    });
    const conn = (await links(parent, {
      direction: 'IN',
      after: 'pass-through-cursor',
      first: 2,
    })) as LinksConnection;

    // after passes through to the repo untouched.
    expect(seenPages[0]).toEqual({ first: 2, after: 'pass-through-cursor' });
    // Final page (repo next null): hasNextPage false, endCursor STILL real —
    // the hardcoded-null contradiction must never come back.
    expect(conn.pageInfo.hasNextPage).toBe(false);
    expect(conn.pageInfo.endCursor).not.toBeNull();
    const decoded = decodeCursor(conn.pageInfo.endCursor ?? '', {
      sort: LINKS_SORT,
      dir: 'asc',
      fhash: linksFhash('in', '105735', undefined),
    });
    expect(decoded._unsafeUnwrap().keys).toEqual(['doc-b', '0']);
    expect(conn.totalCount).toBeNull(); // §9.1: a bounded read claims no total
  });

  it('a relation-filtered request minted a cursor the SAME repo call accepts (GQL enum → internal)', async () => {
    const links = linksResolverWith({
      outgoingRefs: () => Promise.resolve(ok({ items: [outEdge('100023', 5)], next: 'repo-next' })),
    });
    const conn = (await links(parent, {
      direction: 'OUT',
      relation: ['MODIFICA', 'MODIFICA', 'ABROGA'],
      first: 1,
    })) as LinksConnection;

    expect(conn.pageInfo.hasNextPage).toBe(true);
    // The resolver hashed the INTERNAL relation values, canonicalized — the
    // exact fhash the repo derives, so this endCursor resumes cleanly.
    const decoded = decodeCursor(conn.pageInfo.endCursor ?? '', {
      sort: LINKS_SORT,
      dir: 'asc',
      fhash: linksFhash('out', '105735', ['modifica', 'abroga']),
    });
    expect(decoded._unsafeUnwrap().keys).toEqual(['100023', '5']);
  });

  it('an empty page answers endCursor null — nothing to point at', async () => {
    const links = linksResolverWith({
      outgoingRefs: () => Promise.resolve(ok({ items: [], next: null })),
    });
    const conn = (await links(parent, { direction: 'OUT' })) as LinksConnection;
    expect(conn.edges).toHaveLength(0);
    expect(conn.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
  });
});
