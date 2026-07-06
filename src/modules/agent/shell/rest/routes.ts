/**
 * Agent REST surface (docs/AGENT-MODULE-SPEC.md §2.2-2.3) — mounted at
 * /api/v1/agent by the redesign-surface composition root.
 *
 * Auth is STRICT and self-contained: this plugin runs its own Clerk
 * authentication preHandler and rejects anonymous sessions, regardless of
 * whether the owning app also runs the legacy global auth middleware.
 *
 * POST /chat streams AI SDK UIMessage chunks (SSE) via the standalone
 * `toUIMessageStream` + `pipeUIMessageStreamToResponse` helpers — the
 * non-deprecated v7 path — writing to `reply.raw` after `reply.hijack()`.
 */

import { Value } from '@sinclair/typebox/value';
import {
  convertToModelMessages,
  generateText,
  pipeUIMessageStreamToResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type UIMessage,
  type ToolSet,
} from 'ai';

import {
  makeAuthMiddleware,
  requireAuthHandler,
  isAuthenticated,
  type AuthProvider,
} from '@/modules/auth/index.js';

import { AGENT_ERROR_HTTP_STATUS, agentErrorMessage, type AgentError } from '../../core/errors.js';
import { ChatRequestSchema, MAX_CHAT_BODY_BYTES, type QuotaConfig } from '../../core/types.js';
import {
  deleteConversation,
  getConversation,
  listConversations,
} from '../../core/usecases/conversations.js';
import { computeQuotaState, prepareChat } from '../../core/usecases/prepare-chat.js';

import type { ConversationRepo, QuotaStore } from '../../core/ports.js';
import type { ModelRouter } from '../llm/model-router.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

export interface AgentRoutesDeps {
  readonly repo: ConversationRepo;
  readonly quota: QuotaStore;
  readonly quotaConfig: QuotaConfig;
  readonly modelRouter: ModelRouter;
  readonly toolSet: ToolSet;
  readonly systemPrompt: string;
  readonly authProvider: AuthProvider;
}

const MAX_STEPS_PER_TURN = 8;
const TURN_TIMEOUT_MS = 120_000;
const TITLE_MAX_OUTPUT_TOKENS = 24;

const sendAgentError = async (reply: FastifyReply, error: AgentError): Promise<void> => {
  await reply
    .status(AGENT_ERROR_HTTP_STATUS[error.type])
    .send({ error: { code: error.type, message: agentErrorMessage(error) } });
};

/** The strict-auth preHandler guarantees this never returns null in handlers. */
const authenticatedUserId = (request: FastifyRequest): string | null =>
  isAuthenticated(request.auth) ? request.auth.userId : null;

const firstUserText = (message: UIMessage): string => {
  for (const part of message.parts) {
    if (part.type === 'text') return part.text;
  }
  return '';
};

