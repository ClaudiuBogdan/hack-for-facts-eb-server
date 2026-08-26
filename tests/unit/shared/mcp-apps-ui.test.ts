/**
 * MCP Apps (SEP-1865) surface: a tool with `ui` advertises the widget in
 * `_meta` (standard + legacy + ChatGPT alias keys), the kernel serves the
 * `ui://` resource with the MCP Apps mimetype, and a tool without `ui` stays
 * unchanged. Runs the REAL kernel server through the HTTP dispatcher.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMcpHttpDispatcher } from '@/modules/shared/shell/mcp/http-dispatch.js';
import { createKernelMcpServer } from '@/modules/shared/shell/mcp/server.js';
import {
  ENTITY_SEARCH_WIDGET_URI,
  makeKernelMcpResources,
} from '@/modules/shared/shell/mcp/widgets/resources.js';

import type { KernelMcpResource, KernelMcpTool } from '@/modules/shared/shell/mcp/types.js';

const uiTool: KernelMcpTool = {
  name: 'search_entities',
  title: 'Căutare entități',
  ui: { resourceUri: ENTITY_SEARCH_WIDGET_URI },
  description: 'test tool with a widget',
  inputShape: { query: z.string() },
  handler: () => Promise.resolve({ ok: true, kind: 'entity_search', items: [] }),
};

const plainTool: KernelMcpTool = {
  name: 'resolve_entity',
  description: 'test tool without a widget',
  inputShape: { query: z.string() },
  handler: () => Promise.resolve({ ok: true, kind: 'entity_resolution' }),
};

const makeDispatcher = (resources: readonly KernelMcpResource[] = makeKernelMcpResources()) =>
  createMcpHttpDispatcher(() => createKernelMcpServer([uiTool, plainTool], {}, resources));

const rpc = async (
  dispatcher: ReturnType<typeof makeDispatcher>,
  method: string,
  params?: unknown
): Promise<Record<string, unknown>> => {
  const res = await dispatcher.dispatch({
    jsonrpc: '2.0',
    id: 1,
    method,
    ...(params !== undefined ? { params } : {}),
  });
  expect(res?.error).toBeUndefined();
  return res?.result as Record<string, unknown>;
};

describe('kernel MCP Apps surface', () => {
  it('advertises the resources capability only when resources exist', async () => {
    const withResources = await rpc(makeDispatcher(), 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    });
    expect((withResources['capabilities'] as Record<string, unknown>)['resources']).toBeDefined();

    const withoutResources = await rpc(makeDispatcher([]), 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    });
    expect(
      (withoutResources['capabilities'] as Record<string, unknown>)['resources']
    ).toBeUndefined();
  });

  it('publishes widget metadata on the UI tool: standard, legacy, and openai alias keys', async () => {
    const result = await rpc(makeDispatcher(), 'tools/list');
    const tools = result['tools'] as Record<string, unknown>[];

    const search = tools.find((t) => t['name'] === 'search_entities');
    const searchMeta = search?.['_meta'] as Record<string, unknown> | undefined;
    expect(search?.['title']).toBe('Căutare entități');
    expect(searchMeta?.['ui']).toEqual({ resourceUri: ENTITY_SEARCH_WIDGET_URI });
    expect(searchMeta?.['ui/resourceUri']).toBe(ENTITY_SEARCH_WIDGET_URI);
    expect(searchMeta?.['openai/outputTemplate']).toBe(ENTITY_SEARCH_WIDGET_URI);
    // The server is read-only by contract — UI tools must say so to hosts.
    expect(search?.['annotations']).toMatchObject({ readOnlyHint: true, destructiveHint: false });

    const resolve = tools.find((t) => t['name'] === 'resolve_entity');
    expect(resolve?.['_meta']).toBeUndefined();
  });

  it('lists and reads the widget resource with the MCP Apps mimetype', async () => {
    const dispatcher = makeDispatcher();
    const list = await rpc(dispatcher, 'resources/list');
    const resources = list['resources'] as Record<string, unknown>[];
    const widget = resources.find((r) => r['uri'] === ENTITY_SEARCH_WIDGET_URI);
    expect(widget?.['mimeType']).toBe('text/html;profile=mcp-app');
    expect((widget?.['_meta'] as Record<string, unknown> | undefined)?.['ui']).toEqual({
      prefersBorder: false,
    });

    const read = await rpc(dispatcher, 'resources/read', { uri: ENTITY_SEARCH_WIDGET_URI });
    const contents = read['contents'] as { mimeType?: string; text?: string }[];
    expect(contents[0]?.mimeType).toBe('text/html;profile=mcp-app');
    expect(contents[0]?.text).toContain('<!doctype html>');
    // Self-contained: the bundled bridge + view script must be inlined.
    expect(contents[0]?.text).toContain('<script>');
  });

  it('content-hashes the widget URI so a changed bundle changes the cache key', () => {
    expect(ENTITY_SEARCH_WIDGET_URI).toMatch(
      /^ui:\/\/transparenta\/entity-search\.[0-9a-f]{12}\.html$/
    );
  });
});
