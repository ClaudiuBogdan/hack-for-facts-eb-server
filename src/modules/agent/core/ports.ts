/**
 * Agent module — ports (docs/AGENT-MODULE-SPEC.md §2.1).
 *
 * Every repo method is ownership-scoped: reads/writes take the Clerk `userId`
 * and MUST NOT return another user's data. Ownership is additionally re-checked
 * in the use-cases, so a repo bug cannot silently widen access.
 */

import type { AgentError } from './errors.js';
import type { AgentConversation, StoredUiMessage } from './types.js';
import type { Result } from 'neverthrow';

export interface ConversationRepo {
  /** Insert a conversation owned by `userId` with the caller-provided id. */
  create(userId: string, conversationId: string): Promise<Result<AgentConversation, AgentError>>;
  /** Fetch a conversation ONLY if owned by `userId` (else CONVERSATION_NOT_FOUND). */
  getOwned(userId: string, conversationId: string): Promise<Result<AgentConversation, AgentError>>;
  list(userId: string, limit: number): Promise<Result<readonly AgentConversation[], AgentError>>;
  /** Delete an owned conversation (messages cascade). False → not found/not owned. */
  delete(userId: string, conversationId: string): Promise<Result<boolean, AgentError>>;
  /** Upsert messages (idempotent on message id) and bump `updated_at`. */
  appendMessages(
    conversationId: string,
    messages: readonly StoredUiMessage[]
  ): Promise<Result<void, AgentError>>;
  getMessages(conversationId: string): Promise<Result<readonly StoredUiMessage[], AgentError>>;
  setTitle(conversationId: string, title: string): Promise<Result<void, AgentError>>;
}

export interface QuotaStore {
  /** Input+output tokens consumed by `userId` in the current UTC day. */
  usedToday(userId: string): Promise<Result<number, AgentError>>;
  /** Add tokens to today's counter (fire-and-forget accounting). */
  recordUsage(userId: string, tokens: number): Promise<Result<void, AgentError>>;
}
