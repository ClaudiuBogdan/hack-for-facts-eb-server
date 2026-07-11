import { createHash } from 'node:crypto';

import { sql, type Transaction } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import type { UserDbClient } from '@/infra/database/client.js';
import type { UserDatabase } from '@/infra/database/user/types.js';
import type { Logger } from 'pino';

const ANONYMIZED_USER_ID_PREFIX = 'deleted-user:';
const ANONYMIZED_MAP_TITLE = 'Deleted user map';
const ANONYMIZED_DATASET_TITLE = 'Deleted user dataset';
const ANONYMIZED_EMAIL_SUBJECT = 'Anonymized email';
const ANONYMIZED_CORRESPONDENCE_SUBJECT = 'Anonymized correspondence';
const ANONYMIZED_RESPONSE_MESSAGE = 'Anonymized response';
const REDACTED_EMAIL_ADDRESS = 'redacted@example.invalid';

const EMAIL_FIELD_KEYS = new Set([
  'email',
  'emailaddress',
  'emailaddresses',
  'toemail',
  'fromemail',
  'recipientemail',
  'senderemail',
  'institutionemailoverride',
]);

const CLIENT_FIELD_KEYS = new Set([
  'sourceclientid',
  'sourceclienteventid',
  'clientid',
  'clienteventid',
]);

const NETWORK_FIELD_KEYS = new Set([
  'ip',
  'ipaddress',
  'clickipaddress',
  'useragent',
  'clickuseragent',
]);

type JsonObject = Record<string, unknown>;

interface OutboxRow {
  id: string;
  metadata: unknown;
  resend_email_id: string | null;
}

interface ThreadRow {
  id: string;
  record: unknown;
}

interface ResendWebhookRow {
  id: string;
  metadata: unknown;
}

export interface UserDataAnonymizationInput {
  userId: string;
  svixId: string;
  eventType: string;
  eventTimestamp: number;
}

export interface UserDataAnonymizationSummary {
  anonymizedUserId: string;
  shortLinksDeleted: number;
  shortLinksUpdated: number;
  notificationsUpdated: number;
  outboxRowsUpdated: number;
  userInteractionsUpdated: number;
  userInteractionConflictsDeleted: number;
  campaignRunPlansDeleted: number;
  institutionThreadsUpdated: number;
  resendWebhookEventsUpdated: number;
  advancedMapRowsUpdated: number;
  advancedMapSnapshotsUpdated: number;
  advancedDatasetRowsUpdated: number;
  advancedDatasetValueRowsDeleted: number;
  insDatasetRequestsUpdated: number;
  agentConversationsDeleted: number;
  notificationPlatformRowsUpdated?: number;
  userDataStoreRecords: number;
  userDataStoreEvents: number;
  userDataStoreReceipts: number;
}

export interface UserDataAnonymizationError {
  type: 'DatabaseError';
  message: string;
  retryable: true;
}

export interface UserDataAnonymizer {
  anonymizeDeletedUser(
    input: UserDataAnonymizationInput
  ): Promise<Result<UserDataAnonymizationSummary, UserDataAnonymizationError>>;
}

export interface UserDataAnonymizationAdminNotification {
  userIdHash: string;
  anonymizedUserId: string;
  svixId: string;
  eventType: string;
  eventTimestamp: number;
  completedAt: Date;
  summary: UserDataAnonymizationSummary;
}

export interface UserDataAnonymizationAdminNotifier {
  notifyCompleted(input: UserDataAnonymizationAdminNotification): Promise<void>;
}

export interface UserDataAnonymizerDeps {
  db: UserDbClient;
  logger: Logger;
  adminNotifier?: UserDataAnonymizationAdminNotifier;
  userDataStoreEraser?: {
    eraseOwner(input: {
      ownerId: string;
      anonymizedOwnerId: string;
      now: Date;
    }): Promise<
      Result<
        { records: number; events: number; receipts: number },
        { type: string; message?: string }
      >
    >;
  };
}

interface MutationResult {
  readonly numUpdatedRows?: bigint;
  readonly numDeletedRows?: bigint;
  readonly numAffectedRows?: bigint;
}

const toMutationCount = (result: MutationResult): number => {
  const count = result.numUpdatedRows ?? result.numDeletedRows ?? result.numAffectedRows ?? 0n;
  return Number(count);
};

const createDatabaseError = (message: string, cause: unknown): UserDataAnonymizationError => ({
  type: 'DatabaseError',
  message: cause instanceof Error ? `${message}: ${cause.message}` : message,
  retryable: true,
});

const hashValue = (value: string): string => createHash('sha256').update(value).digest('hex');

