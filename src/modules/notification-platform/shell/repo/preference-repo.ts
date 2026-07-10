import { err, ok } from 'neverthrow';

import { toDatabaseError } from './repo-helpers.js';

import type { PreferenceRepo } from '../../core/preferences/ports.js';
import type { ChannelPreference } from '../../core/preferences/types.js';
import type { Channel } from '../../core/shared/types.js';
import type { UserDbClient } from '@/infra/database/client.js';

const DEFAULT_CHANNEL_PREFERENCES: Record<Channel, ChannelPreference> = {
  inbox: { enabled: true, cadence: 'immediate' },
  email: { enabled: true, cadence: 'immediate' },
};

export class KyselyPreferenceRepo implements PreferenceRepo {
  public constructor(private readonly db: UserDbClient) {}

  public async getForUser(userId: string) {
    try {
      const [global, storedChannels] = await Promise.all([
        this.db
          .selectFrom('notification_global_preferences')
          .select('optional_enabled')
          .where('user_id', '=', userId)
          .executeTakeFirst(),
        this.db
          .selectFrom('notification_channel_preferences')
          .select(['channel', 'enabled', 'cadence'])
          .where('user_id', '=', userId)
          .execute(),
      ]);

      const channels: Record<Channel, ChannelPreference> = {
        inbox: { ...DEFAULT_CHANNEL_PREFERENCES.inbox },
        email: { ...DEFAULT_CHANNEL_PREFERENCES.email },
      };
      for (const row of storedChannels) {
        channels[row.channel] = { enabled: row.enabled, cadence: row.cadence };
      }

      return ok({
        userId,
        globalOptionalEnabled: global?.optional_enabled ?? true,
        channels,
      });
    } catch (error) {
      return err(toDatabaseError('Get notification preferences for user', error));
    }
  }

  public async upsertGlobal(input: Parameters<PreferenceRepo['upsertGlobal']>[0]) {
    try {
      await this.db
        .insertInto('notification_global_preferences')
        .values({
          user_id: input.userId,
          optional_enabled: input.enabled,
          updated_at: input.now,
        })
        .onConflict((conflict) =>
          conflict.column('user_id').doUpdateSet({
            optional_enabled: input.enabled,
            updated_at: input.now,
          })
        )
        .execute();
      return ok(undefined);
    } catch (error) {
      return err(toDatabaseError('Upsert global notification preference', error));
    }
  }

  public async upsertChannel(input: Parameters<PreferenceRepo['upsertChannel']>[0]) {
    try {
      await this.db
        .insertInto('notification_channel_preferences')
        .values({
          user_id: input.userId,
          channel: input.channel,
          enabled: input.enabled,
          cadence: input.cadence,
          updated_at: input.now,
        })
        .onConflict((conflict) =>
          conflict.columns(['user_id', 'channel']).doUpdateSet({
            enabled: input.enabled,
            cadence: input.cadence,
            updated_at: input.now,
          })
        )
        .execute();
      return ok(undefined);
    } catch (error) {
      return err(toDatabaseError('Upsert channel notification preference', error));
    }
  }
}

export const makePreferenceRepo = (db: UserDbClient): PreferenceRepo =>
  new KyselyPreferenceRepo(db);
