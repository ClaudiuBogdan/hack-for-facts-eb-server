/**
 * Agent module — domain types (docs/AGENT-MODULE-SPEC.md §2).
 *
 * The stored message shape mirrors the AI SDK `UIMessage` (id, role, parts) so a
 * persisted conversation re-hydrates `useChat` losslessly and re-enters
 * `convertToModelMessages` without translation. Parts are stored verbatim as JSON.
 */

import { Type, type Static } from '@sinclair/typebox';

// ─────────────────────────────────────────────────────────────────────────────
// Conversations
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentConversation {
  readonly id: string;
  readonly userId: string;
  readonly title: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type StoredMessageRole = 'user' | 'assistant' | 'system';

/** AI SDK UIMessage, persisted. `parts` is the SDK part array, stored verbatim. */
export interface StoredUiMessage {
  readonly id: string;
  readonly role: StoredMessageRole;
  readonly parts: readonly unknown[];
}

export interface ConversationWithMessages {
  readonly conversation: AgentConversation;
  readonly messages: readonly StoredUiMessage[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Quota
// ─────────────────────────────────────────────────────────────────────────────

export interface QuotaConfig {
  /** Daily input+output token budget per user. */
  readonly dailyTokenBudget: number;
  /** Clerk user ids exempt from the budget (admins). */
  readonly unlimitedUserIds: readonly string[];
}

export interface QuotaState {
  readonly usedTokens: number;
  readonly budgetTokens: number;
  readonly remainingTokens: number;
  readonly unlimited: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat request (wire shape sent by the AI SDK `useChat` default transport)
// ─────────────────────────────────────────────────────────────────────────────

const UserTextPartSchema = Type.Object(
  {
    type: Type.Literal('text'),
    text: Type.String({ minLength: 1, maxLength: 32_000 }),
  },
  { additionalProperties: false }
);

export const ChatRequestSchema = Type.Object(
  {
    /** Conversation id — the `useChat` chat id. Created on first turn. */
    id: Type.String({ minLength: 1, maxLength: 64 }),
    messages: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 64 }),
          role: Type.Literal('user'),
          parts: Type.Array(UserTextPartSchema, { minItems: 1, maxItems: 20 }),
        },
        { additionalProperties: false }
      ),
      // The server owns history. The client sends only the new user turn.
      { minItems: 1, maxItems: 1 }
    ),
  },
  { additionalProperties: false }
);

export type ChatRequest = Static<typeof ChatRequestSchema>;

/** Max UIMessage payload we accept per turn, bytes (defensive bound). */
export const MAX_CHAT_BODY_BYTES = 512 * 1024;
