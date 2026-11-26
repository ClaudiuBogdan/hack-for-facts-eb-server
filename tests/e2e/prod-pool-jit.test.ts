/**
 * The prod pool's `jit: 'off'` on a throwaway PostgreSQL 18 (CQA-22). The
 * company profile's financial statements read spent about 1.66 s of 1.68 s in
 * JIT compilation, because the planner's estimate crossed `jit_above_cost`.
 * The shared kernel pool therefore asks for `-c jit=off` when a connection
 * starts. Proven here against a real server: every connection of such a pool
 * reads `jit = off`, a pool that does not ask keeps the server default, the
 * options of the URL are kept next to it, and the procurement module's own
 * pool is left at the server default.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import { createProdDb, procurementDbFor, type ProdDb } from '@/modules/shared/shell/db/pool.js';

import { dockerCliUp } from './disposable-postgres.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

let dockerAvailable = false;
let container: StartedPostgreSqlContainer | undefined;
const opened: ProdDb[] = [];

const it = (name: string, test: () => Promise<void>): void => {
  vitestIt(name, async ({ skip }) => {
    if (!dockerAvailable) skip();
    await test();
  });
};

const uri = (query = ''): string => `${container?.getConnectionUri() ?? ''}${query}`;

const open = (config: Parameters<typeof createProdDb>[0]): ProdDb => {
  const prod = createProdDb(config);
  opened.push(prod);
  return prod;
};

const show = async (db: Kysely<ProdDatabase>, setting: string): Promise<string | undefined> => {
  const { rows } = await sql<{
    value: string;
  }>`select current_setting(${setting}) as value`.execute(db);
  return rows[0]?.value;
};

beforeAll(async () => {
  if (!dockerCliUp()) return;
  try {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('prod_pool_jit')
      .start();
  } catch (error) {
    console.warn(
      `Testcontainers runtime unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  dockerAvailable = true;
});

afterAll(async () => {
  try {
    for (const prod of opened) await prod.db.destroy();
  } finally {
    await container?.stop();
  }
});

describe('prod pool jit', () => {
  it('reads jit = off on every connection of a pool that asks for it', async () => {
    const { pool } = open({ connectionString: uri(), jit: 'off', max: 3 });
    // Three clients held at once: three separate connections, not one reused.
    const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
    try {
      const answers = await Promise.all(
        clients.map((client) => client.query<{ jit: string }>('show jit'))
      );
      expect(answers.map((answer) => answer.rows[0]?.jit)).toEqual(['off', 'off', 'off']);
      const pids = await Promise.all(
        clients.map((client) => client.query<{ pid: number }>('select pg_backend_pid() as pid'))
      );
      expect(new Set(pids.map((answer) => answer.rows[0]?.pid)).size).toBe(3);
    } finally {
      for (const client of clients) client.release();
    }
  });

  it('keeps the server default on a pool that does not ask', async () => {
    const { db } = open({ connectionString: uri() });
    expect(await show(db, 'jit')).toBe('on');
  });

  it('keeps the options of the URL next to jit = off', async () => {
    const { db } = open({
      connectionString: uri('?options=-c%20work_mem%3D5MB'),
      jit: 'off',
    });
    expect(await show(db, 'jit')).toBe('off');
    expect(await show(db, 'work_mem')).toBe('5MB');
  });

  it('lets the URL decide when it names jit itself', async () => {
    const { db } = open({ connectionString: uri('?options=-c%20jit%3Don'), jit: 'off' });
    expect(await show(db, 'jit')).toBe('on');
  });

  it("leaves the procurement module's own pool at the server default", async () => {
    const kernel = open({ connectionString: uri(), jit: 'off' });
    const procurement = procurementDbFor(kernel.db, { connectionString: uri() });
    try {
      expect(await show(procurement.db, 'jit')).toBe('on');
      expect(await show(kernel.db, 'jit')).toBe('off');
    } finally {
      await procurement.close();
    }
  });
});
