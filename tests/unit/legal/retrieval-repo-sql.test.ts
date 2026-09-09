/**
 * Ordering of the legal section retrieval fallback (ILIKE path, semantic gate
 * off), compiled through a driver that executes nothing.
 *
 * 75409f0b added an `act_id` tie-break to the candidate-act subquery because
 * in_degree is 0 for 79.7% of acts, but the outer, LIMITed statement still
 * ordered by `in_degree, section_key` alone, so sections of equal-in_degree
 * acts came back in plan order — the same non-determinism one level up. This
 * fails if the outer tie-break is removed again.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { makeLegalRetrievalRepo } from '@/modules/legal/shell/repo/retrieval-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

const recordingDb = (): { db: Kysely<ProdDatabase>; sql: string[] } => {
  const captured: string[] = [];
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') captured.push(event.query.sql.replace(/\s+/gu, ' '));
    },
  });
  return { db, sql: captured };
};

describe('legal retrieval repo — section fallback ordering is total', () => {
  it('orders candidate acts and the final section list by act_id before section_key', async () => {
    const { db, sql } = recordingDb();
    const res = await makeLegalRetrievalRepo(db).searchSections(null, {
      q: 'codul muncii',
      filter: {},
      channel: 'sections',
      includeHistorical: false,
      limit: 5,
    });

    expect(res.isOk()).toBe(true);
    const statement = sql.find((s) => s.includes('cand_acts'));
    expect(statement).toBeDefined();
    expect(statement).toContain('order by a.in_degree desc, a.act_id asc limit 20');
    expect(statement).toContain(
      'order by ca.in_degree desc, ca.act_id asc, se.section_key asc limit 5'
    );
  });
});
