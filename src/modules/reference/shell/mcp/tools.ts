/**
 * Reference module — MCP tools (plan §8). Each tool → the SAME usecase the GraphQL
 * resolver calls; output is the kernel `{ ok, kind, query?, link?, item|items,
 * summary? }` object. `field_trace` is NEVER returned (the list/detail usecases
 * feed the CARD shape to MCP). Tool naming `<verb>_reference_<noun>`. Query tools
 * accept `after` so agents can paginate, and echo the matched/total denominator.
 */

import { z } from 'zod';

import { REFERENCE_RESOLVE_DIMS, type ReferenceResolveDim } from '../../core/types.js';
import {
  getPublicEntity,
  getTerritory,
  listPublicEntities,
  listTerritories,
  resolveReference,
  type ReferenceDeps,
} from '../../core/usecases.js';

import type { FilterInput, KernelMcpTool, McpToolOutput } from '@/modules/shared/index.js';

export interface ReferenceMcpDeps extends ReferenceDeps {
  readonly clientBaseUrl: string;
}

const strArg = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  return typeof v === 'string' ? v : '';
};

const filterArg = (args: Record<string, unknown>): FilterInput => {
  const v = args['filter'];
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as FilterInput) : {};
};

const intArg = (args: Record<string, unknown>, key: string, dflt: number): number => {
  const v = args[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.floor(n) : dflt;
};

const pageArg = (
  args: Record<string, unknown>,
  dfltFirst: number
): { first: number; after?: string; sort?: string } => {
  const after = strArg(args, 'after');
  const sort = strArg(args, 'sort');
  return {
    first: intArg(args, 'limit', dfltFirst),
    ...(after !== '' && { after }),
    ...(sort !== '' && { sort }),
  };
};

const errorOut = (kind: string, message: string): McpToolOutput => ({
  ok: false,
  kind,
  error: message,
});
const n = (x: number): string => String(x);

export const makeReferenceMcpTools = (deps: ReferenceMcpDeps): readonly KernelMcpTool[] => {
  const { clientBaseUrl } = deps;
  const entityLink = (cui: string): string => `${clientBaseUrl}/entitati/${cui}`;
  const territoryLink = (siruta: string): string => `${clientBaseUrl}/teritorii/${siruta}`;

  const resolveFilter: KernelMcpTool = {
    name: 'resolve_reference_filter',
    description:
      'Resolve a free-text query to a filter value before querying other tools: public_entity (institution name → CUI), territory (locality/UAT name → SIRUTA), classification (CAEN label/code → code), organization (company name/CUI → CUI).',
    inputShape: {
      dim: z
        .enum(['public_entity', 'territory', 'classification', 'organization'])
        .describe('Which dimension to resolve.'),
      q: z.string().describe('The free-text query (name, label, or code).'),
      limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 10).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const dim = strArg(args, 'dim') as ReferenceResolveDim;
      if (!REFERENCE_RESOLVE_DIMS.includes(dim))
        return errorOut('resolution', `unknown dim '${dim}'`);
      const q = strArg(args, 'q');
      const res = await resolveReference(deps, dim, q, intArg(args, 'limit', 10));
      if (res.isErr()) return errorOut('resolution', res.error.message);
      const top = res.value[0];
      return {
        ok: true,
        kind: 'resolution',
        query: { dim, q },
        items: res.value,
        summary:
          `Resolved «${q}» → ${n(res.value.length)} ${dim} match(es)` +
          (top !== undefined ? `; top: ${top.label} (${top.value}).` : '.'),
      };
    },
  };

  const getPublicEntityTool: KernelMcpTool = {
    name: 'get_reference_public_entity',
    description:
      'Public-entity registry card by CUI: name, type/category, UAT flag, territory (county/region/population), parent creditors, default report type. No PII / no debug provenance.',
    inputShape: {
      cui: z.string().describe('The entity CUI/CIF (digits only).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const cui = strArg(args, 'cui');
      // includeTrace:false → the detail usecase returns the card enriched with territory; field_trace stays null.
      const res = await getPublicEntity(deps, cui, false);
      if (res.isErr()) return errorOut('public_entity', res.error.message);
      const e = res.value;
      if (e === null)
        return {
          ok: true,
          kind: 'public_entity',
          query: { cui },
          summary: `No public entity for CUI ${cui}.`,
        };
      const county = e.territory?.countyName ?? null;
      return {
        ok: true,
        kind: 'public_entity',
        query: { cui },
        link: entityLink(cui),
        // Strip field_trace defensively even though the card path leaves it null.
        item: { ...e, fieldTrace: undefined },
        summary:
          `${e.name} — ${e.entityType ?? 'public entity'}${county !== null ? `, ${county}` : ''}` +
          (e.isUat ? ' (UAT)' : '') +
          (e.defaultReportType !== null ? `; default report ${e.defaultReportType}.` : '.'),
      };
    },
  };

  const searchPublicEntities: KernelMcpTool = {
    name: 'search_reference_public_entities',
    description:
      'List/filter the public-entity registry (15,002 entities). Filter by name, entityType, category, isUat, county/region, tags, parentCui, hasIssues. Returns a page + the matched total. Paginate with `after`.',
    inputShape: {
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'A ReferencePublicEntity filter object (e.g. { region: { eq: "Nord-Vest" }, isUat: { eq: true } }).'
        ),
      limit: z.number().int().min(1).max(100).optional().describe('Page size (default 20).'),
      after: z.string().optional().describe('Cursor from a previous page.'),
      sort: z
        .enum(['name', 'cui', 'entity_type', 'updated_at'])
        .optional()
        .describe('Sort field (default name).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const filter = filterArg(args);
      const res = await listPublicEntities(deps, filter, pageArg(args, 20));
      if (res.isErr()) return errorOut('public_entity_list', res.error.message);
      const page = res.value;
      return {
        ok: true,
        kind: 'public_entity_list',
        query: { filter, ...(page.next !== null && { nextCursor: page.next }) },
        link: `${clientBaseUrl}/entitati`,
        items: page.items,
        summary: `${n(page.totalCount)} of 15,002 public entities match; showing ${n(page.items.length)}${page.next !== null ? ' (more available)' : ''}.`,
      };
    },
  };

  const getTerritoryTool: KernelMcpTool = {
    name: 'get_reference_territory',
    description:
      'Territory/UAT detail by surrogate id OR territorial SIRUTA: name, county, development region, population.',
    inputShape: {
      id: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Surrogate territory id (or a "siruta:CODE" string).'),
      siruta: z.string().optional().describe('The territorial SIRUTA code.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const idRaw = args['id'];
      const id = typeof idRaw === 'number' || typeof idRaw === 'string' ? idRaw : null;
      const siruta = strArg(args, 'siruta');
      const res = await getTerritory(deps, { id, siruta: siruta === '' ? null : siruta });
      if (res.isErr()) return errorOut('territory', res.error.message);
      const t = res.value;
      if (t === null)
        return {
          ok: true,
          kind: 'territory',
          query: { id, siruta },
          summary: 'No territory matched.',
        };
      return {
        ok: true,
        kind: 'territory',
        query: { id, siruta },
        ...(t.territorialSirutaCode !== null && { link: territoryLink(t.territorialSirutaCode) }),
        item: t,
        summary:
          `${t.name}${t.countyName !== null ? `, ${t.countyName}` : ''}` +
          (t.region !== null ? ` (${t.region})` : '') +
          (t.population !== null ? `; population ${n(t.population)}.` : '.'),
      };
    },
  };

  const listUats: KernelMcpTool = {
    name: 'list_reference_uats',
    description:
      'List UATs (administrative-territorial units) with filters (county/region/name/population range). Forces isUat=true; use get_reference_territory for a single non-UAT locality. Paginate with `after`.',
    inputShape: {
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('A ReferenceTerritory filter object (e.g. { region: { eq: "Centru" } }).'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size (default 20).'),
      after: z.string().optional().describe('Cursor from a previous page.'),
      sort: z
        .enum(['name', 'population', 'county_code'])
        .optional()
        .describe('Sort field (default name).'),
    },
    async handler(args): Promise<McpToolOutput> {
      // Force isUat=true so the tool name matches the result (review S2).
      const filter: FilterInput = { ...filterArg(args), isUat: { eq: true } };
      const res = await listTerritories(deps, filter, pageArg(args, 20));
      if (res.isErr()) return errorOut('territory_list', res.error.message);
      const page = res.value;
      return {
        ok: true,
        kind: 'territory_list',
        query: { filter, ...(page.next !== null && { nextCursor: page.next }) },
        link: `${clientBaseUrl}/teritorii`,
        items: page.items,
        summary: `${n(page.totalCount)} UAT(s) match; showing ${n(page.items.length)}${page.next !== null ? ' (more available)' : ''}.`,
      };
    },
  };

  const resolveClassification: KernelMcpTool = {
    name: 'resolve_reference_classification',
    description:
      'Resolve a CAEN label or code fragment to classification codes (optionally scoped to a system: caen_rev1|caen_rev2|caen_rev3).',
    inputShape: {
      system: z
        .enum(['caen_rev1', 'caen_rev2', 'caen_rev3'])
        .optional()
        .describe('Restrict to one CAEN system.'),
      q: z.string().describe('A CAEN label or code fragment.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 10).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const system = strArg(args, 'system');
      const q = strArg(args, 'q');
      const res = await deps.classification.resolve(
        system === '' ? null : system,
        q,
        intArg(args, 'limit', 10)
      );
      if (res.isErr()) return errorOut('classification_list', res.error.message);
      const top = res.value[0];
      return {
        ok: true,
        kind: 'classification_list',
        query: { system, q },
        link: `${clientBaseUrl}/clasificari/caen`,
        items: res.value,
        summary:
          `CAEN matches for «${q}»: ${n(res.value.length)}` +
          (top !== undefined ? `; top ${top.value} — ${top.label}.` : '.'),
      };
    },
  };

  return [
    resolveFilter,
    getPublicEntityTool,
    searchPublicEntities,
    getTerritoryTool,
    listUats,
    resolveClassification,
  ];
};
