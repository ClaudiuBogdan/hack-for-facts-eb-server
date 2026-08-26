/**
 * Shared Kernel — kernel MCP tools (foundation §6.3, §7.4).
 *
 * The kernel ships two tools modules build on:
 *  - `resolve_entity` (shared discovery, §7.4): Romanian name / CUI → org +
 *    territory; the cross-source name→value resolver.
 *  - `get_entity_snapshot` (kernel query): a cross-source entity-360 snapshot.
 *
 * Both return the structured `{ ok, kind, query, link, item, summary }` object.
 * `link` is the client deep link; `clientBaseUrl` is supplied at wiring.
 */

import { z } from 'zod';

import { ENTITY_SEARCH_WIDGET_URI, ENTITY_SNAPSHOT_WIDGET_URI } from './widgets/resources.js';
import { makeEntity360, type Entity360Deps } from '../../core/usecases/entity-360.js';
import { makeGlobalSearch, type GlobalSearchDeps } from '../../core/usecases/global-search.js';

import type { KernelMcpTool, McpToolOutput } from './types.js';
import type { IdentityRepo } from '../../core/ports.js';
import type { SearchHit } from '../../core/types.js';

export interface KernelMcpDeps {
  readonly identityRepo: IdentityRepo;
  readonly entity360Deps: Entity360Deps;
  readonly globalSearchDeps: GlobalSearchDeps;
  readonly clientBaseUrl: string;
}

const entityLink = (base: string, cui: string): string => `${base}/entitati/${cui}`;

/** Read a string arg safely (MCP args are `unknown`). */
const strArg = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  return typeof v === 'string' ? v : '';
};

