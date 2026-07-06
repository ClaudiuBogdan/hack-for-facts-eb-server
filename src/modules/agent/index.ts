/**
 * Agent module — public API (docs/AGENT-MODULE-SPEC.md).
 *
 * A SERVICE module on the redesign surface (not a data-source module): it
 * contributes no GraphQL slice or contributor. It consumes the kernel's shared
 * tool registry (`KernelMcpTool[]`) — the same definitions served on
 * /api/v1/mcp — and exposes an authenticated REST surface at /api/v1/agent.
 *
 * Deps come from BOTH worlds: kernel tools (prod DB) + legacy-app services
 * (user DB, Redis, Clerk auth provider). The standalone redesign server does
 * not wire this module.
 */

import { makeModelRouter, type ModelTier } from './shell/llm/model-router.js';
import { buildSystemPrompt } from './shell/prompts/system-prompt.js';
import {
  makeInMemoryQuotaStore,
  makeRedisQuotaStore,
  type QuotaRedis,
} from './shell/quota/quota-store.js';
import { makeAgentConversationRepo } from './shell/repo/conversation-repo.js';
import { makeAgentRoutes } from './shell/rest/routes.js';
import { kernelToolsToAiTools } from './shell/tools/kernel-tools.js';

import type { UserDatabase } from '@/infra/database/user/types.js';
import type { AuthProvider } from '@/modules/auth/index.js';
import type { KernelMcpTool } from '@/modules/shared/index.js';
import type { FastifyPluginAsync } from 'fastify';
import type { Kysely } from 'kysely';

export interface AgentModuleConfig {
  readonly clientBaseUrl: string;
  readonly dailyTokenBudget: number;
  readonly unlimitedUserIds: readonly string[];
  readonly anthropicApiKey?: string;
  readonly openaiApiKey?: string;
  readonly openrouterApiKey?: string;
  readonly tierModels?: Partial<Readonly<Record<ModelTier, string>>>;
}

export interface AgentModuleDeps {
  /** The shared tool registry: kernel + module MCP tools (spec §2.4). */
  readonly tools: readonly KernelMcpTool[];
  readonly userDb: Kysely<UserDatabase>;
  /** Quota counters. Null → in-memory store (dev/tests only). */
  readonly redis: QuotaRedis | null;
  readonly authProvider: AuthProvider;
  readonly config: AgentModuleConfig;
}

export interface AgentModule {
  /** Register at prefix `/api/v1/agent`. */
  readonly routesPlugin: FastifyPluginAsync;
  /** Providers with configured API keys ([] → agent cannot serve chat). */
  readonly configuredProviders: readonly string[];
}

export const makeAgentModule = (deps: AgentModuleDeps): AgentModule => {
  const modelRouter = makeModelRouter({
    ...(deps.config.anthropicApiKey !== undefined && {
      anthropicApiKey: deps.config.anthropicApiKey,
    }),
    ...(deps.config.openaiApiKey !== undefined && { openaiApiKey: deps.config.openaiApiKey }),
    ...(deps.config.openrouterApiKey !== undefined && {
      openrouterApiKey: deps.config.openrouterApiKey,
    }),
    ...(deps.config.tierModels !== undefined && { tierModels: deps.config.tierModels }),
  });

  const routesPlugin = makeAgentRoutes({
    repo: makeAgentConversationRepo(deps.userDb),
    quota: deps.redis === null ? makeInMemoryQuotaStore() : makeRedisQuotaStore(deps.redis),
    quotaConfig: {
      dailyTokenBudget: deps.config.dailyTokenBudget,
      unlimitedUserIds: deps.config.unlimitedUserIds,
    },
    modelRouter,
    toolSet: kernelToolsToAiTools(deps.tools),
    systemPrompt: buildSystemPrompt({ clientBaseUrl: deps.config.clientBaseUrl }),
    authProvider: deps.authProvider,
  });

  return { routesPlugin, configuredProviders: modelRouter.configuredProviders };
};

export type { ConversationRepo, QuotaStore } from './core/ports.js';
export type { AgentError } from './core/errors.js';
export * from './core/types.js';
export { makeAgentConversationRepo } from './shell/repo/conversation-repo.js';
export { makeInMemoryQuotaStore, makeRedisQuotaStore } from './shell/quota/quota-store.js';
export { kernelToolsToAiTools } from './shell/tools/kernel-tools.js';
export { makeModelRouter, type ModelRouter, type ModelTier } from './shell/llm/model-router.js';
