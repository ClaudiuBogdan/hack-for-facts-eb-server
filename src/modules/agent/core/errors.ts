/**
 * Agent module — domain error union + HTTP mapping (docs/AGENT-MODULE-SPEC.md §2.2).
 */

export type AgentError =
  | { readonly type: 'QUOTA_EXCEEDED'; readonly usedTokens: number; readonly budgetTokens: number }
  | { readonly type: 'CONVERSATION_NOT_FOUND'; readonly conversationId: string }
  | { readonly type: 'VALIDATION'; readonly message: string }
  | { readonly type: 'STORAGE'; readonly message: string }
  | { readonly type: 'NO_PROVIDER'; readonly message: string };

export const AGENT_ERROR_HTTP_STATUS: Readonly<Record<AgentError['type'], number>> = {
  QUOTA_EXCEEDED: 429,
  CONVERSATION_NOT_FOUND: 404,
  VALIDATION: 400,
  STORAGE: 500,
  NO_PROVIDER: 503,
};

/** Safe, user-facing message per error type — provider/storage details stay in logs. */
export const agentErrorMessage = (error: AgentError): string => {
  switch (error.type) {
    case 'QUOTA_EXCEEDED':
      return 'Daily agent usage limit reached. Try again tomorrow.';
    case 'CONVERSATION_NOT_FOUND':
      return 'Conversation not found.';
    case 'VALIDATION':
      return error.message;
    case 'STORAGE':
      return 'A storage error occurred.';
    case 'NO_PROVIDER':
      return 'The agent is not available right now.';
  }
};
