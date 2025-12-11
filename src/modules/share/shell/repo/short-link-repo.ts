/**
 * Short Link Repository Implementation
 *
 * Kysely-based implementation for the short_links table in UserDatabase.
 */

import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import {
  createDatabaseError,
  createHashCollisionError,
  type ShareError,
} from '../../core/errors.js';

import type { ShortLinkRepository } from '../../core/ports.js';
import type { CreateShortLinkInput, ShortLink, UrlMetadata } from '../../core/types.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Row type from database query.
 */
interface QueryRow {
  id: string;
  code: string;
  user_ids: string[];
  original_url: string;
  created_at: unknown;
  access_count: number;
  last_access_at: unknown;
  metadata: Record<string, unknown> | null;
}

/**
 * Options for creating the short link repository.
 */
export interface ShortLinkRepoOptions {
  db: UserDbClient;
  logger: Logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kysely-based Short Link Repository.
 */
class KyselyShortLinkRepo implements ShortLinkRepository {
  private readonly db: UserDbClient;
  private readonly log: Logger;

  constructor(options: ShortLinkRepoOptions) {
    this.db = options.db;
    this.log = options.logger.child({ repo: 'ShortLinkRepo' });
  }

  async getByCode(code: string): Promise<Result<ShortLink | null, ShareError>> {
    this.log.debug({ code }, 'Finding short link by code');

    try {
      const row = await this.db
        .selectFrom('shortlinks')
        .select([
          'id',
          'code',
          'user_ids',
          'original_url',
          'created_at',
          'access_count',
          'last_access_at',
          'metadata',
        ])
        .where('code', '=', code)
        .executeTakeFirst();

      if (row === undefined) {
        this.log.debug({ code }, 'Short link not found');
        return ok(null);
      }

      return ok(this.mapRowToShortLink(row as unknown as QueryRow));
    } catch (error) {
      this.log.error({ err: error, code }, 'Failed to find short link by code');
      return err(createDatabaseError('Failed to find short link by code', error));
    }
  }

  async getByOriginalUrl(url: string): Promise<Result<ShortLink | null, ShareError>> {
    this.log.debug({ url }, 'Finding short link by original URL');

    try {
      const row = await this.db
        .selectFrom('shortlinks')
        .select([
          'id',
          'code',
          'user_ids',
          'original_url',
          'created_at',
          'access_count',
          'last_access_at',
          'metadata',
        ])
        .where('original_url', '=', url)
        .executeTakeFirst();

      if (row === undefined) {
        this.log.debug({ url }, 'Short link not found for URL');
        return ok(null);
      }

      return ok(this.mapRowToShortLink(row as unknown as QueryRow));
    } catch (error) {
      this.log.error({ err: error, url }, 'Failed to find short link by original URL');
      return err(createDatabaseError('Failed to find short link by original URL', error));
    }
  }

  async createOrAssociateUser(input: CreateShortLinkInput): Promise<Result<ShortLink, ShareError>> {
    const { code, userId, originalUrl, metadata } = input;

    this.log.debug({ code, userId }, 'Creating or associating short link');

    try {
      // Check if a link for this URL already exists
      const existingByUrl = await this.getByOriginalUrl(originalUrl);
      if (existingByUrl.isErr()) {
        return err(existingByUrl.error);
      }

      if (existingByUrl.value !== null) {
        const existing = existingByUrl.value;

        // If user not already associated, add them
        if (!existing.userIds.includes(userId)) {
          const updatedRow = await this.db
            .updateTable('shortlinks')
            .set({
              user_ids: sql`array_append(user_ids, ${userId})`,
            } as never)
            .where('id', '=', existing.id)
            .returning([
              'id',
              'code',
              'user_ids',
              'original_url',
              'created_at',
              'access_count',
              'last_access_at',
              'metadata',
            ])
            .executeTakeFirstOrThrow();

          this.log.debug({ code: existing.code, userId }, 'User associated with existing link');
          return ok(this.mapRowToShortLink(updatedRow as unknown as QueryRow));
        }

        // User already associated
        this.log.debug({ code: existing.code, userId }, 'User already associated with link');
        return ok(existing);
      }

      // Check for code collision (same code, different URL)
      const existingByCode = await this.getByCode(code);
      if (existingByCode.isErr()) {
        return err(existingByCode.error);
      }

      if (existingByCode.value !== null) {
        // Code exists but different URL - hash collision
        this.log.warn({ code }, 'Hash collision detected');
        return err(createHashCollisionError(code));
      }

      // No conflicts - insert new short link
      const now = new Date();
      const insertValues = {
        code,
        user_ids: [userId],
        original_url: originalUrl,
        created_at: now,
        access_count: 0,
        last_access_at: null,
        metadata: sql`${JSON.stringify(metadata)}::jsonb`,
      };

      const row = await this.db
        .insertInto('shortlinks')
        .values(insertValues as never)
        .returning([
          'id',
          'code',
          'user_ids',
          'original_url',
          'created_at',
          'access_count',
          'last_access_at',
          'metadata',
        ])
        .executeTakeFirstOrThrow();

      this.log.debug({ code }, 'Short link created successfully');
      return ok(this.mapRowToShortLink(row as unknown as QueryRow));
    } catch (error) {
      this.log.error({ err: error, code, userId }, 'Failed to create or associate short link');
      return err(createDatabaseError('Failed to create or associate short link', error));
    }
  }

  async countRecentForUser(userId: string, since: Date): Promise<Result<number, ShareError>> {
    this.log.debug({ userId, since }, 'Counting recent links for user');

    try {
      const result = await this.db
        .selectFrom('shortlinks')
        .select(sql<string>`count(*)`.as('count'))
        .where(sql<boolean>`${userId} = ANY(user_ids)`)
        .where(sql<boolean>`created_at >= ${since.toISOString()}::timestamptz`)
        .executeTakeFirst();

      const count = result !== undefined ? Number.parseInt(result.count, 10) : 0;
      this.log.debug({ userId, count }, 'Counted recent links');
      return ok(count);
    } catch (error) {
      this.log.error({ err: error, userId }, 'Failed to count recent links');
      return err(createDatabaseError('Failed to count recent links', error));
    }
  }

  async incrementAccessStats(code: string): Promise<Result<void, ShareError>> {
    this.log.debug({ code }, 'Incrementing access stats');

    try {
      await this.db
        .updateTable('shortlinks')
        .set({
          access_count: sql`access_count + 1`,
          last_access_at: sql`NOW()`,
        } as never)
        .where('code', '=', code)
        .execute();

      this.log.debug({ code }, 'Access stats incremented');
      return ok(undefined);
    } catch (error) {
      this.log.error({ err: error, code }, 'Failed to increment access stats');
      return err(createDatabaseError('Failed to increment access stats', error));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private mapRowToShortLink(row: QueryRow): ShortLink {
    return {
      id: row.id,
      code: row.code,
      userIds: row.user_ids,
      originalUrl: row.original_url,
      createdAt: new Date(row.created_at as string | number | Date),
      accessCount: row.access_count,
      lastAccessAt:
        row.last_access_at !== null ? new Date(row.last_access_at as string | number | Date) : null,
      metadata: row.metadata as UrlMetadata | null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a new ShortLinkRepository instance.
 */
export const makeShortLinkRepo = (options: ShortLinkRepoOptions): ShortLinkRepository => {
  return new KyselyShortLinkRepo(options);
};
