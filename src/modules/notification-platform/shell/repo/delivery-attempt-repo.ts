import { err, ok } from 'neverthrow';

import { mapDeliveryAttempt, toDatabaseError } from './repo-helpers.js';

import type { DeliveryAttemptRepo } from '../../core/delivery/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';

export class KyselyDeliveryAttemptRepo implements DeliveryAttemptRepo {
  public constructor(private readonly db: UserDbClient) {}

  public async create(input: Parameters<DeliveryAttemptRepo['create']>[0]) {
    try {
      const row = await this.db
        .insertInto('notification_delivery_attempts')
        .values({
          id: input.id,
          delivery_id: input.deliveryId,
          attempt_number: input.attemptNumber,
          started_at: input.startedAt,
          completed_at: null,
          provider_idempotency_key: input.providerIdempotencyKey,
          request_correlation_id: input.requestCorrelationId,
          destination_fingerprint: input.destinationFingerprint,
          result: null,
          error_code: null,
          error_message: null,
          provider_ref: null,
          latency_ms: null,
          retry_after_ms: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return ok(mapDeliveryAttempt(row as unknown as Record<string, unknown>));
    } catch (error) {
      return err(toDatabaseError('Create notification delivery attempt', error));
    }
  }

  public async complete(input: Parameters<DeliveryAttemptRepo['complete']>[0]) {
    try {
      await this.db
        .updateTable('notification_delivery_attempts')
        .set({
          completed_at: input.completedAt,
          result: input.result,
          error_code: input.errorCode ?? null,
          error_message: input.errorMessage ?? null,
          provider_ref: input.providerRef ?? null,
          latency_ms: input.latencyMs ?? null,
          retry_after_ms: input.retryAfterMs ?? null,
        })
        .where('id', '=', input.attemptId)
        .execute();
      return ok(undefined);
    } catch (error) {
      return err(toDatabaseError('Complete notification delivery attempt', error));
    }
  }

  public async listByDelivery(deliveryId: string) {
    try {
      const rows = await this.db
        .selectFrom('notification_delivery_attempts')
        .selectAll()
        .where('delivery_id', '=', deliveryId)
        .orderBy('attempt_number', 'asc')
        .execute();
      return ok(rows.map((row) => mapDeliveryAttempt(row as unknown as Record<string, unknown>)));
    } catch (error) {
      return err(toDatabaseError('List attempts for notification delivery', error));
    }
  }
}

export const makeDeliveryAttemptRepo = (db: UserDbClient): DeliveryAttemptRepo =>
  new KyselyDeliveryAttemptRepo(db);
