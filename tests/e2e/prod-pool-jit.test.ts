/**
 * The prod pool's `jit: 'off'` on a throwaway PostgreSQL 18 (CQA-22). The
 * company profile's financial statements read spent about 1.66 s of 1.68 s in
 * JIT compilation, because the planner's estimate crossed `jit_above_cost`.
 * The shared kernel pool therefore runs `set jit = off` on every new
 * connection, before it is handed out. Proven here against a real server:
 * every connection of such a pool reads `jit = off`, also when the connection
 * URL itself asks for jit; a pool that does not ask keeps the server default;
 * the URL's own options are still honoured; and the procurement module's own
 * pool is left at the server default.
 *
 * Without a container runtime the suite SKIPS, or fails when
 * `TEST_E2E_REQUIRED=1`.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import { createProdDb, procurementDbFor, type ProdDb } from '@/modules/shared/shell/db/pool.js';

import { dockerCliUp } from './disposable-postgres.js';

import type { ProdDatabase } from '@/modules/shared/index.js';
import type { PoolClient } from 'pg';

let available = false;
let container: StartedPostgreSqlContainer | undefined;
const opened: ProdDb[] = [];

const it = (name: string, test: () => Promise<void>): void => {
  vitestIt(name, async ({ skip }) => {
    if (!available) skip();
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

const startPostgres = async (): Promise<StartedPostgreSqlContainer | undefined> => {
  if (!dockerCliUp()) return undefined;
  try {
    return await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('prod_pool_jit')
      .start();
  } catch (error) {
    console.warn(
      `Testcontainers runtime unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
};

beforeAll(async () => {
  container = await startPostgres();
  if (container === undefined) {
    if (process.env['TEST_E2E_REQUIRED'] === '1') throw new Error('Disposable PostgreSQL required');
    console.warn('Prod pool jit tests skipped: no container runtime');
    return;
  }
  available = true;
  // Longer than Testcontainers' own 120 s readiness limit, so a slow start is never
  // abandoned by the hook timeout and then left running.
}, 150_000);

afterAll(async () => {
  try {
    // The pool itself: Kysely's destroy() is a no-op until its driver has run a query.
    for (const { pool } of opened) {
      try {
        await pool.end();
      } catch (error) {
        console.warn(`pool end failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await container?.stop();
  }
});

describe('prod pool jit', () => {
  it('reads jit = off on every connection of a pool that asks for it', async () => {
    const { pool } = open({ connectionString: uri(), jit: 'off', max: 3 });
    // Three clients held at once: three separate connections, not one reused.
    const checkouts = await Promise.allSettled([pool.connect(), pool.connect(), pool.connect()]);
    const clients = checkouts.flatMap((checkout): PoolClient[] =>
      checkout.status === 'fulfilled' ? [checkout.value] : []
    );
    try {
      expect(clients).toHaveLength(3);
      const answers = await Promise.all(
        clients.map((client) =>
          client.query<{ jit: string; pid: number }>(
            `select current_setting('jit') as jit, pg_backend_pid() as pid`
          )
        )
      );
      expect(answers.map((answer) => answer.rows[0]?.jit)).toEqual(['off', 'off', 'off']);
      expect(new Set(answers.map((answer) => answer.rows[0]?.pid)).size).toBe(3);
    } finally {
      for (const client of clients) client.release();
    }
  });

  it('still reads jit = off on a client checked out again after a transaction', async () => {
    const { pool } = open({ connectionString: uri(), jit: 'off', max: 1 });
    const state = `select current_setting('jit') as jit, pg_backend_pid() as pid`;
    const first = await pool.connect();
    let firstPid: number | undefined;
    try {
      await first.query('begin');
      await first.query('set local jit = on');
      const inside = await first.query<{ jit: string; pid: number }>(state);
      expect(inside.rows[0]?.jit).toBe('on');
      firstPid = inside.rows[0]?.pid;
      await first.query('commit');
    } finally {
      first.release();
    }
    // The second checkout of the same connection (max 1): the hook ran once, at connect.
    const second = await pool.connect();
    try {
      const again = await second.query<{ jit: string; pid: number }>(state);
      expect(firstPid).toBeTypeOf('number');
      expect(again.rows[0]).toEqual({ jit: 'off', pid: firstPid });
    } finally {
      second.release();
    }
  });

  it('keeps the server default on a pool that does not ask', async () => {
    const { db } = open({ connectionString: uri() });
    expect(await show(db, 'jit')).toBe('on');
  });

  it("still honours the URL's own options", async () => {
    const { db } = open({
      connectionString: uri('?options=-c%20work_mem%3D5MB'),
      jit: 'off',
    });
    expect(await show(db, 'jit')).toBe('off');
    expect(await show(db, 'work_mem')).toBe('5MB');
  });

  it('turns jit off even when the URL asks for it', async () => {
    const asked = open({ connectionString: uri('?options=-c%20jit%3Don'), jit: 'off' });
    expect(await show(asked.db, 'jit')).toBe('off');
    // The same URL on a pool that does not ask: the URL's setting does reach the server.
    const plain = open({ connectionString: uri('?options=-c%20jit%3Don%20-c%20work_mem%3D6MB') });
    expect(await show(plain.db, 'work_mem')).toBe('6MB');
    expect(await show(plain.db, 'jit')).toBe('on');
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
