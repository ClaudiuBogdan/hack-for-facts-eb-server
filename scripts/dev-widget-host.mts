/**
 * Widget dev server — a tiny CORS-open MCP endpoint with FIXTURE data, for
 * rendering the MCP App widgets in a local host without a database.
 *
 * Loop:  pnpm widgets:build  →  restart this (or run under `tsx watch`)  →
 * render in the ext-apps basic-host or MCP Inspector:
 *
 *   npx -y @modelcontextprotocol/inspector@latest      # Apps tab
 *   # or: SERVERS='["http://localhost:3999/mcp"]' npm start   (ext-apps/examples/basic-host)
 *
 * Fixture-only by design: no DB, no search engine, safe to run anywhere.
 */

import { createServer } from 'node:http';

import { z } from 'zod';

import { createMcpHttpDispatcher } from '../src/modules/shared/shell/mcp/http-dispatch.js';
import { createKernelMcpServer } from '../src/modules/shared/shell/mcp/server.js';
import {
  ENTITY_SEARCH_WIDGET_URI,
  makeKernelMcpResources,
} from '../src/modules/shared/shell/mcp/widgets/resources.js';

import type { KernelMcpTool } from '../src/modules/shared/shell/mcp/types.js';

const PORT = Number(process.env['PORT'] ?? 3999);

const FIXTURE_HITS = [
  {
    docType: 'organization',
    docKey: 'org:4305857',
    title: 'MUNICIPIUL CLUJ-NAPOCA',
    subtitle: 'Unitate administrativ-teritorială',
    countyName: 'Cluj',
    url: '/entitati/4305857',
    cuis: ['4305857'],
    attrs: { kind: 'uat', status: 'active' },
  },
  {
    docType: 'company',
    docKey: 'co:24102657',
    title: 'CLUJ INNOVATION PARK SA',
    subtitle: 'Administrarea imobilelor pe bază de comision sau contract',
    countyName: 'Cluj',
    url: '/entitati/24102657',
    cuis: ['24102657'],
    attrs: { kind: 'company', status: 'inactive' },
  },
  {
    docType: 'ngo',
    docKey: 'ngo:14545350',
    title: 'ASOCIAȚIA CLUSTER MOBILIER TRANSILVAN',
    countyName: 'Cluj',
    url: '/entitati/14545350',
    cuis: ['14545350'],
    attrs: { kind: 'ngo', status: 'active' },
  },
  {
    docType: 'legal_act',
    docId: 'ha-cj-2024-112',
    title: 'Hotărârea nr. 112/2024 privind bugetul local',
    subtitle: 'Consiliul Local Cluj-Napoca',
    url: '/legislatie/ha-cj-2024-112',
    attrs: { issuer: 'Consiliul Local Cluj-Napoca' },
  },
] as const;

const searchTool: KernelMcpTool = {
  name: 'search_entities',
  title: 'Căutare entități Transparenta.eu',
  ui: { resourceUri: ENTITY_SEARCH_WIDGET_URI },
  description: 'Fixture search over a handful of Cluj entities (dev widget host).',
  inputShape: { query: z.string().describe('Free-text query.') },
  handler: (args) => {
    const query = typeof args['query'] === 'string' ? args['query'] : '';
    return Promise.resolve({
      ok: true,
      kind: 'entity_search',
      query,
      items: [...FIXTURE_HITS],
      meta: {
        engine: 'fixture',
        degraded: false,
        estimatedTotalHits: FIXTURE_HITS.length,
        returned: FIXTURE_HITS.length,
      },
      summary: `${String(FIXTURE_HITS.length)} of ~${String(FIXTURE_HITS.length)} matches for "${query}" (engine: fixture).`,
    });
  },
};

const dispatcher = createMcpHttpDispatcher(() =>
  createKernelMcpServer([searchTool], { name: 'Transparenta Widget Dev' }, [
    ...makeKernelMcpResources(),
  ])
);

const server = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, mcp-protocol-version, mcp-session-id');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end();
    return;
  }
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    void (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- dev fixture endpoint: malformed JSON falls through to the -32700 reply below
        const response = await dispatcher.dispatch(JSON.parse(body));
        if (response === null) {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
      } catch {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      }
    })();
  });
});

server.listen(PORT, () => {
  console.log(`widget dev MCP endpoint: http://localhost:${String(PORT)}/mcp (fixtures only)`);
});
