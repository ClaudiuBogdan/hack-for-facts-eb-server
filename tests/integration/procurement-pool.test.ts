/**
 * The kernel's procurement database (PRJ-54YB) through a real app build. Two local listeners stand
 * in for the two logins: each counts the connections it receives and drops them, so no database
 * is reached and the test sees which pool a read dialled. Unset, procurement IS the kernel
 * database (same pool, same login, exactly today's behaviour); set, the procurement module and
 * the D6 port dial only the procurement login, and the app's close ends that pool too.
 */
import { createServer, type AddressInfo, type Server } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';

interface Listener {
  readonly server: Server;
  readonly url: string;
  connections: number;
}

const listen = async (user: string): Promise<Listener> => {
  const listener = { connections: 0 } as Listener & { server: Server; url: string };
  const server = createServer((socket) => {
    listener.connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(listener, {
    server,
    url: `postgres://${user}:unused@127.0.0.1:${String(port)}/db`,
  });
};

let kernelLogin: Listener;
let procurementLogin: Listener;
beforeAll(async () => {
  kernelLogin = await listen('kernel');
  procurementLogin = await listen('procurement');
});
afterAll(async () => {
  await Promise.all(
    [kernelLogin, procurementLogin].map(
      (l) =>
        new Promise<void>((resolve) => {
          l.server.close(() => {
            resolve();
          });
        })
    )
  );
});

const build = (procurementDatabaseUrl?: string) =>
  buildRedesignApp({
    logLevel: 'silent',
    modules: ['procurement'],
    procurementWarmCache: false,
    procurement: { supplierDisclosureEnforced: true, daV3Enabled: true, legacyEnabled: false },
    kernelConfig: {
      prodDatabaseUrl: kernelLogin.url,
      ...(procurementDatabaseUrl !== undefined && { procurementDatabaseUrl }),
      meiliHost: '',
      meiliApiKey: '',
      opensearchUrl: '',
    },
  });

/** A D6 read and a DA release read, then how many connections each login received. */
const dial = async (built: Awaited<ReturnType<typeof build>>) => {
  kernelLogin.connections = 0;
  procurementLogin.connections = 0;
  await built.kernel.supplierDisclosure.publicSupplierCodes({ fresh: true });
  await built.app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query: '{ procurementDaRelease { enabled } }' }),
  });
  return { kernel: kernelLogin.connections, procurement: procurementLogin.connections };
};

describe('the kernel procurement database', () => {
  it('unset: procurement and the D6 port read through the kernel database itself', async () => {
    const built = await build();
    try {
      expect(built.kernel.procurementDb).toBe(built.kernel.db);
      const dialled = await dial(built);
      expect(dialled.kernel).toBeGreaterThan(0);
      expect(dialled.procurement).toBe(0);
    } finally {
      await built.app.close();
    }
  }, 60_000);

  it('set: the module and the D6 port dial only the procurement login', async () => {
    const built = await build(procurementLogin.url);
    try {
      expect(built.kernel.procurementDb).not.toBe(built.kernel.db);
      const dialled = await dial(built);
      expect(dialled.procurement).toBeGreaterThan(0);
      expect(dialled.kernel).toBe(0);
    } finally {
      await built.app.close();
    }
    // The app's close ended the procurement pool too.
    await expect(
      built.kernel.procurementDb.selectNoFrom((eb) => eb.val(1).as('one')).execute()
    ).rejects.toThrow(/destroyed/u);
  }, 60_000);
});
