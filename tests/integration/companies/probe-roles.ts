/**
 * Reader roles of the ONRC reader PG proof (a DISPOSABLE fixture cluster):
 * per-run nonce-qualified names, and an ownership ledger that records a role
 * only after THIS run created it. Cleanup therefore can never drop or strip a
 * role this run did not create (a pre-existing name, another run's role), and
 * it reports every failure instead of swallowing it. Fixture-only: never a
 * runtime role or grant. No `pg` import: the SQL runner is injected (the
 * proof's client; an in-memory cluster in the unit test).
 */

import { randomBytes } from 'node:crypto';

export type SqlRunner = (text: string) => Promise<unknown>;

/** A lowercase identifier safe to inline unquoted, well under NAMEDATALEN (63). */
const SAFE_ROLE = /^[a-z][a-z0-9_]{0,40}$/u;

const assertSafeRole = (role: string): void => {
  if (!SAFE_ROLE.test(role)) throw new Error(`unsafe probe role name: ${JSON.stringify(role)}`);
};

/** 8 lowercase hex characters, fresh for every run. */
export const newRunNonce = (): string => randomBytes(4).toString('hex');

/** `cprobe_<nonce>_<purpose>`, validated before any SQL can use it. */
export const probeRoleName = (nonce: string, purpose: string): string => {
  const role = `cprobe_${nonce}_${purpose}`;
  assertSafeRole(role);
  return role;
};

export interface ProbeRoleLedger {
  /** Create `role` (NOLOGIN); it is owned only once that statement succeeded. */
  create(role: string): Promise<void>;
  /** The roles this run created and has not dropped yet. */
  owned(): readonly string[];
  /** Drop every owned role (its grants first, newest first); throws listing every failure. */
  cleanup(): Promise<void>;
}

export const makeProbeRoleLedger = (run: SqlRunner): ProbeRoleLedger => {
  const owned: string[] = [];
  return {
    async create(role) {
      assertSafeRole(role);
      await run(`create role ${role} nologin`);
      owned.push(role);
    },
    owned: () => [...owned],
    async cleanup() {
      const failures: string[] = [];
      for (const role of [...owned].reverse()) {
        try {
          await run(`drop owned by ${role}`);
          await run(`drop role ${role}`);
          owned.splice(owned.indexOf(role), 1);
        } catch (error) {
          failures.push(`${role}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`probe role cleanup failed (roles left in place): ${failures.join('; ')}`);
      }
    },
  };
};
