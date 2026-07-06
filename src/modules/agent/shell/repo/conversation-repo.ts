/**
 * Agent conversation repo — Kysely adapter over the USER database
 * (docs/AGENT-MODULE-SPEC.md §2.6). Every read/delete is scoped by `user_id`.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok } from 'neverthrow';

import type { AgentError } from '../../core/errors.js';
import type { ConversationRepo } from '../../core/ports.js';
import type { AgentConversation, StoredMessageRole, StoredUiMessage } from '../../core/types.js';
import type { UserDatabase } from '@/infra/database/user/types.js';

const storageError = (error: unknown): AgentError => ({
  type: 'STORAGE',
  message: error instanceof Error ? error.message : 'Unknown storage error',
});

// Postgres unique_violation — a chat id already claimed (by another user).
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';

// Driver-dependent: pg returns Date, some configs return ISO strings.
const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

interface ConversationRow {
  readonly id: string;
  readonly user_id: string;
  readonly title: string | null;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

const toConversation = (row: ConversationRow): AgentConversation => ({
  id: row.id,
  userId: row.user_id,
  title: row.title,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
});

export const makeAgentConversationRepo = (db: Kysely<UserDatabase>): ConversationRepo => ({
  async create(userId, conversationId) {
    try {
      const row = await db
        .insertInto('agentconversations')
        .values({ id: conversationId, user_id: userId, title: null })
        .returningAll()
        .executeTakeFirstOrThrow();
      return ok(toConversation(row));
    } catch (error) {
      // Don't leak existence of another user's conversation: the same id
      // colliding on the PK reads as "not found", like every other route.
      if (isUniqueViolation(error)) {
        return err({ type: 'CONVERSATION_NOT_FOUND', conversationId });
      }
      return err(storageError(error));
    }
  },

  async getOwned(userId, conversationId) {
    try {
      const row = await db
        .selectFrom('agentconversations')
        .selectAll()
        .where('id', '=', conversationId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (row === undefined) {
        return err({ type: 'CONVERSATION_NOT_FOUND', conversationId });
      }
      return ok(toConversation(row));
    } catch (error) {
      return err(storageError(error));
    }
  },

  async list(userId, limit) {
    try {
      const rows = await db
        .selectFrom('agentconversations')
        .selectAll()
        .where('user_id', '=', userId)
        .orderBy('updated_at', 'desc')
        .limit(limit)
        .execute();
      return ok(rows.map(toConversation));
    } catch (error) {
      return err(storageError(error));
    }
  },

  async delete(userId, conversationId) {
    try {
      const result = await db
        .deleteFrom('agentconversations')
        .where('id', '=', conversationId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return ok(result.numDeletedRows > 0n);
    } catch (error) {
      return err(storageError(error));
    }
  },

  async appendMessages(conversationId, messages) {
    if (messages.length === 0) return ok(undefined);
    try {
      await db.transaction().execute(async (trx) => {
        for (const message of messages) {
          await trx
            .insertInto('agentmessages')
            .values({
              id: message.id,
              conversation_id: conversationId,
              role: message.role,
              parts: sql`${JSON.stringify(message.parts)}::jsonb`,
            })
            // Idempotent on message id: regenerated/extended assistant messages
            // overwrite their previous parts rather than duplicating rows.
            .onConflict((oc) =>
              oc
                .columns(['conversation_id', 'id'])
                .doUpdateSet({ parts: sql`${JSON.stringify(message.parts)}::jsonb` })
            )
            .execute();
        }
        await trx
          .updateTable('agentconversations')
          .set({ updated_at: sql`now()` })
          .where('id', '=', conversationId)
          .execute();
      });
      return ok(undefined);
    } catch (error) {
      return err(storageError(error));
    }
  },

  async getMessages(conversationId) {
    try {
      const rows = await db
        .selectFrom('agentmessages')
        .select(['id', 'role', 'parts'])
        .where('conversation_id', '=', conversationId)
        .orderBy('created_at', 'asc')
        .execute();
      const messages: StoredUiMessage[] = rows.map((row) => ({
        id: row.id,
        role: row.role as StoredMessageRole,
        parts: Array.isArray(row.parts) ? (row.parts as readonly unknown[]) : [],
      }));
      return ok(messages);
    } catch (error) {
      return err(storageError(error));
    }
  },

  async setTitle(conversationId, title) {
    try {
      await db
        .updateTable('agentconversations')
        .set({ title, updated_at: sql`now()` })
        .where('id', '=', conversationId)
        .execute();
      return ok(undefined);
    } catch (error) {
      return err(storageError(error));
    }
  },
});
