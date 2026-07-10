/**
 * Conversation read/delete use-cases (spec §2.2) — all ownership-scoped.
 */

import { err, ok, type Result } from 'neverthrow';

import type { AgentError } from '../errors.js';
import type { ConversationRepo } from '../ports.js';
import type { AgentConversation, ConversationWithMessages } from '../types.js';

export interface ConversationUsecaseDeps {
  readonly repo: ConversationRepo;
}

const LIST_LIMIT = 50;

export const listConversations = async (
  deps: ConversationUsecaseDeps,
  input: { readonly userId: string }
): Promise<Result<readonly AgentConversation[], AgentError>> =>
  deps.repo.list(input.userId, LIST_LIMIT);

export const getConversation = async (
  deps: ConversationUsecaseDeps,
  input: { readonly userId: string; readonly conversationId: string }
): Promise<Result<ConversationWithMessages, AgentError>> => {
  const owned = await deps.repo.getOwned(input.userId, input.conversationId);
  if (owned.isErr()) return err(owned.error);

  const messages = await deps.repo.getMessages(input.userId, input.conversationId);
  if (messages.isErr()) return err(messages.error);

  return ok({ conversation: owned.value, messages: messages.value });
};

export const deleteConversation = async (
  deps: ConversationUsecaseDeps,
  input: { readonly userId: string; readonly conversationId: string }
): Promise<Result<boolean, AgentError>> => deps.repo.delete(input.userId, input.conversationId);