export const buildAnonymizedUserId = (userId: string): string =>
  `${ANONYMIZED_USER_ID_PREFIX}${hashValue(userId)}`;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const normalizeJsonObject = (value: unknown): JsonObject => (isObject(value) ? value : {});

const normalizeJsonArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const keyMatches = (key: string, candidates: ReadonlySet<string>): boolean =>
  candidates.has(key.toLowerCase().replaceAll('_', ''));

const replaceDeletedUserString = (
  value: string,
  userId: string,
  anonymizedUserId: string
): string => (value === userId || value === anonymizedUserId ? anonymizedUserId : value);

function sanitizeJsonValueForDeletedUser(
  value: unknown,
  input: {
    userId: string;
    anonymizedUserId: string;
    redactEmailFields: boolean;
    redactNetworkFields: boolean;
  }
): unknown {
  if (typeof value === 'string') {
    return replaceDeletedUserString(value, input.userId, input.anonymizedUserId);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValueForDeletedUser(entry, input));
  }

  if (!isObject(value)) {
    return value;
  }

  const sanitized: JsonObject = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (keyMatches(key, CLIENT_FIELD_KEYS)) {
      continue;
    }

    if (input.redactEmailFields && keyMatches(key, EMAIL_FIELD_KEYS)) {
      sanitized[key] = null;
      continue;
    }

    if (input.redactNetworkFields && keyMatches(key, NETWORK_FIELD_KEYS)) {
      sanitized[key] = null;
      continue;
    }

    sanitized[key] = sanitizeJsonValueForDeletedUser(entryValue, input);
  }

  return sanitized;
}

export const sanitizeMetadataForDeletedUser = (
  metadata: unknown,
  input: { userId: string; anonymizedUserId: string; redactEmailFields?: boolean }
): JsonObject =>
  normalizeJsonObject(
    sanitizeJsonValueForDeletedUser(metadata, {
      userId: input.userId,
      anonymizedUserId: input.anonymizedUserId,
      redactEmailFields: input.redactEmailFields ?? true,
      redactNetworkFields: true,
    })
  );

export const sanitizeUserInteractionRecordForDeletedUser = (
  record: unknown,
  input: { userId: string; anonymizedUserId: string }
): JsonObject => {
  const sanitized = normalizeJsonObject(
    sanitizeJsonValueForDeletedUser(record, {
      userId: input.userId,
      anonymizedUserId: input.anonymizedUserId,
      redactEmailFields: true,
      redactNetworkFields: true,
    })
  );

  sanitized['value'] = null;
  delete sanitized['sourceUrl'];

  const result = sanitized['result'];
  if (isObject(result)) {
    const { feedbackText, response, ...publicResult } = result;
    void feedbackText;
    void response;
    sanitized['result'] = publicResult;
  }

  const review = sanitized['review'];
  if (isObject(review)) {
    const { reviewedByUserId, ...publicReview } = review;
    void reviewedByUserId;
    sanitized['review'] = publicReview;
  }

  return sanitized;
};

const sanitizeAddressArray = (value: unknown): string[] => {
  void value;
  return [];
};

const sanitizeCorrespondenceEntryForDeletedUser = (
  entry: unknown,
  input: {
    userId: string;
    anonymizedUserId: string;
    redactContent: boolean;
  }
): unknown => {
  const sanitized = normalizeJsonObject(
    sanitizeJsonValueForDeletedUser(entry, {
      userId: input.userId,
      anonymizedUserId: input.anonymizedUserId,
      redactEmailFields: input.redactContent,
      redactNetworkFields: true,
    })
  );

  if (!input.redactContent) {
    return sanitized;
  }

  return {
    ...sanitized,
    fromAddress: REDACTED_EMAIL_ADDRESS,
    toAddresses: sanitizeAddressArray(sanitized['toAddresses']),
    ccAddresses: sanitizeAddressArray(sanitized['ccAddresses']),
    bccAddresses: sanitizeAddressArray(sanitized['bccAddresses']),
    subject: ANONYMIZED_CORRESPONDENCE_SUBJECT,
    textBody: null,
    htmlBody: null,
    headers: {},
    attachments: [],
    metadata: sanitizeMetadataForDeletedUser(sanitized['metadata'], {
      userId: input.userId,
      anonymizedUserId: input.anonymizedUserId,
      redactEmailFields: true,
    }),
  };
};