export const makeAgentRoutes = (deps: AgentRoutesDeps): FastifyPluginAsync => {
  const authMiddleware = makeAuthMiddleware({ authProvider: deps.authProvider });

  return async (app) => {
    app.addHook('preHandler', authMiddleware);
    app.addHook('preHandler', requireAuthHandler);

    // ── POST /chat — one agent turn, streamed ────────────────────────────────
    app.post('/chat', { bodyLimit: MAX_CHAT_BODY_BYTES }, async (request, reply) => {
      const userId = authenticatedUserId(request);
      if (userId === null) return sendAgentError(reply, { type: 'VALIDATION', message: 'No auth' });

      if (!Value.Check(ChatRequestSchema, request.body)) {
        return sendAgentError(reply, { type: 'VALIDATION', message: 'Invalid chat request body' });
      }
      const body = request.body;
      const uiMessages = body.messages as unknown as UIMessage[];
      const lastMessage = uiMessages[uiMessages.length - 1];
      if (lastMessage?.role !== 'user') {
        return sendAgentError(reply, {
          type: 'VALIDATION',
          message: 'Last message must be a user message',
        });
      }

      const prepared = await prepareChat(
        { repo: deps.repo, quota: deps.quota, quotaConfig: deps.quotaConfig },
        { userId, conversationId: body.id }
      );
      if (prepared.isErr()) return sendAgentError(reply, prepared.error);
      const { conversation, isNewConversation } = prepared.value;

      // Persist the user turn BEFORE the provider call (crash-safe).
      const persistedUser = await deps.repo.appendMessages(conversation.id, [lastMessage]);
      if (persistedUser.isErr()) return sendAgentError(reply, persistedUser.error);

      const model = deps.modelRouter.resolve('chat');
      if (model.isErr()) return sendAgentError(reply, model.error);

      let modelMessages;
      try {
        modelMessages = await convertToModelMessages(uiMessages);
      } catch {
        return sendAgentError(reply, {
          type: 'VALIDATION',
          message: 'Messages could not be converted for the model',
        });
      }

      const result = streamText({
        model: model.value,
        system: deps.systemPrompt,
        messages: modelMessages,
        tools: deps.toolSet,
        stopWhen: stepCountIs(MAX_STEPS_PER_TURN),
        timeout: { totalMs: TURN_TIMEOUT_MS },
        onFinish: async (event) => {
          const usage = event.usage;
          const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
          const recorded = await deps.quota.recordUsage(userId, tokens);
          if (recorded.isErr()) {
            request.log.warn({ err: recorded.error }, 'agent: failed to record token usage');
          }
        },
      });

      const uiStream = toUIMessageStream({
        stream: result.stream,
        tools: deps.toolSet,
        originalMessages: uiMessages,
        onError: (error) => {
          request.log.error({ err: error }, 'agent: stream error');
          return 'The agent hit an internal error. Please try again.';
        },
        onEnd: async ({ responseMessage }) => {
          const persisted = await deps.repo.appendMessages(conversation.id, [responseMessage]);
          if (persisted.isErr()) {
            request.log.error({ err: persisted.error }, 'agent: failed to persist response');
          }
          if (isNewConversation) {
            await autoTitle(userId, conversation.id, firstUserText(lastMessage));
          }
        },
      });

      // Hand the socket to the AI SDK. Copy already-set headers (CORS) onto the
      // raw response first — hijack bypasses Fastify's serialization.
      reply.hijack();
      const rawHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (typeof value === 'string' || Array.isArray(value)) rawHeaders[name] = value;
        else if (typeof value === 'number') rawHeaders[name] = String(value);
      }
      pipeUIMessageStreamToResponse({
        response: reply.raw,
        stream: uiStream,
        headers: { ...rawHeaders, 'cache-control': 'no-store' },
      });
      return reply;
    });

    const autoTitle = async (
      userId: string,
      conversationId: string,
      userText: string
    ): Promise<void> => {
      if (userText.trim() === '') return;
      const titleModel = deps.modelRouter.resolve('title');
      if (titleModel.isErr()) return;
      try {
        const { text, usage } = await generateText({
          model: titleModel.value,
          system:
            'Generate a very short title (max 6 words, no quotes, language of the input) for a conversation that starts with the given message.',
          prompt: userText.slice(0, 500),
          maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
        });
        const titleTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        await deps.quota.recordUsage(userId, titleTokens);
        const title = text.trim().slice(0, 120);
        if (title !== '') await deps.repo.setTitle(conversationId, title);
      } catch {
        // Title generation is best-effort; the thread stays untitled.
      }
    };

    // ── Conversation management ──────────────────────────────────────────────
    app.get('/conversations', async (request, reply) => {
      const userId = authenticatedUserId(request);
      if (userId === null) return sendAgentError(reply, { type: 'VALIDATION', message: 'No auth' });

      const result = await listConversations({ repo: deps.repo }, { userId });
      if (result.isErr()) return sendAgentError(reply, result.error);
      return reply.send({
        conversations: result.value.map((c) => ({
          id: c.id,
          title: c.title,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
        })),
      });
    });

    app.get<{ Params: { id: string } }>('/conversations/:id', async (request, reply) => {
      const userId = authenticatedUserId(request);
      if (userId === null) return sendAgentError(reply, { type: 'VALIDATION', message: 'No auth' });

      const result = await getConversation(
        { repo: deps.repo },
        { userId, conversationId: request.params.id }
      );
      if (result.isErr()) return sendAgentError(reply, result.error);
      const { conversation, messages } = result.value;
      return reply.send({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
        messages,
      });
    });

    app.delete<{ Params: { id: string } }>('/conversations/:id', async (request, reply) => {
      const userId = authenticatedUserId(request);
      if (userId === null) return sendAgentError(reply, { type: 'VALIDATION', message: 'No auth' });

      const result = await deleteConversation(
        { repo: deps.repo },
        { userId, conversationId: request.params.id }
      );
      if (result.isErr()) return sendAgentError(reply, result.error);
      if (!result.value) {
        return sendAgentError(reply, {
          type: 'CONVERSATION_NOT_FOUND',
          conversationId: request.params.id,
        });
      }
      return reply.status(204).send();
    });

    // ── Quota ────────────────────────────────────────────────────────────────
    app.get('/quota', async (request, reply) => {
      const userId = authenticatedUserId(request);
      if (userId === null) return sendAgentError(reply, { type: 'VALIDATION', message: 'No auth' });

      const used = await deps.quota.usedToday(userId);
      if (used.isErr()) return sendAgentError(reply, used.error);
      return reply.send(computeQuotaState(deps.quotaConfig, userId, used.value));
    });
  };
};
