import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { kernelToolsToAiTools } from '@/modules/agent/index.js';
import {
  createMcpHttpDispatcher,
  kernelToolInputSchema,
  type KernelMcpTool,
} from '@/modules/shared/index.js';
import { createKernelMcpServer } from '@/modules/shared/shell/mcp/server.js';

const strictTool = (onCall: () => void): KernelMcpTool => ({
  name: 'strict_test_tool',
  description: 'Strict transport validation fixture.',
  strictInput: true,
  inputShape: {
    shape: z.literal('stats'),
    scope: z.object({ authorityCui: z.string().optional() }).strict().optional(),
  },
  handler: () => {
    onCall();
    return Promise.resolve({ ok: true, kind: 'test' });
  },
});

const invalidToolCallModel = (input: Readonly<Record<string, unknown>>) =>
  ({
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'invalid-tool-input',
    supportedUrls: {},
    doGenerate: () =>
      Promise.resolve({
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'strict_test_tool',
            input: JSON.stringify(input),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 0, reasoning: 0 },
        },
        warnings: [],
      }),
    doStream: () => Promise.reject(new Error('streaming is not used by this fixture')),
  }) as never;

describe('kernel MCP input schema', () => {
  it('rejects unknown keys when a tool opts into strict input', () => {
    const schema = kernelToolInputSchema({
      inputShape: { authorityCui: z.string() },
      strictInput: true,
    });

    expect(schema.safeParse({ authorityCui: '4267117' }).success).toBe(true);
    expect(schema.safeParse({ authorityCui: '4267117', authorityCUI: 'typo' }).success).toBe(false);
  });

  it('preserves the existing strip behavior for tools that do not opt in', () => {
    const schema = kernelToolInputSchema({ inputShape: { q: z.string() } });
    const parsed = schema.safeParse({ q: 'test', extra: true });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ q: 'test' });
  });

  it.each([
    { shape: 'stats', topn: 10 },
    { shape: 'stats', scope: { authorityCUI: '4267117' } },
  ])('rejects unknown keys through the MCP tools/call transport: %j', async (args) => {
    let calls = 0;
    const dispatcher = createMcpHttpDispatcher(() =>
      createKernelMcpServer([strictTool(() => (calls += 1))])
    );

    const response = await dispatcher.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'strict_test_tool', arguments: args },
    });

    expect(response).toMatchObject({
      result: { isError: true },
    });
    expect(JSON.stringify(response)).toContain('MCP error -32602');
    expect(JSON.stringify(response)).toContain('unrecognized_keys');
    expect(calls).toBe(0);
    await dispatcher.close();
  });

  it.each([
    { shape: 'stats', topn: 10 },
    { shape: 'stats', scope: { authorityCUI: '4267117' } },
  ])('rejects unknown keys through the in-process AI tool parser: %j', async (args) => {
    let calls = 0;
    const result = await generateText({
      model: invalidToolCallModel(args),
      tools: kernelToolsToAiTools([strictTool(() => (calls += 1))]),
      prompt: 'Call the strict test tool.',
    });

    expect(result.toolCalls[0]).toMatchObject({ invalid: true });
    expect(calls).toBe(0);
  });
});
