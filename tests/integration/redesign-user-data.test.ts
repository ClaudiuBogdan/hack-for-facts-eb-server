import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import { err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';

import type { UserDatabase } from '@/infra/database/user/types.js';
import type { Kernel } from '@/modules/shared/index.js';

const kernelConfig = {
  prodDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
  meiliHost: '',
  meiliApiKey: '',
  opensearchUrl: '',
};
const authProvider = {
  verifyToken: async () => err({ type: 'InvalidTokenError' as const, message: 'test' }),
};
const signingSecret = `whsec_${Buffer.from('fixture webhook secret').toString('base64')}`;
class HealthDriver extends DummyDriver {
  fail = false;
  destroyed = false;
  override async acquireConnection() {
    const connection = await super.acquireConnection();
    return {
      ...connection,
      executeQuery: async () => {
        if (this.fail) throw new Error('private-host fixture-password role-name');
        return { rows: [] };
      },
    };
  }
  override async destroy() {
    this.destroyed = true;
  }
}
const userDatabase = () => {
  const driver = new HealthDriver();
  const db = new Kysely<UserDatabase>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { driver, db };
};
describe('native user-data lifecycle', () => {
  it('closes both resources when app construction fails after registration', async () => {
    const { driver, db } = userDatabase();
    let kernel: Kernel | undefined;
    await expect(
      buildRedesignApp({
        kernelConfig,
        logLevel: 'silent',
        modules: [],
        authProvider,
        userData: { db, signingSecret },
        registerContributors: (built) => {
          kernel = built;
          throw new Error('fixture construction failure');
        },
      })
    ).rejects.toThrow('fixture construction failure');
    expect(driver.destroyed).toBe(true);
    if (kernel === undefined) throw new Error('kernel was not constructed');
    // Kysely never initialized this pool; no sockets were acquired.
    expect(kernel.pool.totalCount).toBe(0);
  });
  it('closes user storage when authentication configuration is missing', async () => {
    const { driver, db } = userDatabase();
    await sql`select 1`.execute(db);
    await expect(
      buildRedesignApp({
        kernelConfig,
        logLevel: 'silent',
        modules: [],
        userData: { db, signingSecret },
      })
    ).rejects.toThrow('requires configured authentication');
    expect(driver.destroyed).toBe(true);
  });
  it('reports unavailable user storage without disclosing database errors', async () => {
    const { driver, db } = userDatabase();
    const { app } = await buildRedesignApp({
      kernelConfig,
      logLevel: 'silent',
      modules: [],
      authProvider,
      userData: { db, signingSecret },
    });
    try {
      driver.fail = true;
      for (const path of ['health', 'ready']) {
        const response = await app.inject({ method: 'GET', url: `/api/v1/${path}` });
        expect(response.statusCode).toBe(path === 'health' ? 200 : 503);
        expect(response.json().userDatabase.status).toBe('unhealthy');
        expect(response.body).not.toMatch(/private-host|fixture-password|role-name/);
        expect(response.json().userDatabase).not.toHaveProperty('message');
      }
    } finally {
      await app.close();
    }
  });
});
