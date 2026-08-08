/**
 * What SQL the outline repo actually sends.
 *
 * The grammar test next door pins constants, and constants cannot catch the
 * defect that mattered: the predicate was missing a generation pin, so on 137
 * documents it returned 10,015 rows from a RETIRED split-v2 generation and zero
 * current ones — an entire table of contents served from a dead corpus. Delete
 * the join and every constant still checks out.
 *
 * So this compiles the real query through a driver that executes nothing and
 * records the statement. It fails if the generation join, the role filter, or
 * the node_type keying is removed — which is the point.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeLegalOutlineRepo } from '@/modules/legal/shell/repo/outline-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

let statements: string[] = [];

const makeDb = (): Kysely<ProdDatabase> =>
  new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      statements.push(event.query.sql);
    },
  });

/** Normalised to one line so assertions do not depend on formatting. */
const lastSql = (): string => {
  const sql = statements[statements.length - 1];
  expect(sql).toBeDefined();
  return (sql ?? '').replace(/\s+/gu, ' ');
};

beforeEach(() => {
  statements = [];
});

describe('outline repo SQL', () => {
  it('pins the outline to the served generation', async () => {
    const repo = makeLegalOutlineRepo(makeDb());
    await repo.outline({ documentId: 'doc-1', maxDepth: 3, page: { first: 50 } });

    const sql = lastSql();
    expect(sql).toContain('inner join "legal"."document_generations"');
    // Both halves of the composite key: document alone would still admit a
    // legacy row, because those documents DO have a generation row.
    expect(sql).toMatch(/"g"\."document_id" = "n"\."document_id"/u);
    expect(sql).toMatch(/"g"\."run_id" = "n"\."run_id"/u);
  });

  it('pins entryByPath too, not just the paged outline', async () => {
    // entryByPath resolves deep links and is reachable for the same 137
    // legacy documents; an unpinned lookup lands on a ghost node.
    const repo = makeLegalOutlineRepo(makeDb());
    await repo.entryByPath('doc-1', 'unmarked:7');

    const sql = lastSql();
    expect(sql).toContain('inner join "legal"."document_generations"');
    expect(sql).toMatch(/"g"\."run_id" = "n"\."run_id"/u);
  });

  it('filters heading rows by node_type and never by node_kind', async () => {
    // node_kind cannot express PRT vs POR — both read 'parte'. If this ever
    // reverts to a node_kind filter, 43,526 portion wrappers re-enter the TOC.
    const repo = makeLegalOutlineRepo(makeDb());
    await repo.outline({ documentId: 'doc-1', maxDepth: 7, page: { first: 50 } });

    const sql = lastSql();
    expect(sql).toContain('"n"."node_type" in');
    expect(sql).not.toContain('"n"."node_kind" in');
  });

  it('keeps the role filter that stops an article appearing four times', async () => {
    const repo = makeLegalOutlineRepo(makeDb());
    await repo.outline({ documentId: 'doc-1', maxDepth: 3, page: { first: 50 } });

    expect(lastSql()).toMatch(/"n"\."role" is null/u);
  });

  it('orders and pages on order_index, never on a path prefix', async () => {
    // `unmarked:N` keys carry no hierarchy, so `path like 'x%'` silently lies.
    const repo = makeLegalOutlineRepo(makeDb());
    await repo.outline({ documentId: 'doc-1', maxDepth: 3, page: { first: 50 } });

    const sql = lastSql();
    expect(sql).toContain('order by "n"."order_index" asc');
    expect(sql).not.toContain('like');
  });

  it('sends no query at all when the depth budget admits nothing', async () => {
    const repo = makeLegalOutlineRepo(makeDb());
    const result = await repo.outline({ documentId: 'doc-1', maxDepth: 0, page: { first: 50 } });

    expect(result.isOk()).toBe(true);
    expect(statements).toHaveLength(0);
  });
});
