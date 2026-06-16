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

import { makeEntity360, type Entity360Deps } from '../../core/usecases/entity-360.js';

import type { KernelMcpTool, McpToolOutput } from './types.js';
import type { IdentityRepo } from '../../core/ports.js';

export interface KernelMcpDeps {
  readonly identityRepo: IdentityRepo;
  readonly entity360Deps: Entity360Deps;
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
        return { ok: true, kind: 'entity_resolution', query, summary: `No entity matched "${query}".` };
      }
      const org = res.value.org;
      const territoryRes = org.cui !== null ? await deps.identityRepo.territoryForCui(org.cui) : null;
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
      const present = presenceLabels.length > 0 ? presenceLabels.join(', ') : 'no registered sources';
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

  return [resolveEntity, getEntitySnapshot];
};