const sanitizeAdminWorkflowForDeletedUser = (
  value: unknown,
  input: {
    userId: string;
    anonymizedUserId: string;
    redactContent: boolean;
  }
): unknown => {
  const workflow = normalizeJsonObject(
    sanitizeJsonValueForDeletedUser(value, {
      userId: input.userId,
      anonymizedUserId: input.anonymizedUserId,
      redactEmailFields: false,
      redactNetworkFields: true,
    })
  );
  const responseEvents = normalizeJsonArray(workflow['responseEvents']);

  return {
    ...workflow,
    responseEvents: responseEvents.map((event) => {
      const eventObject = normalizeJsonObject(event);
      return {
        ...eventObject,
        ...(typeof eventObject['actorUserId'] === 'string'
          ? {
              actorUserId: replaceDeletedUserString(
                eventObject['actorUserId'],
                input.userId,
                input.anonymizedUserId
              ),
            }
          : {}),
        ...(input.redactContent ? { messageContent: ANONYMIZED_RESPONSE_MESSAGE } : {}),
      };
    }),
  };
};

export const sanitizeCorrespondenceThreadRecordForDeletedUser = (
  record: unknown,
  input: { userId: string; anonymizedUserId: string }
): JsonObject => {
  const recordObject = normalizeJsonObject(record);
  const ownerUserId = recordObject['ownerUserId'];
  const ownerMatchesDeletedUser =
    ownerUserId === input.userId || ownerUserId === input.anonymizedUserId;

  const sanitized = normalizeJsonObject(
    sanitizeJsonValueForDeletedUser(recordObject, {
      userId: input.userId,
      anonymizedUserId: input.anonymizedUserId,
      redactEmailFields: ownerMatchesDeletedUser,
      redactNetworkFields: true,
    })
  );

  if (ownerMatchesDeletedUser) {
    sanitized['ownerUserId'] = input.anonymizedUserId;
    sanitized['requesterOrganizationName'] = null;
    sanitized['subject'] = ANONYMIZED_CORRESPONDENCE_SUBJECT;
    sanitized['correspondence'] = normalizeJsonArray(sanitized['correspondence']).map((entry) =>
      sanitizeCorrespondenceEntryForDeletedUser(entry, {
        userId: input.userId,
        anonymizedUserId: input.anonymizedUserId,
        redactContent: true,
      })
    );

    const latestReview = sanitized['latestReview'];
    if (isObject(latestReview)) {
      sanitized['latestReview'] = {
        ...latestReview,
        notes: null,
      };
    }
  }

  if (sanitized['adminWorkflow'] !== undefined) {
    sanitized['adminWorkflow'] = sanitizeAdminWorkflowForDeletedUser(sanitized['adminWorkflow'], {
      userId: input.userId,
      anonymizedUserId: input.anonymizedUserId,
      redactContent: ownerMatchesDeletedUser,
    });
  }

  sanitized['metadata'] = sanitizeMetadataForDeletedUser(sanitized['metadata'], {
    userId: input.userId,
    anonymizedUserId: input.anonymizedUserId,
    redactEmailFields: ownerMatchesDeletedUser,
  });

  return sanitized;
};

const collectStringValuesByKey = (
  value: unknown,
  targetKey: string,
  values: Set<string> = new Set()
): Set<string> => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringValuesByKey(entry, targetKey, values);
    }
    return values;
  }

  if (!isObject(value)) {
    return values;
  }

  for (const [key, entryValue] of Object.entries(value)) {
    if (key === targetKey && typeof entryValue === 'string' && entryValue.trim() !== '') {
      values.add(entryValue);
    }
    collectStringValuesByKey(entryValue, targetKey, values);
  }

  return values;
};

const updateOutboxRows = async (
  trx: Transaction<UserDatabase>,
  rows: readonly OutboxRow[],
  input: { userId: string; anonymizedUserId: string; now: Date }
): Promise<number> => {
  for (const row of rows) {
    await trx
      .updateTable('notificationsoutbox')
      .set({
        user_id: input.anonymizedUserId,
        scope_key: `anonymized:${row.id}`,
        delivery_key: `anonymized:${row.id}`,
        to_email: null,
        rendered_subject: null,
        rendered_html: null,
        rendered_text: null,
        content_hash: null,
        status: sql`
          CASE
            WHEN status IN ('pending', 'composing', 'sending', 'failed_transient')
            THEN 'skipped_no_email'
            ELSE status
          END
        `,
        last_error: sql`
          CASE
            WHEN status IN ('pending', 'composing', 'sending', 'failed_transient')
            THEN 'User deleted; delivery anonymized'
            ELSE last_error
          END
        `,
        metadata: sanitizeMetadataForDeletedUser(row.metadata, {
          userId: input.userId,
          anonymizedUserId: input.anonymizedUserId,
          redactEmailFields: true,
        }),
      } as never)
      .where('id', '=', row.id)
      .execute();
  }

  void input.now;
  return rows.length;
};

