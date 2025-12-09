/**
 * Unsubscribe Tokens Repository Implementation
 *
 * Kysely-based implementation for the unsubscribe tokens table.
 */

import { ok, err, type Result } from 'neverthrow';

import { createDatabaseError, type NotificationError } from '../../core/errors.js';

import type { UnsubscribeTokensRepository } from '../../core/ports.js';
import type { UnsubscribeToken } from '../../core/types.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Row type from database query.
 */
interface QueryRow {
  token: string;
  user_id: string;
  notification_id: string;
  created_at: unknown;
  expires_at: unknown;
  used_at: unknown;
}

/**
 * Options for creating the tokens repository.
 */
export interface TokensRepoOptions {
  db: UserDbClient;
  logger: Logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kysely-based Unsubscribe Tokens Repository.
 */
class KyselyTokensRepo implements UnsubscribeTokensRepository {
  private readonly db: UserDbClient;
  private readonly log: Logger;

  constructor(options: TokensRepoOptions) {
    this.db = options.db;
    this.log = options.logger.child({ repo: 'TokensRepo' });
  }

  async findByToken(token: string): Promise<Result<UnsubscribeToken | null, NotificationError>> {
    this.log.debug({ token: token.substring(0, 8) + '...' }, 'Finding token');

    try {
      const row = await this.db
        .selectFrom('unsubscribetokens')
        .select(['token', 'user_id', 'notification_id', 'created_at', 'expires_at', 'used_at'])
        .where('token', '=', token)
        .executeTakeFirst();

      if (row === undefined) {
        this.log.debug({ token: token.substring(0, 8) + '...' }, 'Token not found');
        return ok(null);
      }

      return ok(this.mapRowToToken(row as unknown as QueryRow));
    } catch (error) {
      this.log.error({ err: error }, 'Failed to find token');
      return err(createDatabaseError('Failed to find token', error));
    }
  }

  async isTokenValid(token: string): Promise<Result<boolean, NotificationError>> {
    this.log.debug({ token: token.substring(0, 8) + '...' }, 'Checking token validity');

    try {
      const row = await this.db
        .selectFrom('unsubscribetokens')
        .select(['expires_at', 'used_at'])
        .where('token', '=', token)
        .executeTakeFirst();

      if (row === undefined) {
        this.log.debug(
          { token: token.substring(0, 8) + '...' },
          'Token not found for validity check'
        );
        return ok(false);
      }

      const expiresAt = this.toDate(row.expires_at);
      const usedAt = row.used_at !== null ? this.toDate(row.used_at) : null;

      // Token is valid if not expired and not used
      const now = new Date();
      const isValid = expiresAt > now && usedAt === null;

      this.log.debug(
        {
          token: token.substring(0, 8) + '...',
          isValid,
          expired: expiresAt <= now,
          used: usedAt !== null,
        },
        'Token validity result'
      );
      return ok(isValid);
    } catch (error) {
      this.log.error({ err: error }, 'Failed to check token validity');
      return err(createDatabaseError('Failed to check token validity', error));
    }
  }

  async markAsUsed(token: string): Promise<Result<UnsubscribeToken, NotificationError>> {
    this.log.debug({ token: token.substring(0, 8) + '...' }, 'Marking token as used');

    try {
      const row = await this.db
        .updateTable('unsubscribetokens')
        .set({ used_at: new Date() })
        .where('token', '=', token)
        .returning(['token', 'user_id', 'notification_id', 'created_at', 'expires_at', 'used_at'])
        .executeTakeFirstOrThrow();

      this.log.debug({ token: token.substring(0, 8) + '...' }, 'Token marked as used');
      return ok(this.mapRowToToken(row as unknown as QueryRow));
    } catch (error) {
      this.log.error({ err: error }, 'Failed to mark token as used');
      return err(createDatabaseError('Failed to mark token as used', error));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Maps a database row to UnsubscribeToken domain type.
   */
  private mapRowToToken(row: QueryRow): UnsubscribeToken {
    return {
      token: row.token,
      userId: row.user_id,
      notificationId: row.notification_id,
      createdAt: this.toDate(row.created_at),
      expiresAt: this.toDate(row.expires_at),
      usedAt: row.used_at !== null ? this.toDate(row.used_at) : null,
    };
  }

  /**
   * Converts Kysely timestamp to Date.
   */
  private toDate(value: unknown): Date {
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === 'string') {
      return new Date(value);
    }
    if (typeof value === 'object' && value !== null && 'toISOString' in value) {
      return new Date((value as { toISOString: () => string }).toISOString());
    }
    return new Date();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an UnsubscribeTokensRepository instance.
 */
export const makeTokensRepo = (options: TokensRepoOptions): UnsubscribeTokensRepository => {
  return new KyselyTokensRepo(options);
};
