/**
 * Shared-registry adapter (docs/AGENT-MODULE-SPEC.md §2.4): wraps the kernel's
 * `KernelMcpTool`s — the SAME definitions served on /api/v1/mcp to external
 * LLM clients — as AI SDK tools for the in-process agent. One canonical tool
 * definition, two consumers, zero drift.
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { KernelMcpTool } from '@/modules/shared/index.js';

export const kernelToolsToAiTools = (tools: readonly KernelMcpTool[]): ToolSet => {
  const toolSet: ToolSet = {};
  for (const kernelTool of tools) {
    toolSet[kernelTool.name] = tool({
      description: kernelTool.description,
      inputSchema: z.object(kernelTool.inputShape),
      // The handler returns the audited McpToolOutput envelope ({ ok, kind,
      // link, item(s), meta, summary }) — already safe to stream to the client
      // as a tool part (same leak-audit guarantees as the MCP surface).
      execute: async (args: Record<string, unknown>) => kernelTool.handler(args),
    });
  }
  return toolSet;
};
