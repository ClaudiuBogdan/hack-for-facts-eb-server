/**
 * Legal module — MCP tools (plan §8). Each tool → the SAME usecase the GraphQL
 * resolver calls; output is the kernel `{ ok, kind, query?, link?, item|items?,
 * summary? }` object. Two families: discovery (`resolve_legal_filters`) + query
 * (`get_legal_act`, `search_legal_acts`, `get_legal_act_links`,
 * `get_legal_act_timeline`, `get_legal_node`, `count_legal_acts`,
 * `get_legal_recent_changes`). Naming is `<verb>_legal_<noun>`.
 *
 * `search_legal_acts` returns citations + grounded snippet + node locator (act +
 * node label + char range + portal deep link) so agent answers are verifiable —
 * WITHOUT claiming to serve full node text (§3.4). It never computes totals beyond
 * graph edge counts it can ground.
 */

import {
  countLegalActsInput,
  getLegalActInput,
  getLegalActLinksInput,
  getLegalActTimelineInput,
  getLegalNodeInput,
  getLegalRecentChangesInput,
  resolveLegalFiltersInput,
  searchLegalActsInput,
  LEGAL_MCP_KINDS,
} from './io.js';
import {
  LEGAL_ORIGINAL_TEXT_CAVEAT,
  amendmentCountPhrase,
  versionProvenanceNote,
} from '../../core/provenance.js';
import {
  countLegalActs,
  getAct,
  getActLinksIn,
  getActLinksOut,
  getActTimeline,
  getOutlineEntry,
  getRecentChanges,
  resolveLegalFilters,
  searchLegal,
  type LegalSearchDeps,
  type ResolveLegalFiltersDeps,
} from '../../core/usecases.js';

import type { LegalActsRepo, LegalGraphRepo, LegalOutlineRepo } from '../../core/ports.js';
import type { LegalActRef } from '../../core/repo-base.js';
import type {
  LegalCountDimension,
  LegalEventSource,
  LegalRelation,
  LegalResolveDim,
  LegalVersionProvenance,
} from '../../core/types.js';
import type { FilterInput, KernelMcpTool, McpToolOutput } from '@/modules/shared/index.js';

export interface LegalMcpDeps {
  readonly acts: LegalActsRepo;
  readonly graph: LegalGraphRepo;
  readonly outline: LegalOutlineRepo;
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
const errorOut = (kind: string, message: string): McpToolOutput => ({
  ok: false,
  kind,
  error: message,
});
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
  const { acts, graph, outline, searchDeps, resolveDeps, clientBaseUrl } = deps;
  const actLink = (actId: string): string => `${clientBaseUrl}/legal/acts/${actId}`;
  const noteFor = (prov: LegalVersionProvenance | null): string | null =>
    prov === null ? null : versionProvenanceNote(prov);