export const makeKernelMcpTools = (deps: KernelMcpDeps): readonly KernelMcpTool[] => {
  const resolveEntity: KernelMcpTool = {
    name: 'resolve_entity',
    description:
      'Resolve a Romanian organization name or CUI to its canonical identity (org_id, CUI, kind, county) and territory. Use this first to turn a free-text name into a CUI before querying other tools.',
    inputShape: {
      query: z.string().describe('An organization name or CUI/CIF (with or without RO prefix).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const query = strArg(args, 'query');
      const res = await deps.identityRepo.resolve(query);
      if (res.isErr()) return { ok: false, kind: 'entity_resolution', error: res.error.message };
      if (res.value === null) {
        return {
          ok: true,
          kind: 'entity_resolution',
          query,
          summary: `No entity matched "${query}".`,
        };
      }
      const org = res.value.org;
      const territoryRes =
        org.cui !== null ? await deps.identityRepo.territoryForCui(org.cui) : null;
      const territory = territoryRes?.isOk() === true ? territoryRes.value : null;
      return {
        ok: true,
        kind: 'entity_resolution',
        query,
        ...(org.cui !== null && { link: entityLink(deps.clientBaseUrl, org.cui) }),
        item: {
          orgId: org.orgId,
          cui: org.cui,
          name: org.name,
          kind: org.kind,
          countyName: org.countyName,
          confidence: res.value.confidence,
          territory,
        },
        summary: `${org.name} (CUI ${org.cui ?? 'n/a'}, ${org.kind}) — confidence ${res.value.confidence.toFixed(2)}.`,
      };
    },
  };

  const getEntitySnapshot: KernelMcpTool = {
    name: 'get_entity_snapshot',
    title: 'Profil entitate Transparenta.eu',
    ui: { resourceUri: ENTITY_SNAPSHOT_WIDGET_URI },
    description:
      'Cross-source snapshot for an entity by CUI: identity, territory, money-flow summaries (in/out), document count, and per-source presence badges.',
    inputShape: {
      cui: z.string().describe('The entity CUI/CIF.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const cui = strArg(args, 'cui');
      const res = await makeEntity360(deps.entity360Deps, cui);
      if (res.isErr()) return { ok: false, kind: 'entity_snapshot', error: res.error.message };
      const e = res.value;
      const presenceLabels = e.presence.filter((p) => p.present).map((p) => p.label ?? p.source);
      const inCount = String(e.flowsIn.count);
      const outCount = String(e.flowsOut.count);
      const present =
        presenceLabels.length > 0 ? presenceLabels.join(', ') : 'no registered sources';
      return {
        ok: true,
        kind: 'entity_snapshot',
        query: { cui },
        link: entityLink(deps.clientBaseUrl, e.cui),
        item: {
          cui: e.cui,
          organization: e.organization,
          territory: e.territory,
          flowsIn: e.flowsIn,
          flowsOut: e.flowsOut,
          documentCount: e.documentCount,
          presence: e.presence,
        },
        summary:
          e.organization !== null
            ? `${e.organization.name}: ${inCount} inbound flows (${e.flowsIn.totalAmountRon} RON), ${outCount} outbound. Present in: ${present}.`
            : `CUI ${e.cui}: no organization record; ${inCount} inbound, ${outCount} outbound flows.`,
      };
    },
  };

  const searchEntities: KernelMcpTool = {
    name: 'search_entities',
    title: 'Căutare entități Transparenta.eu',
    ui: { resourceUri: ENTITY_SEARCH_WIDGET_URI },
    description:
      'Free-text global search across every quick-searchable identity (companies, public institutions, NGOs, public enterprises, PNRR entities, MPs, bills, committees, legal acts, Monitorul Oficial acts). Returns the merged, relevance-ranked list with a type badge per hit, optionally narrowed by docTypes / roles / county / isActive. One document per identity: use docTypes for what a thing IS and roles for what it PLAYS (a municipality that is also a PNRR beneficiary is one hit carrying both). Use this to FIND entities when you only have a name or keyword; then use resolve_entity / get_entity_snapshot for a specific CUI.',
    inputShape: {
      query: z.string().describe('Free-text query (entity name, keyword, or CUI).'),
      docTypes: z
        .array(z.string())
        .optional()
        .describe('Restrict to these entity doc types (e.g. ["company","legal_act"]).'),
      county: z
        .string()
        .optional()
        .describe('Canonical county name (case-sensitive, e.g. "Cluj").'),
      roles: z
        .array(z.string())
        .optional()
        .describe('Restrict to identities playing these roles (e.g. ["pnrr_entity"]).'),
      isActive: z
        .boolean()
        .optional()
        .describe('Only currently-active entities (half of all companies are struck off).'),
      limit: z.number().int().optional().describe('Max hits to return (default 20, max 50).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const query = strArg(args, 'query');
      const docTypes = Array.isArray(args['docTypes'])
        ? args['docTypes'].filter((t): t is string => typeof t === 'string')
        : undefined;
      const county = typeof args['county'] === 'string' ? args['county'] : undefined;
      const roles = Array.isArray(args['roles'])
        ? args['roles'].filter((r): r is string => typeof r === 'string')
        : undefined;
      const isActive = typeof args['isActive'] === 'boolean' ? args['isActive'] : undefined;
      const limit = typeof args['limit'] === 'number' ? args['limit'] : undefined;

      const res = await makeGlobalSearch(deps.globalSearchDeps, {
        q: query,
        ...(docTypes !== undefined && { docTypes }),
        ...(county !== undefined && { county }),
        ...(roles !== undefined && { roles }),
        ...(isActive !== undefined && { isActive }),
        ...(limit !== undefined && { limit }),
      });
      if (res.isErr()) return { ok: false, kind: 'entity_search', error: res.error.message };

      const { engine, hits, facets, estimatedTotalHits } = res.value;
      // The entities doc carries a small whitelisted `attrs` sub-object (kind,
      // status, group_name, chamber, issuer, …). `SearchHit.attrs` is the WHOLE
      // raw hit (it also holds `visibility`), so expose ONLY the nested
      // whitelisted object — never the raw hit — keeping `visibility` server-side.
      const displayAttrs = (h: SearchHit): Record<string, unknown> | undefined => {
        const nested = h.attrs['attrs'];
        return nested !== null && typeof nested === 'object' && !Array.isArray(nested)
          ? (nested as Record<string, unknown>)
          : undefined;
      };
      const items = hits.map((h: SearchHit) => {
        const attrs = displayAttrs(h);
        return {
          docType: h.docType,
          ...(h.docKey !== undefined && { docKey: h.docKey }),
          ...(h.docId !== undefined && { docId: h.docId }),
          title: h.title,
          ...(h.subtitle !== undefined && { subtitle: h.subtitle }),
          ...(h.countyName !== undefined && { countyName: h.countyName }),
          ...(h.url !== undefined && { url: h.url }),
          ...(h.cuis !== undefined && { cuis: h.cuis }),
          ...(attrs !== undefined && Object.keys(attrs).length > 0 && { attrs }),
        };
      });
      return {
        ok: true,
        kind: 'entity_search',
        query,
        items,
        meta: { engine, estimatedTotalHits, returned: items.length, facets },
        summary:
          items.length === 0
            ? `No entities matched "${query}".`
            : `${String(items.length)} of ~${String(estimatedTotalHits)} matches for "${query}" (engine: ${engine}).`,
      };
    },
  };

  return [resolveEntity, getEntitySnapshot, searchEntities];
};
