/**
 * Site-wide D6 on entity-360's procurement presence: a code that is not public
 * has no direct-acquisition supplier leg (a count alone confirms a person's
 * purchases); its buyer legs and the public company's legs are unchanged.
 */
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeProcurementPresenceRepo } from '@/modules/procurement/shell/repo/presence-repo.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

import type { SupplierDisclosurePort } from '@/modules/shared/index.js';

const disclosure: SupplierDisclosurePort = {
  enforced: true,
  privacyAsOf: () => Promise.resolve(ok(null)),
  publicSupplierCodes: () => Promise.resolve(ok(new Set(['14399840']))),
};

const run = async (cui: string, port?: SupplierDisclosurePort) => {
  const captured: CapturedQuery[] = [];
  const db = makeCapturingDb(captured, {
    respond: () => [
      {
        authority_procedures: '0',
        authority_contracts: '0',
        authority_direct_acquisitions: '0',
        supplier_contracts: '0',
        supplier_direct_acquisitions: '1',
      },
    ],
  });
  await makeProcurementPresenceRepo(db, port).presenceCounts(cui);
  return captured.map((q) => q.sql).join('\n');
};

describe('procurement presence under D6', () => {
  it('drops the DA supplier leg for a withheld code', async () => {
    const sql = await run('30254716', disclosure);
    expect(sql).not.toMatch(/d\.supplier_cui = \$/u);
    expect(sql).toContain('select 1 where false');
  });

  it('keeps it for a public code and when D6 is off', async () => {
    expect(await run('14399840', disclosure)).toMatch(/d\.supplier_cui = \$/u);
    expect(await run('30254716')).toMatch(/d\.supplier_cui = \$/u);
  });
});
