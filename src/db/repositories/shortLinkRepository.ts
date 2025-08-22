import type { PoolClient } from "pg";
import { runQuery, withTransaction } from "../dataAccess";

export interface ShortLink {
  id: number;
  code: string;
  user_ids: string[];
  original_url: string;
  created_at: Date;
  access_count: number;
  last_access_at?: Date | null;
  metadata?: Record<string, unknown> | null;
}

export interface CreateShortLinkInput {
  code: string;
  userId: string;
  originalUrl: string;
  metadata?: Record<string, unknown> | null;
}

export class ShortLinkCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShortLinkCollisionError";
  }
}

export const shortLinkRepository = {
  async createOrUpdate(input: CreateShortLinkInput): Promise<ShortLink> {
    return withTransaction("userdata", async (client) => {
      // 1. Check if a link for this URL already exists.
      const existingByUrl = await this.getByOriginalUrl(input.originalUrl, client);

      if (existingByUrl) {
        // If it exists, ensure the current user is associated with it.
        if (!existingByUrl.user_ids.includes(input.userId)) {
          const result = await runQuery<ShortLink>(
            "userdata",
            `UPDATE ShortLinks SET user_ids = array_append(user_ids, $1) WHERE id = $2 RETURNING *`,
            [input.userId, existingByUrl.id],
            client
          );
          return result.rows[0];
        }
        return existingByUrl;
      }

      // 2. If no link exists for the URL, check for a code collision.
      const existingByCode = await this.getByCode(input.code, client);
      if (existingByCode) {
        // This is a hash collision. Two different URLs produced the same code.
        throw new ShortLinkCollisionError(
          `Hash collision detected for code ${input.code} on a different URL.`
        );
      }

      // 3. If no conflicts, insert the new short link.
      const result = await runQuery<ShortLink>(
        "userdata",
        `INSERT INTO ShortLinks (code, user_ids, original_url, metadata)
         VALUES ($1, ARRAY[$2], $3, $4)
         RETURNING *`,
        [input.code, input.userId, input.originalUrl, input.metadata ?? {}],
        client
      );
      return result.rows[0];
    });
  },

  async getByCode(code: string, client?: PoolClient): Promise<ShortLink | null> {
    const result = await runQuery<ShortLink>(
      "userdata",
      `SELECT id, code, user_ids, original_url, created_at, access_count, last_access_at, metadata
       FROM ShortLinks WHERE code = $1`,
      [code],
      client
    );
    return result.rows[0] || null;
  },

  async getByOriginalUrl(originalUrl: string, client?: PoolClient): Promise<ShortLink | null> {
    const result = await runQuery<ShortLink>(
      "userdata",
      `SELECT id, code, user_ids, original_url, created_at, access_count, last_access_at, metadata
       FROM ShortLinks WHERE original_url = $1`,
      [originalUrl],
      client
    );
    return result.rows[0] || null;
  },

  async countRecentLinksForUser(userId: string, since: Date): Promise<number> {
    const result = await runQuery<{ count: string }>(
      "userdata",
      `SELECT count(*) FROM ShortLinks WHERE $1 = ANY(user_ids) AND created_at >= $2`,
      [userId, since]
    );
    return parseInt(result.rows[0].count, 10);
  },

  async incrementAccessStats(code: string): Promise<void> {
    await runQuery(
      "userdata",
      `UPDATE ShortLinks
       SET access_count = access_count + 1,
           last_access_at = NOW()
       WHERE code = $1`,
      [code]
    );
  },
};


