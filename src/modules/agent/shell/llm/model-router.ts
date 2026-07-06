/**
 * Model router (docs/AGENT-MODULE-SPEC.md §2.5) — maps a usage tier to a
 * LanguageModel across the configured providers.
 *
 * Model ids are `provider/model` strings (`anthropic/claude-sonnet-4-5`,
 * `openai/gpt-5.2`, `openrouter/google/gemini-2.5-flash` — for OpenRouter the
 * remainder after the first `/` is the OpenRouter model path). A tier whose
 * provider key is missing falls back to the first configured provider's
 * default; zero configured providers disables the module at boot.
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
  /** `provider/model` per tier; unset tiers use DEFAULT_TIER_MODELS. */
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

    // Provider not configured — fall back to any configured provider with the
    // bare model id (useful when the same model is reachable via OpenRouter).
    const fallbackName = configuredProviders[0];
    if (fallbackName === undefined) {
      return err({ type: 'NO_PROVIDER', message: 'No LLM provider API key is configured' });
    }
    const fallback = factories.get(fallbackName);
    if (fallback === undefined) {
      return err({ type: 'NO_PROVIDER', message: 'No LLM provider API key is configured' });
    }
    return ok(fallbackName === 'openrouter' ? fallback(spec) : fallback(modelId));
  };

  return {
    configuredProviders,
    resolve(tier) {
      const spec = config.tierModels?.[tier] ?? DEFAULT_TIER_MODELS[tier];
      return resolveSpec(spec);
    },
  };
};
