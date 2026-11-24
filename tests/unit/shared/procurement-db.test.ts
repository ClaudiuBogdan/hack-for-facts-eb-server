/**
 * The procurement pool (PRJ-54YB): unset, procurement reads through the kernel's own database
 * (the same pool and login as before); set, through a second pool that closes on its own.
 */
import { describe, expect, it } from 'vitest';

import { procurementDbFor } from '@/modules/shared/shell/db/pool.js';
import { makeDisclosedReadRepos } from '@/modules/shared/shell/repo/supplier-disclosure-repo.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

describe('procurementDbFor', () => {
  it('unset: the kernel database itself, and closing it closes nothing', async () => {
    const kernelDb = makeCapturingDb([]);
    // In use first: Kysely only destroys a database it has opened.
    await kernelDb.selectNoFrom((eb) => eb.val(1).as('one')).execute();
    const procurement = procurementDbFor(kernelDb, {});
    expect(procurement.db).toBe(kernelDb);
    await procurement.close();
    // The kernel's database is still usable: the procurement handle did not destroy it.
    await expect(kernelDb.selectNoFrom((eb) => eb.val(1).as('one')).execute()).resolves.toEqual([]);
  });

  it('set: its own pool, destroyed by its own close and never the kernel one', async () => {
    const kernelDb = makeCapturingDb([]);
    const procurement = procurementDbFor(kernelDb, {
      connectionString: 'postgres://procurement@127.0.0.1:1/unused',
    });
    expect(procurement.db).not.toBe(kernelDb);
    // A first use opens the pool (nothing listens there); close must then end it.
    await expect(
      procurement.db.selectNoFrom((eb) => eb.val(1).as('one')).execute()
    ).rejects.toThrow();
    await procurement.close();
    await expect(
      procurement.db.selectNoFrom((eb) => eb.val(1).as('one')).execute()
    ).rejects.toThrow(/destroyed/u);
    await expect(kernelDb.selectNoFrom((eb) => eb.val(1).as('one')).execute()).resolves.toEqual([]);
  });
});

/** A statement about supplier_disclosure (the probe passes the view's name as a parameter). */
const readsDisclosure = (q: CapturedQuery): boolean =>
  `${q.sql} ${JSON.stringify(q.parameters)}`.includes('supplier_disclosure');

describe('the D6 port reads through the procurement database', () => {
  it('supplier_disclosure is read on the procurement database; flows stay on the kernel one', async () => {
    const kernelQueries: CapturedQuery[] = [];
    const procurementQueries: CapturedQuery[] = [];
    const repos = makeDisclosedReadRepos(
      makeCapturingDb(kernelQueries),
      true,
      { warn: () => undefined },
      makeCapturingDb(procurementQueries)
    );
    await repos.supplierDisclosure.publicSupplierCodes();
    await repos.flowsRepo.getFlowSummary('4305857', 'out');
    expect(procurementQueries.some(readsDisclosure)).toBe(true);
    expect(kernelQueries.some(readsDisclosure)).toBe(false);
    expect(kernelQueries.some((q) => q.sql.includes('money_flows'))).toBe(true);
    expect(procurementQueries.some((q) => q.sql.includes('money_flows'))).toBe(false);
  });

  it('defaults to the kernel database (unset: as before)', async () => {
    const kernelQueries: CapturedQuery[] = [];
    const repos = makeDisclosedReadRepos(makeCapturingDb(kernelQueries), true, {
      warn: () => undefined,
    });
    await repos.supplierDisclosure.publicSupplierCodes();
    expect(kernelQueries.some(readsDisclosure)).toBe(true);
  });
});
