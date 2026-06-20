/**
 * Parliament module — MCP tools (plan 04 §8). Each tool calls the SAME usecase the
 * GraphQL resolver does (tri-surface equivalence, §14.7); output is the kernel
 * `{ ok, kind, query?, link?, item|items?, summary? }` object. Bounded sizes;
 * NEVER emits excluded columns (§2.6). Naming `<verb>_parliament_<noun>`.
 */

import {
  getParliamentLawLineageInput,
  getParliamentMemberActivityInput,
  PARLIAMENT_MCP_KINDS,
  rankParliamentVoteCohesionInput,
  resolveParliamentFiltersInput,
} from './io.js';
import {
  getLineageForAct,
  getMemberActivityBundle,
  rankVoteCohesion,
  resolveFilters,
  type ParliamentUsecaseDeps,
} from '../../core/usecases.js';

import type { MemberActivityKind, ParliamentResolveDim } from '../../core/types.js';
import type { KernelMcpTool, McpToolOutput } from '@/modules/shared/index.js';

export interface ParliamentMcpDeps extends ParliamentUsecaseDeps {
  readonly clientBaseUrl: string;
}

const strArg = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = args[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
};
const intArg = (args: Record<string, unknown>, key: string, dflt: number): number => {
  const v = args[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.floor(n) : dflt;
};
const boolArg = (args: Record<string, unknown>, key: string): boolean => args[key] === true;
const errorOut = (kind: string, message: string): McpToolOutput => ({ ok: false, kind, error: message });
const n = (x: number): string => String(x);

export const makeParliamentMcpTools = (deps: ParliamentMcpDeps): readonly KernelMcpTool[] => {
  const { clientBaseUrl } = deps;

  const resolveTool: KernelMcpTool = {
    name: 'resolve_parliament_filters',
    description:
      'Resolve a free-text parliament query to a filter value: group name → group, person name → person_id, county → constituency, ministry → recipient, or a label → enum (control_type/outcome/chamber). Use BEFORE the other parliament tools (Entity Resolution Gate).',
    inputShape: resolveParliamentFiltersInput,
    async handler(args): Promise<McpToolOutput> {
      const dim = strArg(args, 'dim') as ParliamentResolveDim | undefined;
      if (dim === undefined) return errorOut(PARLIAMENT_MCP_KINDS.resolve, 'dim is required');
      const q = strArg(args, 'q') ?? '';
      const res = await resolveFilters(deps, dim, q, strArg(args, 'legislature'), intArg(args, 'limit', 10));
      if (res.isErr()) return errorOut(PARLIAMENT_MCP_KINDS.resolve, res.error.message);
      const top = res.value[0];
      return {
        ok: true,
        kind: PARLIAMENT_MCP_KINDS.resolve,
        query: { dim, q },
        items: res.value,
        summary:
          top !== undefined
            ? `Resolved "${q}" → ${top.value} (${top.label}); ${n(res.value.length)} match(es) as ${dim}.`
            : `No ${dim} match for "${q}".`,
      };
    },
  };

  const lineageTool: KernelMcpTool = {
    name: 'get_parliament_law_lineage',
    description:
      'The marquee query: given a legal act_id, return the bills that became it and the final adoption/rejection votes (with tally + person-resolution). Resolve a citation → act_id FIRST via the legal resolve_legal_filters tool (dim=act).',
    inputShape: getParliamentLawLineageInput,
    async handler(args): Promise<McpToolOutput> {
      const actId = strArg(args, 'actId');
      if (actId === undefined) return errorOut(PARLIAMENT_MCP_KINDS.lineage, 'actId is required (resolve a citation via the legal tools first)');
      const roles = Array.isArray(args['roles']) ? (args['roles'] as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;
      const res = await getLineageForAct(deps, {
        actId,
        ...(roles !== undefined && { roles }),
        includeBallots: boolArg(args, 'includeBallots'),
      });
      if (res.isErr()) return errorOut(PARLIAMENT_MCP_KINDS.lineage, res.error.message);
      const lineage = res.value;
      if (lineage === null) {
        return { ok: true, kind: PARLIAMENT_MCP_KINDS.lineage, query: { actId }, summary: `No parliamentary lineage for act ${actId}.` };
      }
      const finalVote = lineage.votes.find((v) => v.role === 'final_adoption') ?? lineage.votes[0];
      const summaryParts: string[] = [];
      if (lineage.bills[0] !== undefined) {
        summaryParts.push(`Act ${actId} came from bill ${lineage.bills[0].billKey}`);
      }
      if (finalVote !== undefined) {
        const t = finalVote.tally;
        summaryParts.push(
          `${finalVote.role} vote ${finalVote.voteDate ?? '?'} (${finalVote.chamber}): ${n(t.pentru ?? 0)} for / ${n(t.abtinere ?? 0)} abținere / ${n(t.nuAVotat ?? 0)} absent` +
            (finalVote.ballotsResolved !== null ? `; ${n(finalVote.ballotsResolved)} ballots person-resolved` : '')
        );
      }
      return {
        ok: true,
        kind: PARLIAMENT_MCP_KINDS.lineage,
        query: { actId },
        link: `${clientBaseUrl}/parlament/lineage/acts/${actId}`,
        item: lineage,
        summary: (summaryParts.length > 0 ? summaryParts.join('; ') : `Lineage for act ${actId}.`) + (lineage.caveats.length > 0 ? ` (${lineage.caveats.join(' ')})` : ''),
      };
    },
  };

  const activityTool: KernelMcpTool = {
    name: 'get_parliament_member_activity',
    description:
      'A member or person activity bundle: recent votes, control items (questions/interpellations), speeches, and initiatives. With personId it fans across ALL the person mandates. Excludes quarantined speeches and all PII (§privacy).',
    inputShape: getParliamentMemberActivityInput,
    async handler(args): Promise<McpToolOutput> {
      const mandateKey = strArg(args, 'mandateKey');
      const personId = strArg(args, 'personId');
      if (mandateKey === undefined && personId === undefined) {
        return errorOut(PARLIAMENT_MCP_KINDS.memberActivity, 'one of mandateKey or personId is required');
      }
      const kinds = Array.isArray(args['kinds'])
        ? (args['kinds'] as unknown[]).filter((x): x is MemberActivityKind => typeof x === 'string' && ['votes', 'control', 'speeches', 'initiatives'].includes(x))
        : undefined;
      const res = await getMemberActivityBundle(deps, {
        ...(mandateKey !== undefined && { mandateKey }),
        ...(personId !== undefined && { personId }),
        ...(kinds !== undefined && { kinds }),
        limit: intArg(args, 'limit', 20),
      });
      if (res.isErr()) return errorOut(PARLIAMENT_MCP_KINDS.memberActivity, res.error.message);
      const bundle = res.value;
      if (bundle === null) {
        return { ok: true, kind: PARLIAMENT_MCP_KINDS.memberActivity, query: { mandateKey, personId }, summary: 'No such member/person.' };
      }
      const name = bundle.member?.fullName ?? bundle.person?.canonicalName ?? mandateKey ?? personId ?? '';
      const linkKey = mandateKey ?? bundle.member?.mandateKey ?? '';
      return {
        ok: true,
        kind: PARLIAMENT_MCP_KINDS.memberActivity,
        query: { mandateKey, personId },
        link: `${clientBaseUrl}/parlament/membri/${linkKey}`,
        item: bundle,
        summary: `${name}: ${n(bundle.votes.length)} votes, ${n(bundle.control.length)} control items, ${n(bundle.speeches.length)} speeches, ${n(bundle.initiatives.length)} initiatives (sampled).`,
      };
    },
  };

  const cohesionTool: KernelMcpTool = {
    name: 'rank_parliament_vote_cohesion',
    description:
      'Party cohesion over a bounded vote set: pass a billKey, OR a chamber + from + to date window (hard cap 500 votes). Returns per-group for/against/abstain/absent percentages and a Rice cohesion index.',
    inputShape: rankParliamentVoteCohesionInput,
    async handler(args): Promise<McpToolOutput> {
      const billKey = strArg(args, 'billKey');
      const chamber = strArg(args, 'chamber');
      const from = strArg(args, 'from');
      const to = strArg(args, 'to');
      const group = strArg(args, 'group');
      const res = await rankVoteCohesion(deps, {
        ...(billKey !== undefined && { billKey }),
        ...(chamber !== undefined && { chamber }),
        ...(from !== undefined && { from }),
        ...(to !== undefined && { to }),
        ...(group !== undefined && { group }),
      });
      if (res.isErr()) return errorOut(PARLIAMENT_MCP_KINDS.cohesion, res.error.message);
      // cohesionIndex is null for groups with no decided votes (M13) — rank those last.
      const top = [...res.value].sort((a, b) => (b.cohesionIndex ?? -1) - (a.cohesionIndex ?? -1))[0];
      const topIndex = top?.cohesionIndex;
      return {
        ok: true,
        kind: PARLIAMENT_MCP_KINDS.cohesion,
        // echo all inputs incl. `group` (was dropped) so the provenance matches the call.
        query: { billKey, chamber, from, to, ...(group !== undefined && { group }) },
        link: `${clientBaseUrl}/parlament/coeziune`,
        items: res.value,
        summary:
          `${n(res.value.length)} group(s)` +
          (top !== undefined
            ? `; most cohesive ${top.groupName} (index ${topIndex !== null && topIndex !== undefined ? topIndex.toFixed(3) : 'n/a'}, ${n(top.voteCount)} votes).`
            : '.'),
      };
    },
  };

  return [resolveTool, lineageTool, activityTool, cohesionTool];
};