const updateUserInteractions = async (
  trx: Transaction<UserDatabase>,
  input: { userId: string; anonymizedUserId: string; now: Date }
): Promise<{ updated: number; conflictsDeleted: number }> => {
  const conflictDeleteResult = await sql`
    DELETE FROM userinteractions AS original
    WHERE original.user_id = ${input.userId}
      AND EXISTS (
        SELECT 1
        FROM userinteractions AS anonymized
        WHERE anonymized.user_id = ${input.anonymizedUserId}
          AND anonymized.record_key = original.record_key
      )
  `.execute(trx);

  const rows = await trx
    .selectFrom('userinteractions')
    .select(['user_id', 'record_key', 'record'])
    .where('user_id', 'in', [input.userId, input.anonymizedUserId])
    .execute();

  for (const row of rows) {
    await trx
      .updateTable('userinteractions')
      .set({
        user_id: input.anonymizedUserId,
        record: sanitizeUserInteractionRecordForDeletedUser(row.record, {
          userId: input.userId,
          anonymizedUserId: input.anonymizedUserId,
        }),
        // A raw JS [] reaches jsonb as the pg array literal '{}' — an empty
        // OBJECT — which corrupts the audit array shape. Stringify it.
        audit_events: JSON.stringify([]),
        updated_at: input.now,
      } as never)
      .where('user_id', '=', row.user_id)
      .where('record_key', '=', row.record_key)
      .execute();
  }

  return {
    updated: rows.length,
    conflictsDeleted: Number(conflictDeleteResult.numAffectedRows ?? 0n),
  };
};

const updateInstitutionThreads = async (
  trx: Transaction<UserDatabase>,
  rows: readonly ThreadRow[],
  input: { userId: string; anonymizedUserId: string; now: Date }
): Promise<number> => {
  for (const row of rows) {
    await trx
      .updateTable('institutionemailthreads')
      .set({
        record: sanitizeCorrespondenceThreadRecordForDeletedUser(row.record, {
          userId: input.userId,
          anonymizedUserId: input.anonymizedUserId,
        }),
        updated_at: input.now,
      } as never)
      .where('id', '=', row.id)
      .execute();
  }

  return rows.length;
};

const updateResendWebhookEvents = async (
  trx: Transaction<UserDatabase>,
  resendEmailIds: ReadonlySet<string>,
  input: { userId: string; anonymizedUserId: string }
): Promise<number> => {
  const emailIds = [...resendEmailIds];
  if (emailIds.length === 0) {
    return 0;
  }

  const rows = await trx
    .selectFrom('resend_wh_emails')
    .select(['id', 'metadata'])
    .where('email_id', 'in', emailIds)
    .execute();

  for (const row of rows as ResendWebhookRow[]) {
    await trx
      .updateTable('resend_wh_emails')
      .set({
        from_address: REDACTED_EMAIL_ADDRESS,
        to_addresses: [],
        cc_addresses: [],
        bcc_addresses: [],
        message_id: null,
        subject: ANONYMIZED_EMAIL_SUBJECT,
        attachments_json: null,
        bounce_message: null,
        bounce_diagnostic_code: null,
        click_ip_address: null,
        click_link: null,
        click_user_agent: null,
        metadata: sanitizeMetadataForDeletedUser(row.metadata, {
          userId: input.userId,
          anonymizedUserId: input.anonymizedUserId,
          redactEmailFields: true,
        }),
      } as never)
      .where('id', '=', row.id)
      .execute();
  }

  return rows.length;
};

const insertAuditRow = async (
  trx: Transaction<UserDatabase>,
  input: {
    userIdHash: string;
    anonymizedUserId: string;
    svixId: string;
    eventType: string;
    eventTimestamp: number;
    completedAt: Date;
    summary: UserDataAnonymizationSummary;
  }
): Promise<void> => {
  await sql`
    INSERT INTO userdataanonymizationaudit (
      user_id_hash,
      anonymized_user_id,
      first_svix_id,
      latest_svix_id,
      clerk_event_type,
      clerk_event_timestamp,
      completed_at,
      run_count,
      summary
    )
    VALUES (
      ${input.userIdHash},
      ${input.anonymizedUserId},
      ${input.svixId},
      ${input.svixId},
      ${input.eventType},
      ${input.eventTimestamp},
      ${input.completedAt},
      1,
      ${JSON.stringify(input.summary)}::jsonb
    )
    ON CONFLICT (user_id_hash)
    DO UPDATE
    SET latest_svix_id = EXCLUDED.latest_svix_id,
        clerk_event_type = EXCLUDED.clerk_event_type,
        clerk_event_timestamp = EXCLUDED.clerk_event_timestamp,
        completed_at = EXCLUDED.completed_at,
        summary = EXCLUDED.summary
  `.execute(trx);
};

