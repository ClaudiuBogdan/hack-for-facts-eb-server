import { Value } from '@sinclair/typebox/value';
import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import {
  createDatabaseError,
  normalizeOptionalString,
  type PublicDebateSelfSendContext,
  type PublicDebateSelfSendContextLookup,
} from '@/modules/institution-correspondence/index.js';

import {
  DebateRequestPayloadSchema,
  DEBATE_REQUEST_INTERACTION_ID,
} from './public-debate-request-dispatcher.js';

import type { UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

export interface PublicDebateSelfSendContextLookupConfig {
  db: UserDbClient;
  logger: Logger;
}

interface QueryRow {
  user_id: string;
  record_key: string;
  record: {
    scope?: {
      type?: string;
      entityCui?: string;
    };
    value?: {
      kind?: string;
      json?: {
        value?: Record<string, unknown>;
      };
    };
    updatedAt?: string;
    submittedAt?: string | null;
  };
}

function mapRow(row: QueryRow): PublicDebateSelfSendContext | null {
  if (
    row.record.scope?.type !== 'entity' ||
    typeof row.record.scope.entityCui !== 'string' ||
    row.record.value?.kind !== 'json'
  ) {
    return null;
  }

  const payload = row.record.value.json?.value;
  if (payload === undefined || !Value.Check(DebateRequestPayloadSchema, payload)) {
    return null;
  }

  if (payload.submissionPath !== 'send_yourself' || typeof payload.threadKey !== 'string') {
    return null;
  }

  return {
    userId: row.user_id,
    recordKey: row.record_key,
    entityCui: row.record.scope.entityCui,
    institutionEmail: payload.primariaEmail,
    requesterOrganizationName: normalizeOptionalString(payload.organizationName),
    ngoSenderEmail: normalizeOptionalString(payload.ngoSenderEmail),
    threadKey: payload.threadKey,
    submittedAt: normalizeOptionalString(payload.submittedAt),
  };
}

export function makePublicDebateSelfSendContextLookup(
  config: PublicDebateSelfSendContextLookupConfig
): PublicDebateSelfSendContextLookup {
  const log = config.logger.child({ component: 'PublicDebateSelfSendContextLookup' });

  return {
    async findByThreadKey(threadKey) {
      try {
        const rows = await config.db
          .selectFrom('userinteractions')
          .select(['user_id', 'record_key', 'record'])
          .where(sql<boolean>`record->>'interactionId' = ${DEBATE_REQUEST_INTERACTION_ID}`)
          .where(sql<boolean>`record->'value'->>'kind' = 'json'`)
          .where(sql<boolean>`record->'value'->'json'->'value'->>'threadKey' = ${threadKey}`)
          .orderBy('updated_at', 'desc')
          .limit(2)
          .execute();

        if (rows.length > 1) {
          log.warn(
            { threadKey },
            'Multiple self-send interaction records matched the same thread key'
          );
          return ok(null);
        }

        const row = rows[0] as QueryRow | undefined;
        if (row === undefined) {
          return ok(null);
        }

        return ok(mapRow(row));
      } catch (error) {
        log.error(
          { error, threadKey },
          'Failed to load self-send interaction context by thread key'
        );
        return err(
          createDatabaseError('Failed to load self-send interaction context by thread key', error)
        );
      }
    },
  };
}
