/**
 * Shared Kernel — Synthetic AI client (foundation §4.6).
 *
 * OpenAI-compatible client (native fetch) for `/chat/completions`, `/embeddings`,
 * `/models`. Powers `ask` + embeddings. Model ids can be overridden via env or
 * discovered from `/models`. All failures are `Upstream` errors.
 */

import { ok, err, type Result } from 'neverthrow';

import { upstreamError, type ApiError } from '../../core/errors.js';

import type {
  ChatMessage,
  ChatResponse,
  SyntheticClient,
  ToolCall,
  ToolDefinition,
} from '../../core/ports.js';

export interface SyntheticClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly embeddingModelOverride?: string;
  readonly chatModelOverride?: string;
}

interface ModelEntry {
  id: string;
}

export const makeSyntheticClient = (config: SyntheticClientConfig): SyntheticClient => {
  let modelsCache: ModelEntry[] | null = null;
  let cachedEmbedding: string | null = null;
  let cachedChat: string | null = null;

  const fetchModels = async (): Promise<ModelEntry[]> => {
    if (modelsCache !== null) return modelsCache;
    const resp = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`models ${String(resp.status)}`);
    const data = (await resp.json()) as { data: ModelEntry[] };
    modelsCache = data.data;
    return modelsCache;
  };

  return {
    async embed(text: string, model: string): Promise<Result<readonly number[], ApiError>> {
      try {
        const resp = await fetch(`${config.baseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model, input: text }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          const t = await resp.text().catch(() => '');
          return err(upstreamError(`embed ${String(resp.status)}: ${t}`, 'synthetic'));
        }
        const data = (await resp.json()) as { data: { embedding: number[] }[] };
        const first = data.data[0];
        if (first === undefined) return err(upstreamError('no embedding returned', 'synthetic'));
        return ok(first.embedding);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        return err(upstreamError(`embed failed: ${msg}`, 'synthetic', error));
      }
    },

    async chat(
      messages: readonly ChatMessage[],
      model: string,
      tools?: readonly ToolDefinition[],
      timeoutMs?: number
    ): Promise<Result<ChatResponse, ApiError>> {
      try {
        const body: Record<string, unknown> = { model, messages };
        if (tools !== undefined && tools.length > 0) body['tools'] = tools;
        const resp = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs ?? 30_000),
        });
        if (!resp.ok) {
          const t = await resp.text().catch(() => '');
          return err(upstreamError(`chat ${String(resp.status)}: ${t}`, 'synthetic'));
        }
        const data = (await resp.json()) as {
          choices: {
            message: {
              content: string | null;
              tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
            };
            finish_reason: string;
          }[];
        };
        const choice = data.choices[0];
        if (choice === undefined) return err(upstreamError('no chat choice returned', 'synthetic'));
        const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));
        return ok({
          content: choice.message.content,
          toolCalls,
          finishReason: choice.finish_reason,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        return err(upstreamError(`chat failed: ${msg}`, 'synthetic', error));
      }
    },

    async discoverEmbeddingModel(): Promise<Result<string, ApiError>> {
      if (config.embeddingModelOverride !== undefined && config.embeddingModelOverride !== '') {
        return ok(config.embeddingModelOverride);
      }
      if (cachedEmbedding !== null) return ok(cachedEmbedding);
      try {
        const models = await fetchModels();
        const m = models.find((x) => x.id.toLowerCase().includes('embed'));
        if (m === undefined) return err(upstreamError('no embedding model found', 'synthetic'));
        cachedEmbedding = m.id;
        return ok(m.id);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        return err(upstreamError(`discoverEmbeddingModel failed: ${msg}`, 'synthetic', error));
      }
    },

    async discoverChatModel(): Promise<Result<string, ApiError>> {
      if (config.chatModelOverride !== undefined && config.chatModelOverride !== '') {
        return ok(config.chatModelOverride);
      }
      if (cachedChat !== null) return ok(cachedChat);
      try {
        const models = await fetchModels();
        const candidates = models.filter((m) => !/embed|rerank/iu.test(m.id));
        const preferred = [/glm/iu, /qwen/iu, /deepseek/iu];
        for (const p of preferred) {
          const match = candidates.find((m) => p.test(m.id));
          if (match !== undefined) {
            cachedChat = match.id;
            return ok(match.id);
          }
        }
        const first = candidates[0];
        if (first === undefined) return err(upstreamError('no chat model found', 'synthetic'));
        cachedChat = first.id;
        return ok(first.id);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        return err(upstreamError(`discoverChatModel failed: ${msg}`, 'synthetic', error));
      }
    },

    async healthCheck(): Promise<Result<void, ApiError>> {
      try {
        const resp = await fetch(`${config.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${config.apiKey}` },
          signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) return err(upstreamError(`synthetic health ${String(resp.status)}`, 'synthetic'));
        return ok(undefined);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        return err(upstreamError(`synthetic health failed: ${msg}`, 'synthetic', error));
      }
    },
  };
};
