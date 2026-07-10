import type { PreferenceError } from './errors.js';
import type { UserNotificationPreferences } from './types.js';
import type { Cadence, Channel } from '../shared/types.js';
import type { Result } from 'neverthrow';

export interface PreferenceRepo {
  getForUser(userId: string): Promise<Result<UserNotificationPreferences, PreferenceError>>;
  upsertGlobal(input: {
    userId: string;
    enabled: boolean;
    now: Date;
  }): Promise<Result<void, PreferenceError>>;
  upsertChannel(input: {
    userId: string;
    channel: Channel;
    enabled: boolean;
    cadence: Cadence;
    now: Date;
  }): Promise<Result<void, PreferenceError>>;
}
