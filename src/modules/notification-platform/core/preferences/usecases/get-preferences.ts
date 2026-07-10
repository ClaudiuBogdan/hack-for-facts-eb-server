import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { PreferenceError } from '../errors.js';
import type { PreferenceRepo } from '../ports.js';
import type { UserNotificationPreferences } from '../types.js';
import type { Result } from 'neverthrow';

export interface GetPreferencesDeps {
  preferences: PreferenceRepo;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface GetPreferencesInput {
  userId: string;
}

export type GetPreferencesResult = UserNotificationPreferences;
export type GetPreferencesError = PreferenceError;

export const getPreferences = async (
  deps: GetPreferencesDeps,
  input: GetPreferencesInput
): Promise<Result<GetPreferencesResult, GetPreferencesError>> => {
  return deps.preferences.getForUser(input.userId);
};
