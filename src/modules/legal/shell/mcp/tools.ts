/**
 * Legal module — MCP tools (plan §8). Each tool → the SAME usecase the GraphQL
 * resolver calls; output is the kernel `{ ok, kind, query?, link?, item|items?,
 * summary? }` object. Two families: discovery (`resolve_legal_filters`) + query
 * (`get_legal_act`, `search_legal_acts`, `get_legal_act_links`,
 * `get_legal_act_timeline`, `get_legal_node`). Naming is `<verb>_legal_<noun>`.
 *
 * `search_legal_acts` returns citations + grounded snippet + node locator (act +
 * node label + char range + portal deep link) so agent answers are verifiable —
 * WITHOUT claiming to serve full node text (§3.4). It never computes totals beyond
 * graph edge counts it can ground.
 */

import {
  getLegalActInput,
  getLegalActLinksInput,
  getLegalActTimelineInput,
  getLegalNodeInput,
  resolveLegalFiltersInput,
  searchLegalActsInput,
  LEGAL_MCP_KINDS,
} from './io.js';
import {
  getAct,
  getActLinksIn,
  getActLinksOut,
  getActTimeline,
  getActTree,
  resolveLegalFilters,
  searchLegal,
  type LegalSearchDeps,
  type ResolveLegalFiltersDeps,
} from '../../core/usecases.js';

import type { LegalActsRepo, LegalGraphRepo, LegalTreeRepo } from '../../core/ports.js';
import type { LegalActRef } from '../../core/repo-base.js';
import type { LegalRelation, LegalResolveDim } from '../../core/types.js';
import type { FilterInput, KernelMcpTool, McpToolOutput } from '@/modules/shared/index.js';

export interface LegalMcpDeps {
  readonly acts: LegalActsRepo;
  readonly graph: LegalGraphRepo;
  readonly tree: LegalTreeRepo;
  readonly searchDeps: LegalSearchDeps;
  readonly resolveDeps: ResolveLegalFiltersDeps;
  readonly clientBaseUrl: string;
}

const str = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = args[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
};
const intArg = (args: Record<string, unknown>, key: string, dflt: number): number => {
  const v = args[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.floor(n) : dflt;
};
const boolArg = (args: Record<string, unknown>, key: string): boolean => args[key] === true;
const filterArg = (args: Record<string, unknown>): FilterInput => {
  const v = args['filter'];
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as FilterInput) : {};
};
const errorOut = (kind: string, message: string): McpToolOutput => ({ ok: false, kind, error: message });
const n = (x: number): string => String(x);

/** Build the act ref from `actId` or `citation` args. */
const refOf = (args: Record<string, unknown>): LegalActRef | null => {
  const actId = str(args, 'actId');
  const citation = str(args, 'citation');
  if (actId !== undefined) return { actId };
  if (citation !== undefined) return { citation };
  return null;
};

