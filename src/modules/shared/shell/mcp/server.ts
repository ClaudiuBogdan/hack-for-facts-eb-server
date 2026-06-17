/**
 * Shared Kernel — MCP server bootstrap (foundation §6.3).
 *
 * Builds one `McpServer`, registering the kernel tools + any module-contributed
 * tools. Each tool's handler returns the structured `McpToolOutput`; we wrap it
 * in the SDK's `{ content, structuredContent }` envelope (errors → `isError`).
 */

// eslint-disable-next-line import-x/no-unresolved -- SDK wildcard subpath exports
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { KernelMcpTool, McpToolOutput } from './types.js';

const toolResponse = (output: McpToolOutput) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(output) }],
  structuredContent: output as unknown as Record<string, unknown>,
  ...(output.ok ? {} : { isError: true as const }),
});

export interface KernelMcpServerConfig {
  readonly name?: string;
  readonly version?: string;
  readonly instructions?: string;
}

export const createKernelMcpServer = (
  tools: readonly KernelMcpTool[],
  config: KernelMcpServerConfig = {}
): McpServer => {
  const server = new McpServer(
    {
      name: config.name ?? 'Transparenta.eu Redesign MCP',
      version: config.version ?? '1.0.0',
    },
    {
      ...(config.instructions !== undefined && { instructions: config.instructions }),
      capabilities: { tools: {} },
    }
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputShape },
      async (args: Record<string, unknown>) => toolResponse(await tool.handler(args))
    );
  }

  return server;
};
