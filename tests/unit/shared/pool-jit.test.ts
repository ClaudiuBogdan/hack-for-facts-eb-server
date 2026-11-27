/**
 * The prod pool's `jit: 'off'` (CQA-22, no live DB). A pool that asks gets
 * pg-pool's `onConnect` hook, which runs `set jit = off` on every new
 * connection before it is handed out. The connection URL is not rewritten for
 * it: a first version merged `-c jit=off` into the URL's own `options`, and no
 * hand-written parse matched node-pg's (a fragment, a literal space, a bare
 * socket path and `PGOPTIONS` each connected differently). The setting
 * reaching a real server is proven by `tests/e2e/prod-pool-jit.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeKernel } from '@/modules/shared/index.js';
import { createProdDb, turnJitOff } from '@/modules/shared/shell/db/pool.js';

const BASE = 'postgres://reader:p%40ss%3Fw0rd@db.internal:5432/transparenta_prod';
const AWKWARD = `${BASE}?options=-c work_mem%3D5MB&application_name=api#deploy`;

/** pg connects lazily: building a pool dials nothing. */
const poolOptions = async (config: Parameters<typeof createProdDb>[0]) => {
  const { pool } = createProdDb(config);
  const { options } = pool;
  await pool.end();
  return options;
};

describe('prod pool jit', () => {
  it('gives a pool that asks the hook that turns jit off', async () => {
    expect(turnJitOff).toBeTypeOf('function');
    expect((await poolOptions({ connectionString: BASE, jit: 'off' })).onConnect).toBe(turnJitOff);
  });

  it('gives a pool that does not ask no hook', async () => {
    expect((await poolOptions({ connectionString: BASE })).onConnect).toBeUndefined();
  });

  it('connects a pool that asks exactly as one that does not', async () => {
    for (const connectionString of [BASE, AWKWARD]) {
      const asking = await poolOptions({ connectionString, jit: 'off' });
      const plain = await poolOptions({ connectionString });
      expect(asking.connectionString).toBe(plain.connectionString);
      expect(asking.connectionString).toBe(connectionString);
      // An explicit `options` would also switch off node-pg's PGOPTIONS fallback.
      expect(asking.options).toBeUndefined();
    }
  });

  it('runs set jit = off on the new client and settles only when it has', async () => {
    const statements: string[] = [];
    let finish: () => void = () => undefined;
    const client = {
      query: (text: string): Promise<unknown> => {
        statements.push(text);
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    };
    let settled = false;
    const hook = (async (): Promise<void> => {
      await turnJitOff(client);
      settled = true;
    })();
    await Promise.resolve();
    expect(statements).toEqual(['set jit = off']);
    expect(settled).toBe(false);
    finish();
    await hook;
    expect(settled).toBe(true);
  });

  it('rejects when the statement fails, so pg-pool closes the client instead of handing it out', async () => {
    const failure = new Error('unrecognized configuration parameter "jit"');
    await expect(turnJitOff({ query: () => Promise.reject(failure) })).rejects.toBe(failure);
  });

  describe('deadline', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('gives up on a server that never answers, so the checkout is not held', async () => {
      vi.useFakeTimers();
      const silent = { query: () => new Promise<unknown>(() => undefined) };
      const outcome = turnJitOff(silent).then(
        () => 'settled',
        (error: unknown) => (error instanceof Error ? error.message : 'not an error')
      );
      // The pool's connect timeout no longer covers this round trip: its own bound does.
      await vi.advanceTimersByTimeAsync(9_999);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBe('set jit = off: no answer in 10000 ms');
    });

    it('leaves no timer behind once the server has answered', async () => {
      vi.useFakeTimers();
      await turnJitOff({ query: () => Promise.resolve() });
      expect(vi.getTimerCount()).toBe(0);
      await expect(
        turnJitOff({ query: () => Promise.reject(new Error('refused')) })
      ).rejects.toThrow('refused');
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('kernel pool', () => {
  it('asks for jit off on the shared pool every source module reads through', async () => {
    const quiet = () => undefined;
    // Nothing is dialled: empty search hosts cannot be reached, and pg connects lazily.
    const kernel = await makeKernel({
      prodDatabaseUrl: BASE,
      meiliHost: '',
      meiliApiKey: '',
      opensearchUrl: '',
      logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    });
    try {
      expect(kernel.pool.options.onConnect).toBe(turnJitOff);
      expect(kernel.pool.options.connectionString).toBe(BASE);
    } finally {
      await kernel.close();
    }
  });
});