const markAuditStarted = async (
  db: UserDbClient,
  input: {
    userIdHash: string;
    anonymizedUserId: string;
    svixId: string;
    eventType: string;
    eventTimestamp: number;
    startedAt: Date;
  }
): Promise<void> => {
  await sql`
    INSERT INTO userdataanonymizationaudit (
      user_id_hash,
      anonymized_user_id,
      first_svix_id,
      latest_svix_id,
      clerk_event_type,
      clerk_event_timestamp,
      completed_at,
      run_count,
      summary
    )
    VALUES (
      ${input.userIdHash},
      ${input.anonymizedUserId},
      ${input.svixId},
      ${input.svixId},
      ${input.eventType},
      ${input.eventTimestamp},
      ${input.startedAt},
      1,
      ${JSON.stringify({ status: 'started' })}::jsonb
    )
    ON CONFLICT (user_id_hash)
    DO UPDATE
    SET latest_svix_id = EXCLUDED.latest_svix_id,
        clerk_event_type = EXCLUDED.clerk_event_type,
        clerk_event_timestamp = EXCLUDED.clerk_event_timestamp,
        completed_at = EXCLUDED.completed_at,
        run_count = userdataanonymizationaudit.run_count + 1,
        summary = EXCLUDED.summary
  `.execute(db);
};

const notifyAdminAnonymizationCompleted = (input: {
  notifier: UserDataAnonymizationAdminNotifier | undefined;
  log: Logger;
  notification: UserDataAnonymizationAdminNotification;
}): void => {
  if (input.notifier === undefined) {
    return;
  }

  void input.notifier.notifyCompleted(input.notification).catch((error: unknown) => {
    input.log.warn(
      {
        err: error,
        svixId: input.notification.svixId,
        anonymizedUserId: input.notification.anonymizedUserId,
      },
      'User data anonymization completed, but admin notification failed'
    );
  });
};

const anonymizeNotificationPlatformRows = async (
  trx: Transaction<UserDatabase>,
  input: { matchingUserIds: string[]; anonymizedUserId: string; now: Date }
): Promise<number> => {
  const attemptResult = await sql`
    UPDATE notification_delivery_attempts AS attempt
    SET destination_fingerprint = NULL,
        error_code = NULL,
        error_message = NULL,
        provider_ref = NULL
    WHERE EXISTS (
      SELECT 1
      FROM notification_deliveries AS delivery
      WHERE delivery.id = attempt.delivery_id
        AND delivery.user_id IN (${sql.join(input.matchingUserIds)})
    )
  `.execute(trx);

  const deliveryResult = await sql`
    UPDATE notification_deliveries
    SET user_id = CASE
          WHEN user_id IN (${sql.join(input.matchingUserIds)}) THEN ${input.anonymizedUserId}
          ELSE user_id
        END,
        destination_fingerprint = NULL,
        destination_generation = NULL,
        rendered_subject = NULL,
        rendered_html = NULL,
        rendered_text = NULL,
        content_hash = NULL,
        provider_idempotency_key = NULL,
        provider_ref = NULL,
        last_error_code = 'user_anonymized',
        last_error_message = NULL,
        status = CASE
          WHEN status IN ('pending_render','scheduled','ready','sending','retry_wait')
            THEN 'cancelled'
          ELSE status
        END,
        terminal_at = CASE
          WHEN status IN ('pending_render','scheduled','ready','sending','retry_wait')
            THEN COALESCE(terminal_at, ${input.now})
          ELSE terminal_at
        END,
        claim_token = NULL,
        claim_expires_at = NULL,
        updated_at = ${input.now}
    WHERE user_id IN (${sql.join(input.matchingUserIds)})
  `.execute(trx);

  const logicalResult = await sql`
    UPDATE logical_notifications
    SET user_id = ${input.anonymizedUserId},
        eligibility_reason = 'user_anonymized',
        recipient_facts = NULL,
        inbox_title = 'Notification unavailable',
        inbox_body = '',
        inbox_action_url = NULL,
        inbox_visible = FALSE,
        read_at = NULL,
        archived_at = NULL
    WHERE user_id IN (${sql.join(input.matchingUserIds)})
  `.execute(trx);

  const digestResult = await sql`
    UPDATE notification_digest_batches
    SET user_id = ${input.anonymizedUserId},
        status = CASE
          WHEN status IN ('open','materializing') THEN 'cancelled'
          ELSE status
        END,
        rendered_item_ids = '[]'::jsonb,
        overflow_count = NULL,
        claim_token = NULL,
        claim_expires_at = NULL,
        updated_at = ${input.now}
    WHERE user_id IN (${sql.join(input.matchingUserIds)})
  `.execute(trx);

  const auditResult = await sql`
    UPDATE notification_audit_log
    SET user_id = CASE
          WHEN user_id IN (${sql.join(input.matchingUserIds)}) THEN ${input.anonymizedUserId}
          ELSE user_id
        END,
        actor = CASE
          WHEN actor IN (${sql.join(input.matchingUserIds)}) THEN ${input.anonymizedUserId}
          ELSE actor
        END,
        reason = NULL,
        details = '{}'::jsonb
    WHERE user_id IN (${sql.join(input.matchingUserIds)})
       OR actor IN (${sql.join(input.matchingUserIds)})
  `.execute(trx);

  const subscriptionResult = await sql`
    DELETE FROM notification_subscriptions
    WHERE user_id IN (${sql.join(input.matchingUserIds)})
  `.execute(trx);
  const globalPreferenceResult = await sql`
    DELETE FROM notification_global_preferences
    WHERE user_id IN (${sql.join(input.matchingUserIds)})
  `.execute(trx);
  const channelPreferenceResult = await sql`
    DELETE FROM notification_channel_preferences
    WHERE user_id IN (${sql.join(input.matchingUserIds)})
  `.execute(trx);
  const destinationResult = await sql`
    DELETE FROM notification_channel_destinations
    WHERE user_id IN (${sql.join(input.matchingUserIds)})
  `.execute(trx);

  return [
    attemptResult,
    deliveryResult,
    logicalResult,
    digestResult,
    auditResult,
    subscriptionResult,
    globalPreferenceResult,
    channelPreferenceResult,
    destinationResult,
  ].reduce((count, result) => count + toMutationCount(result), 0);
};

