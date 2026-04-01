import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import {
  DEBATE_REQUEST_INTERACTION_ID,
  parseDebateRequestPayloadValue,
} from '@/common/public-debate-request.js';
import {
  EMAIL_REGEX,
  buildSelfSendInteractionKey,
  createDatabaseError,
  normalizeOptionalString,
  type PublicDebateSelfSendContext,
  type PublicDebateSelfSendContextLookup,
  type PublicDebateSelfSendContextMatch,
} from '@/modules/institution-correspondence/index.js';

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
  };
  created_at: unknown;
  updated_at: unknown;
}

interface CandidateMatch {
  context: PublicDebateSelfSendContext;
  interactionKey: string;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
}

const parseInteractionKey = (
  interactionKey: string
): { associationEmail: string; preparedSubject: string } | null => {
  const separatorIndex = interactionKey.indexOf('\n');
  if (separatorIndex <= 0 || separatorIndex === interactionKey.length - 1) {
    return null;
  }

  return {
    associationEmail: interactionKey.slice(0, separatorIndex),
    preparedSubject: interactionKey.slice(separatorIndex + 1),
  };
};

const toIsoString = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value !== null && 'toISOString' in value) {
    return (value as { toISOString: () => string }).toISOString();
  }

  throw new Error(`Unexpected timestamp value in self-send context lookup: ${String(value)}`);
};

const compareTimestampInstants = (leftTimestamp: string, rightTimestamp: string): number => {
  const leftMilliseconds = Date.parse(leftTimestamp);
  const rightMilliseconds = Date.parse(rightTimestamp);

  if (!Number.isNaN(leftMilliseconds) && !Number.isNaN(rightMilliseconds)) {
    if (leftMilliseconds < rightMilliseconds) return -1;
    if (leftMilliseconds > rightMilliseconds) return 1;
    return 0;
  }

  return leftTimestamp.localeCompare(rightTimestamp);
};

const compareCandidates = (left: CandidateMatch, right: CandidateMatch): number => {
  const leftPrimary = left.submittedAt ?? left.updatedAt;
  const rightPrimary = right.submittedAt ?? right.updatedAt;

  const submittedOrder = compareTimestampInstants(leftPrimary, rightPrimary);
  if (submittedOrder !== 0) {
    return submittedOrder;
  }

  const createdOrder = compareTimestampInstants(left.createdAt, right.createdAt);
  if (createdOrder !== 0) {
    return createdOrder;
  }

  return left.context.recordKey.localeCompare(right.context.recordKey);
};

function mapRow(row: QueryRow): CandidateMatch | null {
  if (
    row.record.scope?.type !== 'entity' ||
    typeof row.record.scope.entityCui !== 'string' ||
    row.record.value?.kind !== 'json'
  ) {
    return null;
  }

  const payload = row.record.value.json?.value;
  const parsedPayload = payload !== undefined ? parseDebateRequestPayloadValue(payload) : null;
  if (parsedPayload === null) {
    return null;
  }

  if (parsedPayload.submissionPath !== 'send_yourself') {
    return null;
  }

  const associationEmail = normalizeOptionalString(parsedPayload.ngoSenderEmail);
  const preparedSubject = normalizeOptionalString(parsedPayload.preparedSubject);
  if (
    associationEmail === null ||
    !EMAIL_REGEX.test(associationEmail) ||
    preparedSubject === null
  ) {
    return null;
  }

  return {
    context: {
      userId: row.user_id,
      recordKey: row.record_key,
      entityCui: row.record.scope.entityCui,
      institutionEmail: parsedPayload.primariaEmail,
      requesterOrganizationName: normalizeOptionalString(parsedPayload.organizationName),
      ngoSenderEmail: associationEmail,
      preparedSubject,
      submittedAt: normalizeOptionalString(parsedPayload.submittedAt),
    },
    interactionKey: buildSelfSendInteractionKey(associationEmail, preparedSubject),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    submittedAt: normalizeOptionalString(parsedPayload.submittedAt),
  };
}

export function makePublicDebateSelfSendContextLookup(
  config: PublicDebateSelfSendContextLookupConfig
): PublicDebateSelfSendContextLookup {
  const log = config.logger.child({ component: 'PublicDebateSelfSendContextLookup' });

  return {
    async findByInteractionKey(interactionKey) {
      try {
        const parsedInteractionKey = parseInteractionKey(interactionKey);
        if (parsedInteractionKey === null) {
          return ok(null);
        }

        const rows = await config.db
          .selectFrom('userinteractions')
          .select(['user_id', 'record_key', 'record', 'created_at', 'updated_at'])
          .where(sql<boolean>`record->>'interactionId' = ${DEBATE_REQUEST_INTERACTION_ID}`)
          .where(sql<boolean>`record->'value'->>'kind' = 'json'`)
          .where(
            sql<boolean>`record->'value'->'json'->'value'->>'submissionPath' = ${'send_yourself'}`
          )
          .where(
            sql<boolean>`lower(trim(record->'value'->'json'->'value'->>'ngoSenderEmail')) = ${parsedInteractionKey.associationEmail}`
          )
          .where(
            sql<boolean>`lower(regexp_replace(trim(record->'value'->'json'->'value'->>'preparedSubject'), '[[:space:]]+', ' ', 'g')) = ${parsedInteractionKey.preparedSubject}`
          )
          .execute();

        const matches = rows
          .map((row) => mapRow(row as unknown as QueryRow))
          .filter((row): row is CandidateMatch => row !== null)
          .filter((row) => row.interactionKey === interactionKey)
          .sort(compareCandidates);

        if (matches.length === 0) {
          return ok(null);
        }

        if (matches.length > 1) {
          log.warn(
            { interactionKey, matchCount: matches.length },
            'Multiple self-send interaction records matched the same interaction key'
          );
        }

        const chosen = matches[0];
        if (chosen === undefined) {
          return ok(null);
        }

        return ok({
          context: chosen.context,
          interactionKey,
          matchCount: matches.length,
        } satisfies PublicDebateSelfSendContextMatch);
      } catch (error) {
        log.error(
          { error, interactionKey },
          'Failed to load self-send interaction context by interaction key'
        );
        return err(
          createDatabaseError(
            'Failed to load self-send interaction context by interaction key',
            error
          )
        );
      }
    },
  };
}
