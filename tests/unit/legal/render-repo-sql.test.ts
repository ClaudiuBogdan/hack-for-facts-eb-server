/**
 * What SQL the render repo sends for a requested chunk.
 *
 * `renderInfo` reads `privacy_class` off render row 0 only; the lane
 * classifies per chunk, so a later chunk can be restricted while row 0 is
 * public. The requested row must therefore carry its own class for the
 * usecase to refuse (403 stays distinguishable from 404, which a WHERE-filter
 * would collapse). Compiled through a driver that executes nothing.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { makeLegalRenderRepo } from '@/modules/legal/shell/repo/render-repo.js';

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

describe('render repo SQL', () => {
  it('selects the requested row with its own privacy_class, bound to the served generation', async () => {
    const { db, sql } = recordingDb();
    const res = await makeLegalRenderRepo(db).renderRow('doc-1', '42', 3);
    expect(res.isOk()).toBe(true);
    expect(sql).toHaveLength(1);
    const statement = sql[0] ?? '';
    expect(statement).toContain('"privacy_class"');
    expect(statement).toContain('"run_id" = $');
    expect(statement).toContain('"chunk_index" = $');
  });

  it('reads the document class from render row 0 for the info read', async () => {
    const { db, sql } = recordingDb();
    await makeLegalRenderRepo(db).renderInfo('doc-1');
    expect(sql[0]).toContain('"r"."chunk_index" = $');
    expect(sql[0]).toContain('"r"."privacy_class"');
  });
});
