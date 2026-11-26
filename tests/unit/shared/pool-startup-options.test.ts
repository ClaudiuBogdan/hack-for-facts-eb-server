/**
 * The prod pool's startup `options` (CQA-22, no live DB). A pool asked for
 * `jit: 'off'` sends `-c jit=off` when a connection starts. node-pg lets an
 * `options=` parameter of the connection URL replace the pool's own `options`,
 * so the two are merged here and the parameter is taken out of the URL: the
 * result never depends on what the URL carries. A pool that does not ask keeps
 * its URL byte for byte. The setting reaching a real server is proven by
 * `tests/e2e/prod-pool-jit.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { makeKernel } from '@/modules/shared/index.js';
import { prodStartupSettings } from '@/modules/shared/shell/db/pool.js';

const BASE = 'postgres://reader:p%40ss%3Fw0rd@db.internal:5432/transparenta_prod';

describe('prod pool startup options', () => {
  it('sends jit=off for a pool that asks for it', () => {
    expect(prodStartupSettings({ connectionString: BASE, jit: 'off' })).toEqual({
      connectionString: BASE,
      options: '-c jit=off',
    });
  });

  it('leaves a pool that does not ask exactly as it was', () => {
    const withOptions = `${BASE}?sslmode=require&options=-c%20work_mem%3D5MB`;
    expect(prodStartupSettings({ connectionString: BASE })).toEqual({ connectionString: BASE });
    expect(prodStartupSettings({ connectionString: withOptions })).toEqual({
      connectionString: withOptions,
    });
  });

  it('keeps the options of the URL after its own, so the URL wins on the same setting', () => {
    expect(
      prodStartupSettings({
        connectionString: `${BASE}?options=-c%20work_mem%3D5MB`,
        jit: 'off',
      })
    ).toEqual({ connectionString: BASE, options: '-c jit=off -c work_mem=5MB' });
  });

  it('takes only the options parameter out of the URL, wherever it stands', () => {
    const options = 'options=-c%20work_mem%3D5MB';
    const cases: readonly (readonly [string, string])[] = [
      [`?${options}&sslmode=require`, '?sslmode=require'],
      [`?sslmode=require&${options}`, '?sslmode=require'],
      [`?sslmode=require&${options}&application_name=api`, '?sslmode=require&application_name=api'],
    ];
    for (const [query, kept] of cases) {
      expect(prodStartupSettings({ connectionString: `${BASE}${query}`, jit: 'off' })).toEqual({
        connectionString: `${BASE}${kept}`,
        options: '-c jit=off -c work_mem=5MB',
      });
    }
  });

  it('reads the URL value as node-pg does: plus is a space, the last parameter wins', () => {
    expect(
      prodStartupSettings({
        connectionString: `${BASE}?options=-c+work_mem%3D5MB`,
        jit: 'off',
      }).options
    ).toBe('-c jit=off -c work_mem=5MB');
    expect(
      prodStartupSettings({
        connectionString: `${BASE}?options=-c%20work_mem%3D5MB&options=-c%20work_mem%3D6MB`,
        jit: 'off',
      })
    ).toEqual({ connectionString: BASE, options: '-c jit=off -c work_mem=6MB' });
  });

  it('adds nothing for an empty options parameter', () => {
    expect(prodStartupSettings({ connectionString: `${BASE}?options=`, jit: 'off' })).toEqual({
      connectionString: BASE,
      options: '-c jit=off',
    });
  });
});

describe('kernel pool', () => {
  it('turns jit off for the shared pool every source module reads through', async () => {
    // pg connects lazily: nothing is dialled here.
    const kernel = await makeKernel({
      prodDatabaseUrl: BASE,
      meiliHost: 'http://127.0.0.1:1',
      meiliApiKey: 'unused',
      opensearchUrl: 'http://127.0.0.1:1',
    });
    try {
      expect(kernel.pool.options.options).toBe('-c jit=off');
    } finally {
      await kernel.close();
    }
  });
});
