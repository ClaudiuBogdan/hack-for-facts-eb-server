/**
 * `makeAsk` returns `ServiceUnavailable` when the chat model fails. That code
 * passes through the production GraphQL formatter unredacted, so the message
 * must be static: the upstream error (provider host, network detail) never
 * reaches the client.
 */

import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeAsk, type AskDeps } from '@/modules/shared/core/usecases/ask.js';

import type { Entity360Deps } from '@/modules/shared/core/usecases/entity-360.js';
import type { ApiError, ChatResponse, SyntheticClient } from '@/modules/shared/index.js';

const UPSTREAM_DETAIL = 'connect ECONNREFUSED 10.0.0.1:443 (provider token abc)';

const syntheticClient = (chat: Result<ChatResponse, ApiError>): SyntheticClient => ({
  embed: async () => ok([]),
  chat: async () => chat,
  discoverEmbeddingModel: async () => ok('embed'),
  discoverChatModel: async () => ok('chat'),
  healthCheck: async () => ok(undefined),
});

// No cui is supplied, so the entity-360 fan-out is never reached.
const unusedEntity360Deps = {
  identityRepo: {},
  flowsRepo: {},
  searchRepo: {},
  registry: {},
} as unknown as Entity360Deps;

const deps = (chat: Result<ChatResponse, ApiError>): AskDeps => ({
  syntheticClient: syntheticClient(chat),
  entity360Deps: unusedEntity360Deps,
  chatModel: 'test-model',
});

describe('makeAsk', () => {
  it('returns a static ServiceUnavailable message when the chat model fails', async () => {
    const res = await makeAsk(deps(err({ type: 'ServiceUnavailable', message: UPSTREAM_DETAIL })), {
      question: 'What is the budget?',
    });
    expect(res.isErr()).toBe(true);
    const error = (res as { error: ApiError }).error;
    expect(error.type).toBe('ServiceUnavailable');
    expect(error.message).toBe('ask unavailable: the chat model did not answer');
    expect(error.message).not.toContain('ECONNREFUSED');
  });

  it('returns the grounded answer when the chat model answers', async () => {
    const res = await makeAsk(
      deps(ok({ content: 'The budget is 1 RON.', toolCalls: [], finishReason: 'stop' })),
      { question: 'What is the budget?' }
    );
    expect(res.isOk()).toBe(true);
    expect(
      (res as { value: { answer: string; model: string; groundedOnCui: string | null } }).value
    ).toEqual({ answer: 'The budget is 1 RON.', model: 'test-model', groundedOnCui: null });
  });
});
