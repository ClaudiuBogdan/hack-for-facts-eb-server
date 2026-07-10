import { createHash } from 'node:crypto';

import { err, ok } from 'neverthrow';

import { toDatabaseError } from './repo-helpers.js';

import type { AnonymizationCheckPort } from '../../core/delivery/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';

const ANONYMIZED_USER_ID_PREFIX = 'deleted-user:';

const hashUserId = (userId: string): string => createHash('sha256').update(userId).digest('hex');

export const makeAnonymizationCheckRepo = (db: UserDbClient): AnonymizationCheckPort => ({
  async isUserAnonymized(userId) {
    if (userId.startsWith(ANONYMIZED_USER_ID_PREFIX)) {
      return ok(true);
    }

    const userIdHash = hashUserId(userId);
    try {
      const row = await db
        .selectFrom('userdataanonymizationaudit')
        .select('id')
        .where((eb) =>
          eb.or([
            eb('user_id_hash', '=', userIdHash),
            eb('anonymized_user_id', '=', `${ANONYMIZED_USER_ID_PREFIX}${userIdHash}`),
          ])
        )
        .executeTakeFirst();
      return ok(row !== undefined);
    } catch (error) {
      return err(toDatabaseError('Check notification user anonymization state', error));
    }
  },
});