export const makeLegalMcpTools = (deps: LegalMcpDeps): readonly KernelMcpTool[] => {
  const { acts, graph, tree, searchDeps, resolveDeps, clientBaseUrl } = deps;
  const actLink = (actId: string): string => `${clientBaseUrl}/legal/acts/${actId}`;

  const resolveFilters: KernelMcpTool = {
    name: 'resolve_legal_filters',
    description:
      'Resolve a free-text legal query to a filter value: citation → actId, issuer/domain/category/act_type/status name → value. Use before querying other legal tools.',
    inputShape: resolveLegalFiltersInput,
    async handler(args): Promise<McpToolOutput> {
      const dim = str(args, 'dim') as LegalResolveDim | undefined;
      if (dim === undefined) return errorOut(LEGAL_MCP_KINDS.resolve, 'dim is required');
      const q = str(args, 'q') ?? '';
      const res = await resolveLegalFilters(resolveDeps, dim, q, intArg(args, 'limit', 10));
      if (res.isErr()) return errorOut(LEGAL_MCP_KINDS.resolve, res.error.message);
      return {
        ok: true,
        kind: LEGAL_MCP_KINDS.resolve,
        query: { dim, q },
        items: res.value,
        summary: `Found ${n(res.value.length)} match(es) for «${q}» as ${dim}.`,
      };
    },
  };

  const getLegalAct: KernelMcpTool = {
    name: 'get_legal_act',
    description:
      'Get a legal act by numeric actId or free-text citation (e.g. "legea 227/2015", "codul fiscal"): identity, status + evidence, canonical document, AI summary, aliases, and the "modificat de N acte" honesty badge.',
    inputShape: getLegalActInput,
    async handler(args): Promise<McpToolOutput> {
      const ref = refOf(args);
      if (ref === null) return errorOut(LEGAL_MCP_KINDS.actCard, 'actId or citation is required');
      const res = await getAct(acts, ref);
      if (res.isErr()) return errorOut(LEGAL_MCP_KINDS.actCard, res.error.message);
      const card = res.value;
      if (card === null) return { ok: true, kind: LEGAL_MCP_KINDS.actCard, query: ref, summary: 'No matching act.' };
      return {
        ok: true,
        kind: LEGAL_MCP_KINDS.actCard,
        query: ref,
        link: actLink(card.actId),
        item: card,
        summary: `${card.displayCitation} — status: ${card.status}; modificat de ${n(card.amendedAfterPublication)} acte.`,
      };
    },
  };

  const searchLegalActs: KernelMcpTool = {
    name: 'search_legal_acts',
    description:
      'Legal retrieval: identifier router (citation → act), then pgvector semantic search over acts + provisions when the legal semantic gate is on, else a bounded lexical fallback. Returns acts + section hits (citation + article label + grounded snippet + portal deep link). Honours status/domain/category/type/year filters; serves canonical text only. Node TEXT is not served (use the deep link).',
    inputShape: searchLegalActsInput,
    async handler(args): Promise<McpToolOutput> {
      const q = str(args, 'q');
      if (q === undefined) return errorOut(LEGAL_MCP_KINDS.search, 'q is required');
      const channel = (str(args, 'channel') as 'auto' | 'sections' | 'docs' | undefined) ?? 'auto';
      const res = await searchLegal(searchDeps, {
        q,
        filter: filterArg(args),
        channel,
        includeHistorical: boolArg(args, 'includeHistorical'),
        limit: intArg(args, 'limit', 20),
      });
      if (res.isErr()) return errorOut(LEGAL_MCP_KINDS.search, res.error.message);
      const { acts: actHits, sections, caveats } = res.value;
      return {
        ok: true,
        kind: LEGAL_MCP_KINDS.search,
        query: { q, channel },
        link: `${clientBaseUrl}/legal/search?q=${encodeURIComponent(q)}`,
        items: [...actHits],
        item: { acts: actHits, sections, caveats },
        summary:
          `${n(actHits.length)} acte / ${n(sections.length)} secțiuni pentru „${q}".` +
          (caveats.length > 0 ? ` ${caveats.join(' ')}` : ''),
      };
    },
  };

  const getLegalActLinks: KernelMcpTool = {
    name: 'get_legal_act_links',
    description:
      'The citation/amendment graph for an act: direction=in (who cites/amends/abrogates it) or out (what it cites). Optionally filter by relation. Always bounded (hub guard).',
    inputShape: getLegalActLinksInput,
    async handler(args): Promise<McpToolOutput> {
      const ref = refOf(args);
      if (ref === null) return errorOut(LEGAL_MCP_KINDS.links, 'actId or citation is required');
      const actRes = await acts.resolveActRef(ref);
      if (actRes.isErr()) return errorOut(LEGAL_MCP_KINDS.links, actRes.error.message);
      const act = actRes.value;
      if (act === null) return { ok: true, kind: LEGAL_MCP_KINDS.links, query: ref, summary: 'No matching act.' };
      const direction = str(args, 'direction') ?? 'in';
      const relRaw = Array.isArray(args['relation']) ? (args['relation'] as string[]) : undefined;
      const relations = relRaw?.map((r) => r as LegalRelation);
      const limit = intArg(args, 'limit', 50);
      if (direction === 'out') {
        const edges = await getActLinksOut(graph, act.actId, relations, limit);
        if (edges.isErr()) return errorOut(LEGAL_MCP_KINDS.links, edges.error.message);
        return {
          ok: true,
          kind: LEGAL_MCP_KINDS.links,
          query: { ...ref, direction },
          link: `${actLink(act.actId)}/links?direction=out`,
          items: edges.value,
          summary: `${n(edges.value.length)} outgoing reference(s) for ${act.displayCitation}.`,
        };
      }
      const edges = await getActLinksIn(graph, act.actId, relations, limit);
      if (edges.isErr()) return errorOut(LEGAL_MCP_KINDS.links, edges.error.message);
      return {
        ok: true,
        kind: LEGAL_MCP_KINDS.links,
        query: { ...ref, direction },
        link: `${actLink(act.actId)}/links?direction=in`,
        items: edges.value,
        summary: `${n(edges.value.length)} incoming reference(s) for ${act.displayCitation}.`,
      };
    },
  };

  const getLegalActTimeline: KernelMcpTool = {
    name: 'get_legal_act_timeline',
    description:
      'The merged lifecycle of an act: status events (portal + monitorul-oficial) + amendment edges, in chronological order.',
    inputShape: getLegalActTimelineInput,
    async handler(args): Promise<McpToolOutput> {
      const ref = refOf(args);
      if (ref === null) return errorOut(LEGAL_MCP_KINDS.timeline, 'actId or citation is required');
      const actRes = await acts.resolveActRef(ref);
      if (actRes.isErr()) return errorOut(LEGAL_MCP_KINDS.timeline, actRes.error.message);
      const act = actRes.value;
      if (act === null) return { ok: true, kind: LEGAL_MCP_KINDS.timeline, query: ref, summary: 'No matching act.' };
      const res = await getActTimeline(acts, graph, act.actId);
      if (res.isErr()) return errorOut(LEGAL_MCP_KINDS.timeline, res.error.message);
      const events = res.value;
      const first = events[0]?.effectiveDate ?? '—';
      const last = events[events.length - 1]?.effectiveDate ?? '—';
      return {
        ok: true,
        kind: LEGAL_MCP_KINDS.timeline,
        query: ref,
        link: `${actLink(act.actId)}/timeline`,
        items: events,
        summary: `${act.displayCitation}: ${n(events.length)} events from ${first} to ${last}.`,
      };
    },
  };

  const getLegalNode: KernelMcpTool = {
    name: 'get_legal_node',
    description:
      'Locate a structural node (article/paragraph) within an act document: returns label, kind, materialized path, char range, and a portal deep link. Node TEXT is not in the serving DB (use the portal deep link).',
    inputShape: getLegalNodeInput,
    async handler(args): Promise<McpToolOutput> {
      const documentId = str(args, 'documentId');
      const path = str(args, 'path');
      if (documentId === undefined || path === undefined) {
        return errorOut(LEGAL_MCP_KINDS.node, 'documentId and path are required');
      }
      const res = await getActTree(tree, { documentId, path, depth: 1 });
      if (res.isErr()) return errorOut(LEGAL_MCP_KINDS.node, res.error.message);
      return {
        ok: true,
        kind: LEGAL_MCP_KINDS.node,
        query: { documentId, path },
        link: `${clientBaseUrl}/legal/documents/${documentId}?path=${encodeURIComponent(path)}`,
        items: res.value,
        summary: `${n(res.value.length)} child node(s) under ${path}. Node text lives in the portal (deep link).`,
      };
    },
  };

  return [resolveFilters, getLegalAct, searchLegalActs, getLegalActLinks, getLegalActTimeline, getLegalNode];
};
