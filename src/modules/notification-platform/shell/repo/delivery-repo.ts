import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import {
  decodeTimestampCursor,
  encodeTimestampCursor,
  mapDelivery,
  toDatabaseError,
} from './repo-helpers.js';
import { createInvalidDeliveryTransitionError } from '../../core/delivery/errors.js';
import { canTransition } from '../../core/delivery/state-machine.js';
import {
  TERMINAL_DELIVERY_STATES,
  type DeliveryPatch,
  type DeliveryState,
} from '../../core/delivery/types.js';
import { createValidationError } from '../../core/shared/errors.js';

import type { DeliveryRepo } from '../../core/delivery/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';

const CANCELLABLE_DELIVERY_STATES: readonly DeliveryState[] = [
  'pending_render',
  'scheduled',
  'ready',
  'sending',
  'retry_wait',
];

const DEAD_LETTER_STATES: readonly DeliveryState[] = ['dead_letter', 'unknown', 'permanent_failed'];

const patchValues = (patch: DeliveryPatch | undefined): Record<string, unknown> => ({
  ...(patch?.notBefore !== undefined ? { not_before: patch.notBefore } : {}),
  ...(patch?.nextAttemptAt !== undefined ? { next_attempt_at: patch.nextAttemptAt } : {}),
  ...(patch?.destinationFingerprint !== undefined
    ? { destination_fingerprint: patch.destinationFingerprint }
    : {}),
  ...(patch?.destinationGeneration !== undefined
    ? { destination_generation: patch.destinationGeneration }
    : {}),
  ...(patch?.providerIdempotencyKey !== undefined
    ? { provider_idempotency_key: patch.providerIdempotencyKey }
    : {}),
  ...(patch?.providerRef !== undefined ? { provider_ref: patch.providerRef } : {}),
  ...(patch?.lastErrorCode !== undefined ? { last_error_code: patch.lastErrorCode } : {}),
  ...(patch?.lastErrorMessage !== undefined ? { last_error_message: patch.lastErrorMessage } : {}),
  ...(patch?.acceptedAt !== undefined ? { accepted_at: patch.acceptedAt } : {}),
  ...(patch?.terminalAt !== undefined ? { terminal_at: patch.terminalAt } : {}),
  ...(patch?.attemptCount !== undefined ? { attempt_count: patch.attemptCount } : {}),
  ...(patch?.claimToken !== undefined ? { claim_token: patch.claimToken } : {}),
  ...(patch?.claimExpiresAt !== undefined ? { claim_expires_at: patch.claimExpiresAt } : {}),
});

export class KyselyDeliveryRepo implements DeliveryRepo {
  public constructor(private readonly db: UserDbClient) {}

  public async insertIdempotent(input: Parameters<DeliveryRepo['insertIdempotent']>[0]) {
    try {
      const inserted = await this.db
        .insertInto('notification_deliveries')
        .values({
          id: input.id,
          delivery_key: input.deliveryKey,
          logical_notification_id: input.logicalNotificationId,
          digest_batch_id: input.digestBatchId,
          kind_id: input.kindId,
          user_id: input.userId,
          channel: input.channel,
          destination_fingerprint: input.destinationFingerprint,
          destination_generation: input.destinationGeneration,
          template_id: input.templateId,
          template_version: input.templateVersion,
          rendered_subject: null,
          rendered_html: null,
          rendered_text: null,
          content_hash: null,
          status: input.status,
          not_before: input.notBefore,
          expires_at: input.expiresAt,
          stream_key: input.streamKey,
          stream_sequence: input.streamSequence,
          attempt_count: 0,
          next_attempt_at: null,
          claim_token: null,
          claim_expires_at: null,
          provider_idempotency_key: null,
          provider_ref: null,
          last_error_code: null,
          last_error_message: null,
          sender_mode: input.senderMode,
          created_at: input.now,
          updated_at: input.now,
          accepted_at: null,
          terminal_at: null,
          retention_expires_at: input.retentionExpiresAt,
        })
        .onConflict((conflict) => conflict.column('delivery_key').doNothing())
        .returningAll()
        .executeTakeFirst();

      if (inserted !== undefined) {
        return ok({
          delivery: mapDelivery(inserted as unknown as Record<string, unknown>),
          created: true,
        });
      }

      const existing = await this.db
        .selectFrom('notification_deliveries')
        .selectAll()
        .where('delivery_key', '=', input.deliveryKey)
        .executeTakeFirst();
      if (existing === undefined) {
        return err(
          toDatabaseError('Find delivery after idempotency conflict', new Error('row missing'))
        );
      }
      return ok({
        delivery: mapDelivery(existing as unknown as Record<string, unknown>),
        created: false,
      });
    } catch (error) {
      return err(toDatabaseError('Insert or find notification delivery', error));
    }
  }

