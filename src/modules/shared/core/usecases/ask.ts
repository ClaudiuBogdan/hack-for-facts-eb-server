/**
 * Shared Kernel — Ask usecase (foundation §4.4/§4.6).
 *
 * A minimal grounded Q&A: resolve the question to an entity (when it names one),
 * assemble a compact entity-360 context, and ask the synthetic chat model for a
 * grounded answer. Capability-gated: if the synthetic client is unavailable the
 * usecase returns a `ServiceUnavailable` error rather than fabricating. Tool-loop
 * agentic behaviour is left to the per-source modules; the kernel ask is the
 * cross-source baseline.
 */

import { err, ok, type Result } from 'neverthrow';

import { serviceUnavailable, type ApiError } from '../errors.js';
import { makeEntity360, type Entity360Deps } from './entity-360.js';

import type { ChatMessage, SyntheticClient } from '../ports.js';

export interface AskDeps {
  readonly syntheticClient: SyntheticClient;
  readonly entity360Deps: Entity360Deps;
  /** Chat model id; resolved at wiring time (env override or discovery). */
  readonly chatModel: string;
}

export interface AskInput {
  readonly question: string;
  /** Optional CUI hint to ground the answer on a specific entity. */
  readonly cui?: string;
  readonly timeoutMs?: number;
}

export interface AskResult {
  readonly answer: string;
  readonly model: string;
  readonly groundedOnCui: string | null;
}

const SYSTEM_PROMPT =
  'You answer questions about Romanian public entities using ONLY the provided ' +
  'structured context (organization identity, money-flow summaries, source ' +
  'presence). If the context is insufficient, say so plainly. Be concise and ' +
  'cite figures from the context.';

export const makeAsk = async (
  deps: AskDeps,
  input: AskInput
): Promise<Result<AskResult, ApiError>> => {
  const { syntheticClient, entity360Deps, chatModel } = deps;

  let context = 'No specific entity was identified for this question.';
  let groundedOnCui: string | null = null;

  if (input.cui !== undefined && input.cui.trim() !== '') {
    const e360 = await makeEntity360(entity360Deps, input.cui);
    if (e360.isOk()) {
      groundedOnCui = e360.value.cui;
      context = JSON.stringify({
        organization: e360.value.organization,
        flowsIn: e360.value.flowsIn,
        flowsOut: e360.value.flowsOut,
        documentCount: e360.value.documentCount,
        presence: e360.value.presence,
      });
    }
  }

  const messages: readonly ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Context:\n${context}\n\nQuestion: ${input.question}` },
  ];

  const chat = await syntheticClient.chat(messages, chatModel, undefined, input.timeoutMs ?? 30_000);
  if (chat.isErr()) {
    return err(serviceUnavailable(`ask unavailable: ${chat.error.message}`));
  }

  return ok({
    answer: chat.value.content ?? '',
    model: chatModel,
    groundedOnCui,
  });
};
