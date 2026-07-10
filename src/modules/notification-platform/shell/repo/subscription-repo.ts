import { err, ok } from 'neverthrow';

import { mapSubscription, toDatabaseError } from './repo-helpers.js';

import type { SubscriptionRepo } from '../../core/subscriptions/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';

export class KyselySubscriptionRepo implements SubscriptionRepo {
  public constructor(private readonly db: UserDbClient) {}

  public async createOrReactivate(input: Parameters<SubscriptionRepo['createOrReactivate']>[0]) {
    try {
      const row = await this.db
        .insertInto('notification_subscriptions')
        .values({
          id: input.id,
          user_id: input.userId,
          kind_id: input.kindId,
          subject_type: input.subjectType,
          subject_id: input.subjectId,
          config: input.config,
          normalized_key: input.normalizedKey,
          state: 'active',
          created_at: input.now,
          updated_at: input.now,
          removed_at: null,
        })
        .onConflict((conflict) =>
          conflict.columns(['user_id', 'kind_id', 'normalized_key']).doUpdateSet({
            state: 'active',
            config: input.config,
            updated_at: input.now,
            removed_at: null,
          })
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return ok(mapSubscription(row as unknown as Record<string, unknown>));
    } catch (error) {
      return err(toDatabaseError('Create or reactivate notification subscription', error));
    }
  }

  public async findByIdForUser(id: string, userId: string) {
    try {
      const row = await this.db
        .selectFrom('notification_subscriptions')
        .selectAll()
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return ok(
        row === undefined ? null : mapSubscription(row as unknown as Record<string, unknown>)
      );
    } catch (error) {
      return err(toDatabaseError('Find notification subscription for user', error));
    }
  }

  public async listByUser(input: Parameters<SubscriptionRepo['listByUser']>[0]) {
    try {
      const query = this.db
        .selectFrom('notification_subscriptions')
        .selectAll()
        .where('user_id', '=', input.userId)
        .$if(input.kindId !== undefined, (builder) =>
          builder.where('kind_id', '=', input.kindId ?? '')
        )
        .$if(input.cursor !== undefined, (builder) => builder.where('id', '>', input.cursor ?? ''))
        .orderBy('id', 'asc')
        .limit(input.limit + 1);

      const rows = await query.execute();
      const hasNext = rows.length > input.limit;
      if (hasNext) {
        rows.pop();
      }
      const items = rows.map((row) => mapSubscription(row as unknown as Record<string, unknown>));
      return ok({
        items,
        nextCursor: hasNext ? (items.at(-1)?.id ?? null) : null,
      });
    } catch (error) {
      return err(toDatabaseError('List notification subscriptions for user', error));
    }
  }

  public async listActiveByKindAndSubject(
    input: Parameters<SubscriptionRepo['listActiveByKindAndSubject']>[0]
  ) {
    try {
      const rows = await this.db
        .selectFrom('notification_subscriptions')
        .selectAll()
        .where('kind_id', '=', input.kindId)
        .where('subject_type', '=', input.subjectType)
        .where('subject_id', '=', input.subjectId)
        .where('state', '=', 'active')
        .$if(input.afterId !== null, (builder) => builder.where('id', '>', input.afterId ?? ''))
        .orderBy('id', 'asc')
        .limit(input.limit)
        .execute();
      return ok(rows.map((row) => mapSubscription(row as unknown as Record<string, unknown>)));
    } catch (error) {
      return err(toDatabaseError('List active notification subscriptions for fan-out', error));
    }
  }

  public async setState(input: Parameters<SubscriptionRepo['setState']>[0]) {
    try {
      const result = await this.db
        .updateTable('notification_subscriptions')
        .set({
          state: input.state,
          updated_at: input.now,
          removed_at: input.state === 'removed' ? input.now : null,
        })
        .where('id', '=', input.id)
        .where('user_id', '=', input.userId)
        .executeTakeFirst();
      return ok(result.numUpdatedRows > 0n);
    } catch (error) {
      return err(toDatabaseError('Set notification subscription state', error));
    }
  }
}

export const makeSubscriptionRepo = (db: UserDbClient): SubscriptionRepo =>
  new KyselySubscriptionRepo(db);
