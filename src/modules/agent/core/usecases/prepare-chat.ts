/**
 * prepare-chat — the gate that runs BEFORE any LLM call (spec §2.3 steps 2-3).
 *
 * Order matters: quota first (cheapest denial), then conversation
 * load-or-create with ownership verification. No provider tokens are ever
 * spent for a request that fails here.
 */

import { err, ok, type Result } from 'neverthrow';

import type { AgentError } from '../errors.js';
import type { ConversationRepo, QuotaStore } from '../ports.js';
import type { AgentConversation, QuotaConfig, QuotaState } from '../types.js';

export interface PrepareChatDeps {
  readonly repo: ConversationRepo;
  readonly quota: QuotaStore;
  readonly quotaConfig: QuotaConfig;
}

export interface PrepareChatInput {
  readonly userId: string;
  readonly conversationId: string;
}

export interface PreparedChat {
  readonly conversation: AgentConversation;
  readonly isNewConversation: boolean;
  readonly quota: QuotaState;
}

export const computeQuotaState = (
  config: QuotaConfig,
  userId: string,
  usedTokens: number
): QuotaState => {
  const unlimited = config.unlimitedUserIds.includes(userId);
  const remaining = Math.max(config.dailyTokenBudget - usedTokens, 0);
  return {
    usedTokens,
    budgetTokens: config.dailyTokenBudget,
    remainingTokens: unlimited ? config.dailyTokenBudget : remaining,
    unlimited,
  };
};

export const prepareChat = async (
  deps: PrepareChatDeps,
  input: PrepareChatInput
): Promise<Result<PreparedChat, AgentError>> => {
  const usedResult = await deps.quota.usedToday(input.userId);
  if (usedResult.isErr()) return err(usedResult.error);

  const quota = computeQuotaState(deps.quotaConfig, input.userId, usedResult.value);
  if (!quota.unlimited && quota.remainingTokens <= 0) {
    return err({
      type: 'QUOTA_EXCEEDED',
      usedTokens: quota.usedTokens,
      budgetTokens: quota.budgetTokens,
    });
  }

  const existing = await deps.repo.getOwned(input.userId, input.conversationId);
  if (existing.isOk()) {
    return ok({ conversation: existing.value, isNewConversation: false, quota });
  }
  if (existing.error.type !== 'CONVERSATION_NOT_FOUND') {
    return err(existing.error);
  }

  // First turn of a new thread — create it under the caller's ownership. A
  // colliding id owned by ANOTHER user surfaces here as a STORAGE error from
  // the unique constraint, never as access to the other user's thread.
  const created = await deps.repo.create(input.userId, input.conversationId);
  if (created.isErr()) return err(created.error);
  return ok({ conversation: created.value, isNewConversation: true, quota });
};
