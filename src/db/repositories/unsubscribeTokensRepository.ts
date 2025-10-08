import type { PoolClient } from 'pg';
import { runQuery } from '../dataAccess';
import type { UnsubscribeToken } from '../../services/notifications/types';
import crypto from 'crypto';

export interface CreateTokenInput {
  userId: string;
  notificationId: number;
}

interface TokenRow {
  token: string;
  user_id: string;
  notification_id: number;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
}

function mapRowToToken(row: TokenRow): UnsubscribeToken {
  return {
    token: row.token,
    userId: row.user_id,
    notificationId: row.notification_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

export const unsubscribeTokensRepository = {
  async create(input: CreateTokenInput, client?: PoolClient): Promise<UnsubscribeToken> {
    const token = crypto.randomBytes(32).toString('hex');

    const result = await runQuery<TokenRow>(
      'userdata',
      `INSERT INTO UnsubscribeTokens (token, user_id, notification_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [token, input.userId, input.notificationId],
      client
    );

    return mapRowToToken(result.rows[0]);
  },

  async findByToken(token: string, client?: PoolClient): Promise<UnsubscribeToken | null> {
    const result = await runQuery<TokenRow>(
      'userdata',
      `SELECT * FROM UnsubscribeTokens WHERE token = $1`,
      [token],
      client
    );

    return result.rows[0] ? mapRowToToken(result.rows[0]) : null;
  },

  async findByUserId(userId: string, activeOnly = true): Promise<UnsubscribeToken[]> {
    const query = activeOnly
      ? `SELECT * FROM UnsubscribeTokens WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC`
      : `SELECT * FROM UnsubscribeTokens WHERE user_id = $1 ORDER BY created_at DESC`;

    const result = await runQuery<TokenRow>('userdata', query, [userId]);

    return result.rows.map(mapRowToToken);
  },

  async findByNotificationId(notificationId: number): Promise<UnsubscribeToken[]> {
    const result = await runQuery<TokenRow>(
      'userdata',
      `SELECT * FROM UnsubscribeTokens WHERE notification_id = $1 ORDER BY created_at DESC`,
      [notificationId]
    );

    return result.rows.map(mapRowToToken);
  },

  async markAsUsed(token: string, client?: PoolClient): Promise<UnsubscribeToken> {
    const result = await runQuery<TokenRow>(
      'userdata',
      `UPDATE UnsubscribeTokens SET used_at = NOW() WHERE token = $1 RETURNING *`,
      [token],
      client
    );

    return mapRowToToken(result.rows[0]);
  },

  async deleteExpired(): Promise<number> {
    const result = await runQuery<{ count: number }>(
      'userdata',
      `DELETE FROM UnsubscribeTokens WHERE expires_at < NOW() AND used_at IS NULL RETURNING *`
    );

    return result.rowCount ?? 0;
  },

  async isTokenValid(token: string, client?: PoolClient): Promise<boolean> {
    const result = await runQuery<{ valid: boolean }>(
      'userdata',
      `SELECT EXISTS(
         SELECT 1 FROM UnsubscribeTokens
         WHERE token = $1
         AND used_at IS NULL
         AND expires_at > NOW()
       ) as valid`,
      [token],
      client
    );

    return result.rows[0].valid;
  },
};