  public async findById(id: string) {
    try {
      const row = await this.db
        .selectFrom('notification_deliveries')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapDelivery(row as unknown as Record<string, unknown>));
    } catch (error) {
      return err(toDatabaseError('Find notification delivery by id', error));
    }
  }

  public async findByProviderRef(providerRef: string) {
    try {
      const row = await this.db
        .selectFrom('notification_deliveries')
        .selectAll()
        .where('provider_ref', '=', providerRef)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapDelivery(row as unknown as Record<string, unknown>));
    } catch (error) {
      return err(toDatabaseError('Find notification delivery by provider reference', error));
    }
  }

  public async listByLogicalNotification(logicalNotificationId: string) {
    try {
      const rows = await this.db
        .selectFrom('notification_deliveries')
        .selectAll()
        .where('logical_notification_id', '=', logicalNotificationId)
        .orderBy('delivery_key', 'asc')
        .execute();
      return ok(rows.map((row) => mapDelivery(row as unknown as Record<string, unknown>)));
    } catch (error) {
      return err(toDatabaseError('List notification deliveries by logical notification', error));
    }
  }

  public async listShadowRecipients(input: Parameters<DeliveryRepo['listShadowRecipients']>[0]) {
    try {
      const rows = await this.db
        .selectFrom('notification_deliveries')
        .select(['user_id', 'content_hash', 'delivery_key'])
        .where('sender_mode', '=', 'shadow')
        .where('kind_id', '=', input.kindId)
        .$if(input.cursor !== null, (builder) =>
          builder.where('delivery_key', '>', input.cursor ?? '')
        )
        .orderBy('delivery_key', 'asc')
        .limit(input.limit + 1)
        .execute();
      const hasNext = rows.length > input.limit;
      if (hasNext) {
        rows.pop();
      }
      const items = rows.map((row) => ({
        userId: row.user_id,
        contentHash: row.content_hash,
        deliveryKey: row.delivery_key,
      }));
      return ok({
        items,
        nextCursor: hasNext ? (items.at(-1)?.deliveryKey ?? null) : null,
      });
    } catch (error) {
      return err(toDatabaseError('List shadow notification delivery recipients', error));
    }
  }

  public async saveProviderRefIfMissing(
    input: Parameters<DeliveryRepo['saveProviderRefIfMissing']>[0]
  ) {
    try {
      const result = await this.db
        .updateTable('notification_deliveries')
        .set({ provider_ref: input.providerRef, updated_at: input.now })
        .where('id', '=', input.deliveryId)
        .where('provider_ref', 'is', null)
        .executeTakeFirst();
      return ok(result.numUpdatedRows > 0n);
    } catch (error) {
      return err(toDatabaseError('Save notification delivery provider reference', error));
    }
  }

  public async claimForRender(input: Parameters<DeliveryRepo['claimForRender']>[0]) {
    try {
      const result = await sql<Record<string, unknown>>`
        UPDATE notification_deliveries
        SET claim_token = ${input.claimToken}::uuid,
            claim_expires_at = ${input.now}::timestamptz + (${input.leaseSeconds} * interval '1 second'),
            updated_at = ${input.now}
        WHERE id = ${input.deliveryId}::uuid
          AND status = 'pending_render'
          AND (claim_token IS NULL OR claim_expires_at < ${input.now})
        RETURNING *
      `.execute(this.db);
      const row = result.rows[0];
      return ok(row === undefined ? null : mapDelivery(row));
    } catch (error) {
      return err(toDatabaseError('Claim notification delivery for rendering', error));
    }
  }

  public async claimForSending(input: Parameters<DeliveryRepo['claimForSending']>[0]) {
    try {
      const result = await sql<Record<string, unknown>>`
        UPDATE notification_deliveries AS d
        SET status = 'sending',
            attempt_count = d.attempt_count + 1,
            claim_token = ${input.claimToken}::uuid,
            claim_expires_at = ${input.now}::timestamptz + (${input.leaseSeconds} * interval '1 second'),
            updated_at = ${input.now}
        WHERE d.id = ${input.deliveryId}::uuid
          AND (
            d.status IN ('ready', 'retry_wait')
            OR (d.status = 'sending' AND d.claim_expires_at < ${input.now})
          )
          AND d.sender_mode = 'active'
          AND (d.not_before IS NULL OR d.not_before <= ${input.now})
          AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ${input.now})
          AND (d.stream_key IS NULL OR NOT EXISTS (
            SELECT 1
            FROM notification_deliveries AS p
            WHERE p.user_id = d.user_id
              AND p.channel = d.channel
              AND p.stream_key = d.stream_key
              AND p.stream_sequence < d.stream_sequence
              AND p.status NOT IN (
                'accepted','delivered','bounced','complained','suppressed','cancelled',
                'expired','permanent_failed','dead_letter','unknown'
              )
          ))
        RETURNING d.*
      `.execute(this.db);
      const row = result.rows[0];
      return ok(row === undefined ? null : mapDelivery(row));
    } catch (error) {
      return err(toDatabaseError('Claim notification delivery for sending', error));
    }
  }

  public async saveRenderedContent(input: Parameters<DeliveryRepo['saveRenderedContent']>[0]) {
    try {
      const result = await this.db
        .updateTable('notification_deliveries')
        .set({
          rendered_subject: input.subject,
          rendered_html: input.html,
          rendered_text: input.text,
          content_hash: input.contentHash,
          template_id: input.templateId,
          template_version: input.templateVersion,
          status: input.nextStatus,
          claim_token: null,
          claim_expires_at: null,
          updated_at: new Date(),
        })
        .where('id', '=', input.deliveryId)
        .where('status', '=', 'pending_render')
        .where('claim_token', '=', input.expectedClaimToken)
        .executeTakeFirst();
      return ok(result.numUpdatedRows > 0n);
    } catch (error) {
      return err(toDatabaseError('Save rendered notification delivery content', error));
    }
  }

  public async transition(input: Parameters<DeliveryRepo['transition']>[0]) {
    if (input.from.length === 0) {
      return ok(false);
    }

    const invalidFrom = input.from.find((from) => !canTransition(from, input.to));
    if (invalidFrom !== undefined) {
      return err(createInvalidDeliveryTransitionError(invalidFrom, input.to));
    }

    try {
      const terminal = TERMINAL_DELIVERY_STATES.includes(input.to);
      const values = {
        status: input.to,
        updated_at: input.now,
        ...patchValues(input.patch),
        ...(input.to === 'accepted' ? { accepted_at: input.now } : {}),
        ...(terminal ? { terminal_at: input.now } : {}),
      };
      const result = await this.db
        .updateTable('notification_deliveries')
        .set(values)
        .where('id', '=', input.deliveryId)
        .where('status', 'in', [...input.from])
        .$if(input.expectedClaimToken !== undefined, (builder) =>
          builder.where('claim_token', '=', input.expectedClaimToken ?? '')
        )
        .executeTakeFirst();
      return ok(result.numUpdatedRows > 0n);
    } catch (error) {
      return err(toDatabaseError('Transition notification delivery state', error));
    }
  }

  public async cancelPendingForUser(input: Parameters<DeliveryRepo['cancelPendingForUser']>[0]) {
    try {
      const result = await this.db
        .updateTable('notification_deliveries')
        .set({
          status: 'cancelled',
          last_error_code: 'cancelled_by_policy',
          last_error_message: input.reason,
          terminal_at: input.now,
          claim_token: null,
          claim_expires_at: null,
          updated_at: input.now,
        })
        .where('user_id', '=', input.userId)
        .where('status', 'in', [...CANCELLABLE_DELIVERY_STATES])
        .$if(input.channels !== undefined, (builder) =>
          builder.where('channel', 'in', [...(input.channels ?? [])])
        )
        .$if(input.kindIds !== undefined, (builder) =>
          builder.where(sql<boolean>`kind_id = ANY(${[...(input.kindIds ?? [])]}::text[])`)
        )
        .executeTakeFirst();
      return ok(Number(result.numUpdatedRows));
    } catch (error) {
      return err(toDatabaseError('Cancel pending notification deliveries for user', error));
    }
  }

  public async findDueUnqueued(input: Parameters<DeliveryRepo['findDueUnqueued']>[0]) {
    try {
      const result = await sql<Record<string, unknown>>`
        SELECT *
        FROM notification_deliveries
        WHERE sender_mode = 'active'
          AND (
            (status = 'pending_render' AND created_at < ${input.olderThan})
            OR (
              status IN ('scheduled','ready','retry_wait')
              AND COALESCE(next_attempt_at, not_before, created_at) < ${input.olderThan}
            )
          )
        ORDER BY COALESCE(next_attempt_at, not_before, created_at), id
        LIMIT ${input.limit}
      `.execute(this.db);
      return ok(result.rows.map(mapDelivery));
    } catch (error) {
      return err(toDatabaseError('Find due unqueued notification deliveries', error));
    }
  }

  public async findExpiredClaims(input: Parameters<DeliveryRepo['findExpiredClaims']>[0]) {
    try {
      const rows = await this.db
        .selectFrom('notification_deliveries')
        .selectAll()
        .where('claim_token', 'is not', null)
        .where('claim_expires_at', '<', input.now)
        .where('status', 'in', ['pending_render', 'sending'])
        .orderBy('claim_expires_at', 'asc')
        .limit(input.limit)
        .execute();
      return ok(rows.map((row) => mapDelivery(row as unknown as Record<string, unknown>)));
    } catch (error) {
      return err(toDatabaseError('Find expired notification delivery claims', error));
    }
  }

  public async findDueForExpiry(input: Parameters<DeliveryRepo['findDueForExpiry']>[0]) {
    try {
      const rows = await this.db
        .selectFrom('notification_deliveries')
        .selectAll()
        .where('expires_at', 'is not', null)
        .where('expires_at', '<=', input.now)
        .where('status', 'in', ['pending_render', 'scheduled', 'ready', 'retry_wait'])
        .orderBy('expires_at', 'asc')
        .limit(input.limit)
        .execute();
      return ok(rows.map((row) => mapDelivery(row as unknown as Record<string, unknown>)));
    } catch (error) {
      return err(toDatabaseError('Find notification deliveries due for expiry', error));
    }
  }

  public async searchDeadLetters(input: Parameters<DeliveryRepo['searchDeadLetters']>[0]) {
    const cursor = input.cursor === null ? null : decodeTimestampCursor(input.cursor);
    if (input.cursor !== null && cursor === null) {
      return err(createValidationError('Invalid dead-letter cursor', 'cursor'));
    }

    try {
      const rows = await this.db
        .selectFrom('notification_deliveries as d')
        .leftJoin('logical_notifications as l', 'l.id', 'd.logical_notification_id')
        .selectAll('d')
        .where('d.status', 'in', [...DEAD_LETTER_STATES])
        .$if(input.kindId !== undefined, (builder) =>
          builder.where('d.kind_id', '=', input.kindId ?? '')
        )
        .$if(input.channel !== undefined, (builder) =>
          builder.where('d.channel', '=', input.channel ?? 'email')
        )
        .$if(input.status !== undefined, (builder) =>
          builder.where('d.status', '=', input.status ?? 'dead_letter')
        )
        .$if(input.eventId !== undefined, (builder) =>
          builder.where('l.event_id', '=', input.eventId ?? '')
        )
        .$if(input.userId !== undefined, (builder) =>
          builder.where('d.user_id', '=', input.userId ?? '')
        )
        .$if(cursor !== null, (builder) =>
          builder.where(
            sql<boolean>`(COALESCE(d.terminal_at, d.updated_at), d.id) < (${cursor?.date ?? new Date(0)}, ${cursor?.id ?? ''}::uuid)`
          )
        )
        .orderBy(sql`COALESCE(d.terminal_at, d.updated_at)`, 'desc')
        .orderBy('d.id', 'desc')
        .limit(input.limit + 1)
        .execute();

      const hasNext = rows.length > input.limit;
      if (hasNext) {
        rows.pop();
      }
      const items = rows.map((row) => mapDelivery(row as unknown as Record<string, unknown>));
      const last = items.at(-1);
      return ok({
        items,
        nextCursor:
          hasNext && last !== undefined
            ? encodeTimestampCursor(last.terminalAt ?? last.updatedAt, last.id)
            : null,
      });
    } catch (error) {
      return err(toDatabaseError('Search notification delivery dead letters', error));
    }
  }
}

export const makeDeliveryRepo = (db: UserDbClient): DeliveryRepo => new KyselyDeliveryRepo(db);