const anonymizeDeletedUserInTransaction = async (
  trx: Transaction<UserDatabase>,
  input: UserDataAnonymizationInput,
  anonymizedUserId: string
): Promise<UserDataAnonymizationSummary> => {
  const now = new Date();
  const matchingUserIds = [input.userId, anonymizedUserId];

  const outboxRows = (await trx
    .selectFrom('notificationsoutbox')
    .select(['id', 'metadata', 'resend_email_id'])
    .where('user_id', 'in', matchingUserIds)
    .execute()) as OutboxRow[];

  const threadRows = (await trx
    .selectFrom('institutionemailthreads')
    .select(['id', 'record'])
    .where((eb) =>
      eb.or([
        sql<boolean>`record @> jsonb_build_object('ownerUserId', ${input.userId}::text)`,
        sql<boolean>`record @> jsonb_build_object('ownerUserId', ${anonymizedUserId}::text)`,
        sql<boolean>`record -> 'metadata' @> jsonb_build_object('userId', ${input.userId}::text)`,
        sql<boolean>`record -> 'metadata' @> jsonb_build_object('userId', ${anonymizedUserId}::text)`,
        sql<boolean>`record -> 'adminWorkflow' -> 'responseEvents' @> jsonb_build_array(jsonb_build_object('actorUserId', ${input.userId}::text))`,
        sql<boolean>`record -> 'adminWorkflow' -> 'responseEvents' @> jsonb_build_array(jsonb_build_object('actorUserId', ${anonymizedUserId}::text))`,
      ])
    )
    .execute()) as ThreadRow[];

  const advancedMapRows = await trx
    .selectFrom('advancedmapanalyticsmaps')
    .select(['id'])
    .where('user_id', 'in', matchingUserIds)
    .execute();
  const advancedMapIds = advancedMapRows.map((row) => row.id);

  const advancedDatasetRows = await trx
    .selectFrom('advancedmapdatasets')
    .select(['id'])
    .where('user_id', 'in', matchingUserIds)
    .execute();
  const advancedDatasetIds = advancedDatasetRows.map((row) => row.id);

  const resendEmailIds = new Set<string>();
  for (const row of outboxRows) {
    if (row.resend_email_id !== null && row.resend_email_id.trim() !== '') {
      resendEmailIds.add(row.resend_email_id);
    }
  }
  for (const row of threadRows) {
    for (const resendEmailId of collectStringValuesByKey(row.record, 'resendEmailId')) {
      resendEmailIds.add(resendEmailId);
    }
  }

  const shortLinksDeletedResult = await sql`
    DELETE FROM shortlinks
    WHERE ${input.userId} = ANY(user_ids)
      AND cardinality(array_remove(user_ids, ${input.userId})) = 0
  `.execute(trx);

  const shortLinksUpdatedResult = await sql`
    UPDATE shortlinks
    SET user_ids = array_remove(user_ids, ${input.userId})
    WHERE ${input.userId} = ANY(user_ids)
  `.execute(trx);

  const notificationsUpdatedResult = await trx
    .updateTable('notifications')
    .set({
      user_id: anonymizedUserId,
      is_active: false,
      config: { channels: { email: false }, anonymized: true },
      hash: sql<string>`concat('anonymized:', id)`,
      updated_at: now,
    } as never)
    .where('user_id', 'in', matchingUserIds)
    .executeTakeFirst();

  const outboxRowsUpdated = await updateOutboxRows(trx, outboxRows, {
    userId: input.userId,
    anonymizedUserId,
    now,
  });

  const userInteractionCounts = await updateUserInteractions(trx, {
    userId: input.userId,
    anonymizedUserId,
    now,
  });

  const campaignRunPlansDeletedResult = await sql`
    DELETE FROM campaignnotificationrunplans
    WHERE actor_user_id IN (${sql.join(matchingUserIds)})
      OR summary_json @> jsonb_build_object('userId', ${input.userId}::text)
      OR summary_json @> jsonb_build_object('userId', ${anonymizedUserId}::text)
      OR summary_json @> jsonb_build_object('actorUserId', ${input.userId}::text)
      OR summary_json @> jsonb_build_object('actorUserId', ${anonymizedUserId}::text)
      OR rows_json @> jsonb_build_array(jsonb_build_object('userId', ${input.userId}::text))
      OR rows_json @> jsonb_build_array(jsonb_build_object('userId', ${anonymizedUserId}::text))
      OR rows_json @> jsonb_build_array(jsonb_build_object('actorUserId', ${input.userId}::text))
      OR rows_json @> jsonb_build_array(jsonb_build_object('actorUserId', ${anonymizedUserId}::text))
  `.execute(trx);

  let advancedMapSnapshotsUpdated = 0;
  if (advancedMapIds.length > 0) {
    const snapshotsUpdatedResult = await trx
      .updateTable('advancedmapanalyticssnapshots')
      .set({
        title: ANONYMIZED_MAP_TITLE,
        description: null,
        snapshot: { anonymized: true },
      } as never)
      .where('map_id', 'in', advancedMapIds)
      .executeTakeFirst();
    advancedMapSnapshotsUpdated = toMutationCount(snapshotsUpdatedResult);
  }

  const advancedMapsUpdatedResult = await trx
    .updateTable('advancedmapanalyticsmaps')
    .set({
      user_id: anonymizedUserId,
      title: ANONYMIZED_MAP_TITLE,
      description: null,
      visibility: 'private',
      public_id: null,
      last_snapshot: null,
      last_snapshot_id: null,
      deleted_at: sql`COALESCE(deleted_at, ${now})`,
      updated_at: now,
    } as never)
    .where('user_id', 'in', matchingUserIds)
    .executeTakeFirst();

  let advancedDatasetValueRowsDeleted = 0;
  if (advancedDatasetIds.length > 0) {
    const datasetValuesDeletedResult = await trx
      .deleteFrom('advancedmapdatasetrows')
      .where('dataset_id', 'in', advancedDatasetIds)
      .executeTakeFirst();
    advancedDatasetValueRowsDeleted = toMutationCount(datasetValuesDeletedResult);
  }

  const advancedDatasetsUpdatedResult = await trx
    .updateTable('advancedmapdatasets')
    .set({
      user_id: anonymizedUserId,
      title: ANONYMIZED_DATASET_TITLE,
      description: null,
      markdown_text: null,
      unit: null,
      visibility: 'private',
      row_count: 0,
      replaced_at: sql`COALESCE(replaced_at, ${now})`,
      deleted_at: sql`COALESCE(deleted_at, ${now})`,
      updated_at: now,
    } as never)
    .where('user_id', 'in', matchingUserIds)
    .executeTakeFirst();

  // Keep the row so the "N people asked for this dataset" signal survives, but
  // strip the identity-bearing columns and the free-text note, which can name
  // the requester. Anonymous requests never persist contact_email or note (see
  // docs/USER-DATA-ANONYMIZATION.md), so every such value belongs to a row this
  // clerk_user_id match can reach.
  const insDatasetRequestsUpdatedResult = await trx
    .updateTable('ins_dataset_requests')
    .set({
      clerk_user_id: anonymizedUserId,
      contact_email: null,
      note: null,
    } as never)
    .where('clerk_user_id', 'in', matchingUserIds)
    .executeTakeFirst();

  // Agent messages contain the user's free-text prompts and generated history.
  // Hard-delete the owned conversation; the FK cascade removes every message.
  // Matching the deterministic anonymized id keeps webhook replays idempotent.
  const agentConversationsDeletedResult = await trx
    .deleteFrom('agentconversations')
    .where('user_id', 'in', matchingUserIds)
    .executeTakeFirst();

  const institutionThreadsUpdated = await updateInstitutionThreads(trx, threadRows, {
    userId: input.userId,
    anonymizedUserId,
    now,
  });

  const resendWebhookEventsUpdated = await updateResendWebhookEvents(trx, resendEmailIds, {
    userId: input.userId,
    anonymizedUserId,
  });

  const notificationPlatformRowsUpdated = await anonymizeNotificationPlatformRows(trx, {
    matchingUserIds,
    anonymizedUserId,
    now,
  });

  const summary: UserDataAnonymizationSummary = {
    anonymizedUserId,
    shortLinksDeleted: Number(shortLinksDeletedResult.numAffectedRows ?? 0n),
    shortLinksUpdated: Number(shortLinksUpdatedResult.numAffectedRows ?? 0n),
    notificationsUpdated: toMutationCount(notificationsUpdatedResult),
    outboxRowsUpdated,
    userInteractionsUpdated: userInteractionCounts.updated,
    userInteractionConflictsDeleted: userInteractionCounts.conflictsDeleted,
    campaignRunPlansDeleted: Number(campaignRunPlansDeletedResult.numAffectedRows ?? 0n),
    institutionThreadsUpdated,
    resendWebhookEventsUpdated,
    advancedMapRowsUpdated: toMutationCount(advancedMapsUpdatedResult),
    advancedMapSnapshotsUpdated,
    advancedDatasetRowsUpdated: toMutationCount(advancedDatasetsUpdatedResult),
    advancedDatasetValueRowsDeleted,
    insDatasetRequestsUpdated: toMutationCount(insDatasetRequestsUpdatedResult),
    agentConversationsDeleted: toMutationCount(agentConversationsDeletedResult),
    notificationPlatformRowsUpdated,
    userDataStoreRecords: 0,
    userDataStoreEvents: 0,
    userDataStoreReceipts: 0,
  };

  return summary;
};