  /**
   * The provenance envelope every single-item tool returns, so an agent reads
   * the caveats programmatically instead of parsing them out of `summary`
   * (the same contract `search_legal_acts` gives for a result set).
   */
  const provenanceMeta = (
    prov: LegalVersionProvenance | null,
    note: string | null
  ): Record<string, unknown> => ({
    textProvenance: note,
    versionProvenance: prov,
    caveats: note === null ? [LEGAL_ORIGINAL_TEXT_CAVEAT] : [note, LEGAL_ORIGINAL_TEXT_CAVEAT],
  });

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
      if (card === null)
        return { ok: true, kind: LEGAL_MCP_KINDS.actCard, query: ref, summary: 'No matching act.' };
      const provRes = await acts.versionProvenanceForActs([card.actId]);
      if (provRes.isErr()) return errorOut(LEGAL_MCP_KINDS.actCard, provRes.error.message);
      const provenance = provRes.value.get(card.actId) ?? null;
      const note = noteFor(provenance);
      return {
        ok: true,
        kind: LEGAL_MCP_KINDS.actCard,
        query: ref,
        link: actLink(card.actId),
        item: card,
        meta: provenanceMeta(provenance, note),
        summary:
          `${card.displayCitation} — status: ${card.status}; ${amendmentCountPhrase(card.amendedAfterPublication)}.` +
          (note === null ? '' : ` ${note}`),
      };
    },
  };

  const searchLegalActs: KernelMcpTool = {
    name: 'search_legal_acts',
    description:
      'Legal retrieval: identifier router (citation → act), then pgvector semantic search over acts + provisions when the legal semantic gate is on, else a bounded lexical fallback. Returns acts + section hits (citation + article label + grounded snippet + reader deep link). Honours status/domain/category/type/year filters; serves canonical text only.',
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
      // Stamp each hit with its own version note: an agent quoting one act must
      // not have to infer provenance from a set-level caveat.
      const stampedActs = actHits.map((h) => ({
        ...h,
        textProvenance: noteFor(h.provenance),
      }));
      const stampedSections = sections.map((s) => ({
        ...s,
        textProvenance: noteFor(s.provenance),
      }));
      return {
        ok: true,
        kind: LEGAL_MCP_KINDS.search,
        query: { q, channel },
        link: `${clientBaseUrl}/legal/search?q=${encodeURIComponent(q)}`,
        items: stampedActs,
        item: { acts: stampedActs, sections: stampedSections, caveats },
        meta: { caveats },
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
      if (act === null)
        return { ok: true, kind: LEGAL_MCP_KINDS.links, query: ref, summary: 'No matching act.' };
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
      if (act === null)
        return {
          ok: true,
          kind: LEGAL_MCP_KINDS.timeline,
          query: ref,
          summary: 'No matching act.',
        };
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
      'Locate a structural node (article/heading) within an act document by its stable (documentId, path) key: returns label, kind, numbering (with honesty status), char range into the rendered clean text, and a reader deep link.',
    inputShape: getLegalNodeInput,
    async handler(args): Promise<McpToolOutput> {
      const documentId = str(args, 'documentId');
      const path = str(args, 'path');
      if (documentId === undefined || path === undefined) {
        return errorOut(LEGAL_MCP_KINDS.node, 'documentId and path are required');
      }
      const res = await getOutlineEntry(outline, documentId, path);
      if (res.isErr()) return errorOut(LEGAL_MCP_KINDS.node, res.error.message);
      // The node belongs to THIS document, so it is stamped with that document's
      // own version rather than the act's canonical one.
      const provRes = await acts.versionProvenanceForDocument(documentId);
      if (provRes.isErr()) return errorOut(LEGAL_MCP_KINDS.node, provRes.error.message);
      const docLink = `${clientBaseUrl}/legal/documents/${documentId}?nod=${encodeURIComponent(path)}`;
      const provenance = provRes.value;
      const note = noteFor(provenance);
      const items = res.value === null ? [] : [res.value];
      return {
        ok: true,
        kind: LEGAL_MCP_KINDS.node,
        query: { documentId, path },
        link: docLink,
        items,
        meta: provenanceMeta(provenance, note),
        summary:
          (res.value === null
            ? `No outline entry at ${path}.`
            : `${res.value.label ?? res.value.nodeKind} at ${path} (chars ${String(res.value.charStart ?? 0)}–${String(res.value.charEnd ?? 0)}).`) +
          (note === null ? '' : ` ${note}`),
      };
    },
  };

  const countLegalActsTool: KernelMcpTool = {
    name: 'count_legal_acts',
    description:
      'Grouped act counts by domain / act_type / status / issuer / year, with the same optional filter as search_legal_acts — one call for a whole facet grid. Bucket keys are RAW DB values ("fiscal-si-bugetar", "in-vigoare", "2015"); domain/status keys always round-trip into the filter, but act_type is an OPEN vocabulary (256 live values vs the 18 the filter accepts), so most act_type keys are NOT valid filter values. label is a display form when one exists. Partition contract: status/act_type partition the corpus; issuer/year omit acts without a value; domain OVERLAPS — a multi-tag on the canonical summary, an act counts once per domain it carries, so domain buckets sum above the act total. limit caps the served buckets (default 20); a cut list is flagged via meta.bucketsTruncated + meta.otherCount, never silently short.',
    inputShape: countLegalActsInput,
    async handler(args): Promise<McpToolOutput> {
      const dim = str(args, 'groupBy') as LegalCountDimension | undefined;
      if (dim === undefined) return errorOut(LEGAL_MCP_KINDS.counts, 'groupBy is required');
      const filter = filterArg(args);
      const rawLimit = args['limit'];
      const topN = typeof rawLimit === 'number' ? Math.floor(rawLimit) : undefined;
      const res = await countLegalActs(acts, dim, filter, topN);
      if (res.isErr()) return errorOut(LEGAL_MCP_KINDS.counts, res.error.message);
      const { buckets, bucketsTruncated, otherCount } = res.value;
      const top = buckets[0];
      return {
        ok: true,
        kind: LEGAL_MCP_KINDS.counts,
        query: { groupBy: dim, filter, ...(topN !== undefined && { limit: topN }) },
        link: `${clientBaseUrl}/legal`,
        items: buckets,
        meta: { bucketsTruncated, otherCount },
        summary:
          `${n(buckets.length)} ${dim} bucket(s) over the filtered acts` +
          (top !== undefined ? `; top: ${top.key} (${n(top.count)})` : '') +
          (bucketsTruncated
            ? `; truncated — ${n(otherCount)} more across the unserved tail.`
            : '.'),
      };
    },
  };

  const getLegalRecentChanges: KernelMcpTool = {
    name: 'get_legal_recent_changes',
    description:
      'The global date-ordered status-event feed ("Modificări"): each entry is one act_status_events row (kind, effective date, source portal|monitorul-oficial, evidence, acting act) plus the affected act identity. Ordered by EFFECTIVE date, so the unfiltered feed LEADS with future-dated, not-yet-in-force events — pass until = today for "what already changed". since/until are inclusive YYYY-MM-DD bounds; 25.2% of events have NO effective_date and are reachable only via undatedOnly, never via a window. Keyset-paged via meta.next with the SAME filters.',
    inputShape: getLegalRecentChangesInput,
    async handler(args): Promise<McpToolOutput> {
      const since = str(args, 'since');
      const until = str(args, 'until');
      const kinds = Array.isArray(args['kinds']) ? (args['kinds'] as string[]) : undefined;
      const eventSource = str(args, 'eventSource');
      const undatedOnly = boolArg(args, 'undatedOnly');
      const after = str(args, 'after');
      const res = await getRecentChanges(acts, {
        ...(since !== undefined && { since }),
        ...(until !== undefined && { until }),
        ...(kinds !== undefined && { kinds }),
        // Cast only: membership is validated by the usecase normalizer.
        ...(eventSource !== undefined && { eventSource: eventSource as LegalEventSource }),
        ...(undatedOnly && { undatedOnly }),
        page: { first: intArg(args, 'limit', 20), ...(after !== undefined && { after }) },
      });
      if (res.isErr()) return errorOut(LEGAL_MCP_KINDS.changes, res.error.message);
      const { items, next } = res.value;
      const newest = items[0]?.effectiveDate ?? '—';
      const oldest = items[items.length - 1]?.effectiveDate ?? '—';
      return {
        ok: true,
        kind: LEGAL_MCP_KINDS.changes,
        query: { since, until, kinds, eventSource, undatedOnly },
        link: `${clientBaseUrl}/legal`,
        items,
        meta: { next },
        summary:
          items.length === 0
            ? 'No status events match.'
            : `${n(items.length)} status event(s), ${newest} → ${oldest} (newest first).` +
              (next === null ? '' : ' More available via meta.next.'),
      };
    },
  };

  return [
    resolveFilters,
    getLegalAct,
    searchLegalActs,
    getLegalActLinks,
    getLegalActTimeline,
    getLegalNode,
    countLegalActsTool,
    getLegalRecentChanges,
  ];
};
