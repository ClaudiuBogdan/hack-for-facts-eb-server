/**
 * Shared Kernel — MCP server bootstrap (foundation §6.3).
 *
 * Builds one `McpServer`, registering the kernel tools + any module-contributed
 * tools. Each tool's handler returns the structured `McpToolOutput`; we wrap it
 * in the SDK's `{ content, structuredContent }` envelope (errors → `isError`).
 *
 * Tools that declare `ui` and resources with `ui://` URIs follow the MCP Apps
 * extension (SEP-1865): the `_meta.ui.resourceUri` link (plus the legacy
 * `ui/resourceUri` and ChatGPT `openai/outputTemplate` aliases) tells a
 * supporting host to render the tool's `structuredContent` in the referenced
 * HTML template; non-supporting hosts fall back to the text `content`.
 */

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
// eslint-disable-next-line import-x/no-unresolved -- SDK wildcard subpath exports
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { kernelToolInputSchema } from './input-schema.js';

import type { KernelMcpResource, KernelMcpTool, McpToolOutput } from './types.js';

const toolResponse = (output: McpToolOutput) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(output) }],
  structuredContent: output as unknown as Record<string, unknown>,
  ...(output.ok ? {} : { isError: true as const }),
});

/** The server is read-only over the serving DB (binding contract) — every tool is. */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export interface KernelMcpServerConfig {
  readonly name?: string;
  readonly version?: string;
  readonly instructions?: string;
}

export const createKernelMcpServer = (
  tools: readonly KernelMcpTool[],
  config: KernelMcpServerConfig = {},
  resources: readonly KernelMcpResource[] = []
): McpServer => {
  const server = new McpServer(
    {
      name: config.name ?? 'Transparenta.eu Redesign MCP',
      version: config.version ?? '1.0.0',
    },
    {
      ...(config.instructions !== undefined && { instructions: config.instructions }),
      capabilities: { tools: {}, ...(resources.length > 0 ? { resources: {} } : {}) },
    }
  );

  for (const tool of tools) {
    const base = {
      ...(tool.title !== undefined && { title: tool.title }),
      description: tool.description,
      inputSchema: kernelToolInputSchema(tool),
      // Unannotated tools are assumed destructive/open-world by hosts (ChatGPT
      // brands them WRITE/DESTRUCTIVE and prompts accordingly) — false here.
      annotations: READ_ONLY_ANNOTATIONS,
    };
    const handler = async (args: Record<string, unknown>) => toolResponse(await tool.handler(args));
    if (tool.ui !== undefined) {
      const { resourceUri, visibility } = tool.ui;
      registerAppTool(
        server,
        tool.name,
        {
          ...base,
          _meta: {
            ui: { resourceUri, ...(visibility !== undefined && { visibility: [...visibility] }) },
            // ChatGPT's pre-standard alias; harmless elsewhere.
            'openai/outputTemplate': resourceUri,
          },
        },
        handler
      );
    } else {
      server.registerTool(tool.name, base, handler);
    }
  }

  for (const resource of resources) {
    const mimeType = resource.mimeType ?? RESOURCE_MIME_TYPE;
    registerAppResource(
      server,
      resource.name,
      resource.uri,
      {
        mimeType,
        ...(resource.title !== undefined && { title: resource.title }),
        ...(resource.description !== undefined && { description: resource.description }),
        ...(resource.meta !== undefined && { _meta: { ...resource.meta } }),
      },
      () => ({
        contents: [
          {
            uri: resource.uri,
            mimeType,
            text: resource.text,
            ...(resource.meta !== undefined && { _meta: { ...resource.meta } }),
          },
        ],
      })
    );
  }

  return server;
};
