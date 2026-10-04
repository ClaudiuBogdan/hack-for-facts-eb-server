/**
 * The PG proof's fixture role ledger (`tests/integration/companies/probe-roles.ts`)
 * over an in-memory cluster (no PostgreSQL): it owns a role only after this
 * run created it, so a colliding pre-existing role, another run's role or a
 * role whose creation failed is never dropped or stripped; a setup failure
 * after creation still cleans up exactly the created role; cleanup failures
 * are surfaced; names are per-run nonce-qualified safe identifiers.
 */

import { describe, expect, it } from 'vitest';

import {
  makeProbeRoleLedger,
  newRunNonce,
  probeRoleName,
} from '../../integration/companies/probe-roles.js';

const sqlError = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code });

/** A cluster of role names, failing like PostgreSQL on a duplicate or missing role. */
const fakeCluster = (
  existing: readonly string[],
  failOn: (text: string) => boolean = () => false
) => {
  const roles = new Set(existing);
  const statements: string[] = [];
  const run = async (text: string): Promise<void> => {
    await Promise.resolve();
    statements.push(text);
    if (failOn(text)) throw sqlError(`could not run: ${text}`, '2BP01');
    const created = /^create role (\w+) nologin$/u.exec(text)?.[1];
    if (created !== undefined) {
      if (roles.has(created)) throw sqlError(`role "${created}" already exists`, '42710');
      roles.add(created);
      return;
    }
    const dropped = /^drop role (\w+)$/u.exec(text)?.[1];
    if (dropped !== undefined) {
      if (!roles.has(dropped)) throw sqlError(`role "${dropped}" does not exist`, '42704');
      roles.delete(dropped);
    }
  };
  return { roles, statements, run };
};

const mentions = (statements: readonly string[], role: string): string[] =>
  statements.filter((s) => new RegExp(`\\b${role}\\b`, 'u').test(s));

describe('probe role names', () => {
  it('are short, per-run nonce-qualified, safe identifiers; two runs never share one', () => {
    const first = newRunNonce();
    const second = newRunNonce();
    expect(first).toMatch(/^[0-9a-f]{8}$/u);
    expect(second).not.toBe(first);
    const role = probeRoleName(first, 'nocatalog');
    expect(role).toBe(`cprobe_${first}_nocatalog`);
    expect(role.length).toBeLessThanOrEqual(63);
    expect(probeRoleName(second, 'nocatalog')).not.toBe(role);
  });

  it('an unsafe name is refused before any SQL runs', async () => {
    for (const [nonce, purpose] of [
      ['ab"; drop role postgres; --', 'full'],
      ['ABCDEF12', 'full'],
      ['0a1b2c3d', 'no catalog'],
      ['0a1b2c3d', 'x'.repeat(40)],
    ] as const) {
      expect(() => probeRoleName(nonce, purpose)).toThrow(/unsafe probe role name/u);
    }
    const cluster = fakeCluster([]);
    const ledger = makeProbeRoleLedger(cluster.run);
    await expect(ledger.create('Robert"; drop role x')).rejects.toThrow(/unsafe probe role name/u);
    expect(cluster.statements).toEqual([]);
  });
});

describe('the probe role ledger owns only what this run created', () => {
  it('a colliding pre-existing role: creation fails, it is never owned, and cleanup issues no statement on it', async () => {
    const nonce = newRunNonce();
    const colliding = probeRoleName(nonce, 'full');
    const cluster = fakeCluster([colliding]);
    const ledger = makeProbeRoleLedger(cluster.run);

    await expect(ledger.create(colliding)).rejects.toMatchObject({ code: '42710' });
    expect(ledger.owned()).toEqual([]);
    await ledger.cleanup();

    expect(cluster.roles.has(colliding)).toBe(true);
    // Its only statement was the failed CREATE: never a DROP OWNED / DROP ROLE.
    expect(mentions(cluster.statements, colliding)).toEqual([`create role ${colliding} nologin`]);
  });

  it('a setup failure after creation still removes exactly the roles this run created, and nothing else', async () => {
    const nonce = newRunNonce();
    const foreign = 'cprobe_ffffffff_full'; // another run's role on the same cluster
    const cluster = fakeCluster([foreign], (text) => text.startsWith('grant select'));
    const ledger = makeProbeRoleLedger(cluster.run);
    const first = probeRoleName(nonce, 'full');
    const second = probeRoleName(nonce, 'nostatus');
    // The proof's createProbeRole: CREATE through the ledger, then the grants.
    const setUp = async (role: string): Promise<void> => {
      await ledger.create(role);
      await cluster.run(`grant usage on schema core to ${role}`);
      await cluster.run(`grant select on core.organizations to ${role}`);
    };

    await expect(setUp(first)).rejects.toThrow(/could not run: grant select/u);
    await expect(setUp(second)).rejects.toThrow(/could not run: grant select/u);
    expect(ledger.owned()).toEqual([first, second]);

    await ledger.cleanup();
    expect(ledger.owned()).toEqual([]);
    expect([...cluster.roles]).toEqual([foreign]);
    expect(mentions(cluster.statements, foreign)).toEqual([]);
    expect(cluster.statements.slice(-4)).toEqual([
      `drop owned by ${second}`,
      `drop role ${second}`,
      `drop owned by ${first}`,
      `drop role ${first}`,
    ]);
  });

  it('a cleanup failure is surfaced (never swallowed); the role stays owned and the others are still dropped', async () => {
    const nonce = newRunNonce();
    const stuck = probeRoleName(nonce, 'nostatus');
    const fine = probeRoleName(nonce, 'full');
    const cluster = fakeCluster([], (text) => text === `drop owned by ${stuck}`);
    const ledger = makeProbeRoleLedger(cluster.run);
    await ledger.create(fine);
    await ledger.create(stuck);

    await expect(ledger.cleanup()).rejects.toThrow(
      new RegExp(`probe role cleanup failed .*${stuck}`, 'u')
    );
    expect(ledger.owned()).toEqual([stuck]);
    expect(cluster.roles.has(fine)).toBe(false);
    expect(cluster.roles.has(stuck)).toBe(true);
  });

  it("a second run's cleanup never touches the first run's roles", async () => {
    const cluster = fakeCluster([]);
    const firstRun = makeProbeRoleLedger(cluster.run);
    const secondRun = makeProbeRoleLedger(cluster.run);
    const firstRole = probeRoleName(newRunNonce(), 'full');
    const secondRole = probeRoleName(newRunNonce(), 'full');
    await firstRun.create(firstRole);
    await secondRun.create(secondRole);

    await secondRun.cleanup();
    expect(cluster.roles.has(firstRole)).toBe(true);
    expect(cluster.roles.has(secondRole)).toBe(false);
    await firstRun.cleanup();
    expect(cluster.roles.size).toBe(0);
  });
});
