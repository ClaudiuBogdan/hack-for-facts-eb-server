/**
 * Model router (docs/AGENT-MODULE-SPEC.md §2.5) — maps a usage tier to a
 * LanguageModel across the configured providers.
 *
 * Model ids are `provider/model` strings (`anthropic/claude-sonnet-4-5`,
 * `openai/gpt-5.2`, `openrouter/google/gemini-2.5-flash` — for OpenRouter the
 * remainder after the first `/` is the OpenRouter model path). A tier whose
 * provider key is missing may route through OpenRouter (which understands the
 * full provider/model id); it is never sent as a bare, incompatible model id
 * to a different direct provider.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { err, ok, type Result } from 'neverthrow';

import type { AgentError } from '../../core/errors.js';
import type { LanguageModel } from 'ai';

export type ModelTier = 'chat' | 'title' | 'research';

export interface ModelRouterConfig {
  readonly anthropicApiKey?: string;
  readonly openaiApiKey?: string;
  readonly openrouterApiKey?: string;
  /** `provider/model` per tier; unset tiers use the first configured provider's defaults. */
  readonly tierModels?: Partial<Readonly<Record<ModelTier, string>>>;
}

export interface ModelRouter {
  resolve(tier: ModelTier): Result<LanguageModel, AgentError>;
  readonly configuredProviders: readonly string[];
}

const DEFAULT_TIER_MODELS: Readonly<Record<ModelTier, string>> = {
  chat: 'anthropic/claude-sonnet-4-5',
  title: 'anthropic/claude-haiku-4-5-20251001',
  research: 'anthropic/claude-opus-4-8',
};

const PROVIDER_DEFAULT_TIER_MODELS: Readonly<Record<string, Readonly<Record<ModelTier, string>>>> =
  {
    anthropic: DEFAULT_TIER_MODELS,
    openai: {
      chat: 'openai/gpt-4.1',
      title: 'openai/gpt-4.1-mini',
      research: 'openai/gpt-4.1',
    },
    openrouter: {
      chat: 'openrouter/anthropic/claude-sonnet-4-5',
      title: 'openrouter/anthropic/claude-haiku-4-5-20251001',
      research: 'openrouter/anthropic/claude-opus-4-8',
    },
  };

type ModelFactory = (modelId: string) => LanguageModel;

export const makeModelRouter = (config: ModelRouterConfig): ModelRouter => {
  const factories = new Map<string, ModelFactory>();

  if (config.anthropicApiKey !== undefined && config.anthropicApiKey !== '') {
    const provider = createAnthropic({ apiKey: config.anthropicApiKey });
    factories.set('anthropic', (modelId) => provider(modelId));
  }
  if (config.openaiApiKey !== undefined && config.openaiApiKey !== '') {
    const provider = createOpenAI({ apiKey: config.openaiApiKey });
    factories.set('openai', (modelId) => provider(modelId));
  }
  if (config.openrouterApiKey !== undefined && config.openrouterApiKey !== '') {
    const provider = createOpenRouter({ apiKey: config.openrouterApiKey });
    factories.set('openrouter', (modelId) => provider.chat(modelId));
  }

  const configuredProviders = [...factories.keys()];

  const resolveSpec = (spec: string): Result<LanguageModel, AgentError> => {
    const separator = spec.indexOf('/');
    if (separator <= 0 || separator === spec.length - 1) {
      return err({ type: 'NO_PROVIDER', message: `Invalid model spec: ${spec}` });
    }
    const providerName = spec.slice(0, separator);
    const modelId = spec.slice(separator + 1);
    const factory = factories.get(providerName);
    if (factory !== undefined) return ok(factory(modelId));

    if (configuredProviders.length === 0) {
      return err({ type: 'NO_PROVIDER', message: 'No LLM provider API key is configured' });
    }

    // OpenRouter accepts the original provider/model path. A direct provider
    // must never receive another provider's bare model id (for example a
    // Claude id sent to OpenAI), because that fails late after accepting work.
    const openrouter = factories.get('openrouter');
    if (openrouter !== undefined && providerName !== 'openrouter') {
      return ok(openrouter(spec));
    }

    return err({
      type: 'NO_PROVIDER',
      message: `Model provider "${providerName}" is not configured for ${spec}`,
    });
  };

  return {
    configuredProviders,
    resolve(tier) {
      const firstProvider = configuredProviders[0];
      const providerDefaults =
        firstProvider === undefined ? undefined : PROVIDER_DEFAULT_TIER_MODELS[firstProvider];
      const spec =
        config.tierModels?.[tier] ?? providerDefaults?.[tier] ?? DEFAULT_TIER_MODELS[tier];
      return resolveSpec(spec);
    },
  };
};
