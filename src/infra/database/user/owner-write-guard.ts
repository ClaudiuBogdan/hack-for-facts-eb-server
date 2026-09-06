import { createHash } from 'node:crypto';

import { acquireUserDataOwnerLock } from './advisory-locks.js';

import type { UserDatabase } from './types.js';
import type { Transaction } from 'kysely';

export class UserDataOwnerDeletedError extends Error {
  constructor() {
    super('This account can no longer write user data');
    this.name = 'UserDataOwnerDeletedError';
  }
}

/** Call first in a READ COMMITTED transaction and retain its lock through the write. */
export async function assertUserDataOwnerCanWrite(
  trx: Transaction<UserDatabase>,
  ownerId: string
): Promise<void> {
  // Do not admit an identity that deletion would canonicalize differently.
  if (ownerId === '' || ownerId !== ownerId.trim()) throw new UserDataOwnerDeletedError();
  await acquireUserDataOwnerLock(trx, ownerId);
  const marker = await trx
    .selectFrom('userdataanonymizationaudit')
    .select('user_id_hash')
    .where('user_id_hash', '=', createHash('sha256').update(ownerId).digest('hex'))
    .executeTakeFirst();
  // Started and failed deletion runs also prohibit writes. Markers never expire.
  if (marker !== undefined) throw new UserDataOwnerDeletedError();
}