export const makeUserDataAnonymizer = (deps: UserDataAnonymizerDeps): UserDataAnonymizer => {
  const log = deps.logger.child({ service: 'UserDataAnonymizer' });

  return {
    async anonymizeDeletedUser(input) {
      const userId = input.userId.trim();
      if (userId === '') {
        return err({
          type: 'DatabaseError',
          message: 'Cannot anonymize a deleted user without a user id',
          retryable: true,
        });
      }

      const anonymizedUserId = buildAnonymizedUserId(userId);
      const userIdHash = hashValue(userId);

      try {
        await markAuditStarted(deps.db, {
          userIdHash,
          anonymizedUserId,
          svixId: input.svixId,
          eventType: input.eventType,
          eventTimestamp: input.eventTimestamp,
          startedAt: new Date(),
        });

        const legacySummary = await deps.db.transaction().execute((trx) =>
          anonymizeDeletedUserInTransaction(
            trx,
            {
              ...input,
              userId,
            },
            anonymizedUserId
          )
        );

        const userDataStoreResult =
          deps.userDataStoreEraser === undefined
            ? ok({ records: 0, events: 0, receipts: 0 })
            : await deps.userDataStoreEraser.eraseOwner({
                ownerId: userId,
                anonymizedOwnerId: anonymizedUserId,
                now: new Date(),
              });
        if (userDataStoreResult.isErr()) {
          const eraserMessage = userDataStoreResult.error.message;
          log.error(
            { userIdHash, errorType: userDataStoreResult.error.type },
            'Failed to erase User Data Store during Clerk deletion'
          );
          return err({
            type: 'DatabaseError',
            message: `Failed to erase User Data Store: ${userDataStoreResult.error.type}${eraserMessage === undefined ? '' : `: ${eraserMessage}`}`,
            retryable: true,
          });
        }
        const summary: UserDataAnonymizationSummary = {
          ...legacySummary,
          userDataStoreRecords: userDataStoreResult.value.records,
          userDataStoreEvents: userDataStoreResult.value.events,
          userDataStoreReceipts: userDataStoreResult.value.receipts,
        };
        const completedAt = new Date();
        await deps.db.transaction().execute((trx) =>
          insertAuditRow(trx, {
            userIdHash,
            anonymizedUserId,
            svixId: input.svixId,
            eventType: input.eventType,
            eventTimestamp: input.eventTimestamp,
            completedAt,
            summary,
          })
        );

        log.info(
          { svixId: input.svixId, anonymizedUserId, summary },
          'Clerk deleted user data anonymization completed'
        );

        notifyAdminAnonymizationCompleted({
          notifier: deps.adminNotifier,
          log,
          notification: {
            userIdHash,
            anonymizedUserId,
            svixId: input.svixId,
            eventType: input.eventType,
            eventTimestamp: input.eventTimestamp,
            completedAt,
            summary,
          },
        });

        return ok(summary);
      } catch (error) {
        log.error({ err: error, userIdHash }, 'Failed to anonymize user data');
        return err(createDatabaseError('Failed to anonymize user data', error));
      }
    },
  };
};
