import { sql } from 'kysely';

import { type UserDbClient } from '@/infra/database/client.js';

export interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

export const deferred = (): Deferred => {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
};

export const waitForBlockedAdvisoryLock = async (db: UserDbClient): Promise<void> => {
  // Generous window: the container may run emulated (amd64 image on arm64).
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await sql<{ count: string }>`
      SELECT COUNT(*)::text AS count
      FROM pg_locks
      WHERE locktype = 'advisory' AND granted = false
    `.execute(db);
    if (result.rows[0]?.count !== '0') return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for a blocked advisory lock');
};
