import { ok, err, type Result } from 'neverthrow';

import { createDatabaseError, type InstitutionCorrespondenceError } from '../../core/errors.js';

import type { ReconcilePlatformSendSuccessInput } from '../../core/usecases/reconcile-platform-send-success-input.js';
import type { PlatformSendSuccessEvidenceLookup } from '../../core/usecases/recover-platform-send-success-confirmation.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

export interface PlatformSendSuccessEvidenceLookupConfig {
  db: UserDbClient;
  logger: Logger;
}

export const makePlatformSendSuccessEvidenceLookup = (
  config: PlatformSendSuccessEvidenceLookupConfig
): PlatformSendSuccessEvidenceLookup => {
  const { db, logger } = config;
  const log = logger.child({ repo: 'PlatformSendSuccessEvidenceLookup' });

  return {
    async findLatestSuccessfulSendByThreadKey(
      threadKey: string
    ): Promise<Result<ReconcilePlatformSendSuccessInput | null, InstitutionCorrespondenceError>> {
      try {
        const row = await db
          .selectFrom('resend_wh_emails')
          .select([
            'thread_key',
            'email_id',
            'message_id',
            'email_created_at',
            'event_created_at',
            'from_address',
            'to_addresses',
            'cc_addresses',
            'bcc_addresses',
            'subject',
          ])
          .where('thread_key', '=', threadKey)
          .where('event_type', 'in', ['email.sent', 'email.delivered'])
          .orderBy('email_created_at', 'desc')
          .orderBy('webhook_received_at', 'desc')
          .executeTakeFirst();

        if (row?.thread_key == null) {
          return ok(null);
        }

        return ok({
          threadKey: row.thread_key,
          resendEmailId: row.email_id,
          ...(row.message_id !== null ? { messageId: row.message_id } : {}),
          observedAt:
            row.email_created_at instanceof Date
              ? row.email_created_at
              : new Date(String(row.email_created_at)),
          fromAddress: row.from_address,
          toAddresses: row.to_addresses,
          ccAddresses: row.cc_addresses,
          bccAddresses: row.bcc_addresses,
          subject: row.subject,
        });
      } catch (error) {
        log.error(
          { error, threadKey },
          'Failed to load latest successful platform-send evidence by thread key'
        );
        return err(
          createDatabaseError(
            'Failed to load latest successful platform-send evidence by thread key',
            error
          )
        );
      }
    },
  };
};
