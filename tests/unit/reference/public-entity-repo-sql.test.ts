/**
 * P0 containment pinned at the SQL layer for the reference public-entity repo.
 *
 * `normalizeCui` accepts up to 13 digits while served identifiers are at most
 * 10, so a CNP-shaped `referencePublicEntity(cui:)` used to reach
 * `core.public_entities`. The usecase now refuses first; this pins that the repo
 * fails closed on its own too (the contributor calls it directly), the same way
 * the kernel identity repo does: no statement is issued at all.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { makePublicEntityRepo } from '@/modules/reference/shell/repo/public-entity-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

const WITHHELD_13 = '9999999999999';
const SERVED = '4305857';

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
      if (event.level === 'query') captured.push(event.query.sql);
    },
  });
  return { db, sql: captured };
};

describe('reference public-entity repo — withheld identifiers never reach the table', () => {
  it('findByCui issues NO statement for a 13-digit identifier', async () => {
    const { db, sql } = recordingDb();
    const res = await makePublicEntityRepo(db).findByCui(WITHHELD_13, false);

    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap()).toBeNull();
    expect(sql).toHaveLength(0);
  });

  it('findByCui still queries core.public_entities for a servable identifier', async () => {
    const { db, sql } = recordingDb();
    await makePublicEntityRepo(db).findByCui(`RO ${SERVED}`, false);

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('"core"."public_entities"');
  });
});
