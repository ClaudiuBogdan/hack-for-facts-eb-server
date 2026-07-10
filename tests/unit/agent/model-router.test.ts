import { describe, expect, it } from 'vitest';

import { makeModelRouter } from '@/modules/agent/shell/llm/model-router.js';

describe('Agent model router', () => {
  it('uses a provider-specific default when only OpenAI is configured', () => {
    const router = makeModelRouter({ openaiApiKey: 'test-key' });

    const result = router.resolve('chat');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect((result.value as unknown as { modelId: string }).modelId).toBe('gpt-4.1');
    }
  });

  it('does not send an Anthropic model id to a direct OpenAI provider', () => {
    const router = makeModelRouter({
      openaiApiKey: 'test-key',
      tierModels: { chat: 'anthropic/claude-sonnet-4-5' },
    });

    const result = router.resolve('chat');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('NO_PROVIDER');
    }
  });

  it('can route another provider model through OpenRouter using its full id', () => {
    const router = makeModelRouter({
      openrouterApiKey: 'test-key',
      tierModels: { chat: 'anthropic/claude-sonnet-4-5' },
    });

    const result = router.resolve('chat');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect((result.value as unknown as { modelId: string }).modelId).toBe(
        'anthropic/claude-sonnet-4-5'
      );
    }
  });
});
