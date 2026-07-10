import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import {
  decodeTimestampCursor,
  encodeTimestampCursor,
  isUniqueViolation,
  mapChannelDestination,
  toDatabaseError,
} from './repo-helpers.js';
import { createValidationError } from '../../core/shared/errors.js';

import type { ChannelDestinationRepo } from '../../core/delivery/ports.js';
import type { ChannelDestination } from '../../core/delivery/types.js';
import type { UserDbClient } from '@/infra/database/client.js';

export class KyselyChannelDestinationRepo implements ChannelDestinationRepo {
  public constructor(private readonly db: UserDbClient) {}

  public async getCurrent(input: Parameters<ChannelDestinationRepo['getCurrent']>[0]) {
    try {
      const row = await this.db
        .selectFrom('notification_channel_destinations')
        .selectAll()
        .where('user_id', '=', input.userId)
        .where('channel', '=', input.channel)
        .where('is_current', '=', true)
        .executeTakeFirst();
      return ok(
        row === undefined ? null : mapChannelDestination(row as unknown as Record<string, unknown>)
      );
    } catch (error) {
      return err(toDatabaseError('Get current notification channel destination', error));
    }
  }

  private async writeCurrent(
    input: Parameters<ChannelDestinationRepo['ensureCurrent']>[0]
  ): Promise<ChannelDestination> {
    return this.db.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom('notification_channel_destinations')
        .selectAll()
        .where('user_id', '=', input.userId)
        .where('channel', '=', input.channel)
        .where('is_current', '=', true)
        .forUpdate()
        .executeTakeFirst();

      if (current?.fingerprint === input.fingerprint) {
        return mapChannelDestination(current);
      }

      const maximum = await transaction
        .selectFrom('notification_channel_destinations')
        .select(sql<number | null>`max(generation)`.as('generation'))
        .where('user_id', '=', input.userId)
        .where('channel', '=', input.channel)
        .executeTakeFirst();
      const generation = (maximum?.generation ?? 0) + 1;

      if (current !== undefined) {
        await transaction
          .updateTable('notification_channel_destinations')
          .set({ is_current: false, updated_at: input.now })
          .where('id', '=', current.id)
          .where('is_current', '=', true)
          .execute();
      }

      const inserted = await transaction
        .insertInto('notification_channel_destinations')
        .values({
          id: sql<string>`gen_random_uuid()`,
          user_id: input.userId,
          channel: input.channel,
          fingerprint: input.fingerprint,
          generation,
          is_current: true,
          suppressed_at: null,
          suppression_reason: null,
          created_at: input.now,
          updated_at: input.now,
        })
        .onConflict((conflict) =>
          conflict.columns(['user_id', 'channel', 'fingerprint']).doUpdateSet({
            is_current: true,
            generation,
            updated_at: input.now,
          })
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return mapChannelDestination(inserted);
    });
  }

  public async ensureCurrent(input: Parameters<ChannelDestinationRepo['ensureCurrent']>[0]) {
    try {
      return ok(await this.writeCurrent(input));
    } catch (error) {
      if (isUniqueViolation(error)) {
        try {
          const current = await this.db
            .selectFrom('notification_channel_destinations')
            .selectAll()
            .where('user_id', '=', input.userId)
            .where('channel', '=', input.channel)
            .where('is_current', '=', true)
            .executeTakeFirst();
          if (current?.fingerprint === input.fingerprint) {
            return ok(mapChannelDestination(current as unknown as Record<string, unknown>));
          }
          return ok(await this.writeCurrent(input));
        } catch (retryError) {
          return err(toDatabaseError('Retry current notification channel destination', retryError));
        }
      }
      return err(toDatabaseError('Ensure current notification channel destination', error));
    }
  }

  public async suppressByFingerprint(
    input: Parameters<ChannelDestinationRepo['suppressByFingerprint']>[0]
  ) {
    try {
      const result = await this.db
        .updateTable('notification_channel_destinations')
        .set({
          suppressed_at: input.now,
          suppression_reason: input.reason,
          updated_at: input.now,
        })
        .where('fingerprint', '=', input.fingerprint)
        .where('channel', '=', input.channel)
        .executeTakeFirst();
      return ok(Number(result.numUpdatedRows));
    } catch (error) {
      return err(toDatabaseError('Suppress notification channel destination', error));
    }
  }

  public async listSuppressed(input: Parameters<ChannelDestinationRepo['listSuppressed']>[0]) {
    const cursor = input.cursor === null ? null : decodeTimestampCursor(input.cursor);
    if (input.cursor !== null && cursor === null) {
      return err(createValidationError('Invalid destination suppression cursor', 'cursor'));
    }

    try {
      const rows = await this.db
        .selectFrom('notification_channel_destinations')
        .selectAll()
        .where('suppressed_at', 'is not', null)
        .$if(input.userId !== undefined, (builder) =>
          builder.where('user_id', '=', input.userId ?? '')
        )
        .$if(cursor !== null, (builder) =>
          builder.where(
            sql<boolean>`(suppressed_at, id) < (${cursor?.date ?? new Date(0)}, ${cursor?.id ?? ''}::uuid)`
          )
        )
        .orderBy('suppressed_at', 'desc')
        .orderBy('id', 'desc')
        .limit(input.limit + 1)
        .execute();

      const hasNext = rows.length > input.limit;
      if (hasNext) {
        rows.pop();
      }
      const items = rows.map((row) =>
        mapChannelDestination(row as unknown as Record<string, unknown>)
      );
      const last = items.at(-1);
      const nextCursor =
        hasNext && last !== undefined && last.suppressedAt !== null
          ? encodeTimestampCursor(last.suppressedAt, last.id)
          : null;
      return ok({
        items,
        nextCursor,
      });
    } catch (error) {
      return err(toDatabaseError('List suppressed notification channel destinations', error));
    }
  }
}

export const makeChannelDestinationRepo = (db: UserDbClient): ChannelDestinationRepo =>
  new KyselyChannelDestinationRepo(db);
