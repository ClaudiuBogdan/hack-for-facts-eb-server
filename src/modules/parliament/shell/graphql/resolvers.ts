/**
 * Parliament module — GraphQL resolvers (plan 04 §6). Thin: parse args → call the
 * SAME usecase MCP calls (tri-surface equivalence, §14.7). `ApiError` →
 * `GraphQLError` with `extensions.code`. Cursor pages → Relay connections;
 * member/bill lists are offset pages with a bounded total.
 *
 * The bill↔legal edge `ParliamentBillActLink.legalAct` resolves via the
 * KERNEL-injected `LegalActByIdLoader` (§6.7) — parliament never reads `legal.*`.
 * A dangling `targetActId` resolves to null cleanly (the loader tolerates it).
 *
 * The `data-quality` person-candidates field is API-key gated at the resolver
 * boundary (§2.6): a request without the kernel `x-api-key` is rejected.
 */

import { GraphQLError } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  buildNextCursor,
  fhashFor,
  filterHash,
  type ApiError,
  type CursorPage,
  type FilterInput,
  type LegalActByIdLoader,
} from '@/modules/shared/index.js';

import {
  dataQualityCandidates,
  getBillDossier,
  getLineageForAct,
  getMember,
  getMemberControlItems,
  getMemberInitiatives,
  getMemberSpeeches,
  getMemberVotes,
  getPersonCareer,
  getVoteBallots,
  getVoteDetail,
  listBills,
  listControlItems,
  listGroups,
  listMembers,
  listVotes,
  rankVoteCohesion,
  resolveFilters,
  type ParliamentUsecaseDeps,
} from '../../core/usecases.js';
import { controlItemsFilterSpec, votesFilterSpec } from '../filters/specs.js';


import type {
  ParliamentBallot,
  ParliamentMemberVote,
  ParliamentResolveDim,
  ParliamentVote,
} from '../../core/types.js';
import type { Result } from 'neverthrow';

export interface ParliamentResolverDeps extends ParliamentUsecaseDeps {
  /** Kernel cross-link loader (registered by the legal module). May be undefined if legal is disabled. */
  readonly legalActLoader: LegalActByIdLoader | undefined;
  /** True when an aux search engine is available (relaxes the votes q-only bound). */
  readonly searchEngineUp: boolean;
  /** Guard: is this request API-key authorized? (data-quality surface, §2.6). */
  readonly isApiKeyAuthorized: (context: unknown) => boolean;
}

const toGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, { extensions: { code: GRAPHQL_ERROR_CODE[error.type], type: error.type } });

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) throw toGraphqlError(result.error);
  return result.value;
};

const clampFirst = (first: number | undefined, max: number): number =>
  Math.min(Math.max(first ?? 20, 1), max);

export const makeParliamentResolvers = (deps: ParliamentResolverDeps): Record<string, unknown> => {
  const { legalActLoader } = deps;

  const voteConnection = (
    page: CursorPage<ParliamentVote>,
    sort: string,
    dir: 'asc' | 'desc',
    fhash: string
  ) => ({
    edges: page.items.map((node) => ({
      node,
      // Per-edge cursor keys MUST match the repo's keyset shape for the sort:
      // voteKey-sort → [voteKey]; voteDate-sort → [voteDate, voteKey].
      cursor: buildNextCursor({
        sort,
        dir,
        fhash,
        lastKeys: sort === 'voteKey' ? [node.voteKey] : [node.voteDate ?? '', node.voteKey],
      }),
    })),
    pageInfo: {
      hasNextPage: page.next !== null,
      endCursor: page.next,
    },
  });

  const ballotConnection = (page: CursorPage<ParliamentBallot>, voteKey: string) => {
    const fhash = filterHash(`ballots:${voteKey}`);
    return {
      edges: page.items.map((node) => ({
        node,
        cursor: buildNextCursor({ sort: 'rowIndex', dir: 'asc', fhash, lastKeys: [node.rowIndex] }),
      })),
      pageInfo: { hasNextPage: page.next !== null, endCursor: page.next },
    };
  };

  const memberVoteConnection = (
    page: CursorPage<ParliamentMemberVote> & { total: number },
    mandateKey: string
  ) => {
    const fhash = filterHash(`memberVotes:${mandateKey}`);
    return {
      edges: page.items.map((node) => ({
        node,
        cursor: buildNextCursor({ sort: 'memberVote', dir: 'desc', fhash, lastKeys: [node.voteDate ?? '', node.voteKey, node.rowIndex] }),
      })),
      pageInfo: { hasNextPage: page.next !== null, endCursor: page.next },
      total: page.total,
    };
  };

  return {
    Query: {
      parliamentMembers: async (
        _r: unknown,
        args: { filter?: FilterInput; page?: number; pageSize?: number }
      ) => {
        const res = unwrap(
          await listMembers(deps, { filter: args.filter ?? {}, sort: 'name', page: { ...(args.page !== undefined && { page: args.page }), ...(args.pageSize !== undefined && { pageSize: args.pageSize }) } })
        );
        return { members: res.rows, total: res.total, totalEstimated: res.estimated };
      },

      parliamentMember: async (_r: unknown, args: { mandateKey: string }) => {
        const detail = unwrap(await getMember(deps, args.mandateKey));
        if (detail === null) return null;
        // Flatten the detail into a ParliamentMember; the eager pieces (person /
        // groupIntervals / activityCounts) are read by the field resolvers below.
        return { ...detail.member, person: detail.person, groupIntervals: detail.groupIntervals, activityCounts: detail.activityCounts };
      },

      parliamentPerson: async (_r: unknown, args: { personId: string }) => {
        const career = unwrap(await getPersonCareer(deps, args.personId));
        if (career === null) return null;
        // Flatten the career into a ParliamentPerson; mandates / groupIntervals /
        // careerTotals are carried so the field resolvers don't refetch.
        return { ...career.person, mandates: career.mandates, groupIntervals: career.groupIntervals, careerTotals: career.careerTotals };
      },

      parliamentGroups: async (_r: unknown, args: { legislature?: string; chamber?: string }) =>
        unwrap(await listGroups(deps, args.legislature, args.chamber)),

      parliamentGroupMembers: async (_r: unknown, args: { groupId: string; legislature?: string }) =>
        unwrap(await deps.repo.listGroupMembers(args.groupId, args.legislature)),

      parliamentBills: async (
        _r: unknown,
        args: { filter?: FilterInput; sort?: string; page?: number; pageSize?: number }
      ) => {
        const res = unwrap(
          await listBills(deps, { filter: args.filter ?? {}, sort: args.sort ?? 'updated_desc', page: { ...(args.page !== undefined && { page: args.page }), ...(args.pageSize !== undefined && { pageSize: args.pageSize }) } })
        );
        return { bills: res.rows, total: res.total, totalEstimated: res.estimated };
      },

      parliamentBill: async (_r: unknown, args: { billKey: string }) => {
        const dossier = unwrap(await getBillDossier(deps, args.billKey));
        if (dossier === null) return null;
        // Flatten the dossier into a ParliamentBill; the eager dossier pieces
        // (events / documents / initiators / relatedVotes / actLinks / voteLinks)
        // are read by the ParliamentBill field resolvers below.
        return {
          ...dossier.bill,
          events: dossier.events,
          documents: dossier.documents,
          initiators: dossier.initiators,
          relatedVotes: dossier.relatedVotes,
          actLinks: dossier.actLinks,
          voteLinks: dossier.voteLinks,
        };
      },

      parliamentVotes: async (
        _r: unknown,
        args: { filter?: Record<string, unknown>; sort?: string; first?: number; after?: string }
      ) => {
        const sort = args.sort === 'voteKey' ? 'voteKey' : 'voteDate';
        const dir = 'desc' as const;
        const filter = (args.filter ?? {}) as FilterInput;
        const page = { first: clampFirst(args.first, 100), ...(args.after !== undefined && { after: args.after }) };
        const res = unwrap(await listVotes(deps, { filter, sort, dir, page, searchEngineUp: deps.searchEngineUp }));
        // Per-edge cursors MUST use the SAME fhash the repo encoded `next` with
        // (fhashFor(spec, filter)) so a client paging on an edge cursor matches.
        return voteConnection(res, sort, dir, fhashFor(votesFilterSpec, filter));
      },

      parliamentVote: async (_r: unknown, args: { voteKey: string }) => {
        const detail = unwrap(await getVoteDetail(deps, args.voteKey));
        if (detail === null) return null;
        // Flatten: the vote object carries groupBreakdown via the field resolver below.
        return { ...detail.vote, groupBreakdownData: detail.groupBreakdown };
      },

      parliamentControlItems: async (
        _r: unknown,
        args: { filter?: Record<string, unknown>; first?: number; after?: string }
      ) => {
        const filter = (args.filter ?? {}) as FilterInput;
        const page = { first: clampFirst(args.first, 100), ...(args.after !== undefined && { after: args.after }) };
        const res = unwrap(await listControlItems(deps, filter, page));
        const fhash = fhashFor(controlItemsFilterSpec, filter);
        return {
          edges: res.items.map((node) => ({
            node,
            cursor: buildNextCursor({ sort: 'itemDate', dir: 'desc', fhash, lastKeys: [node.itemDate ?? '', node.itemKey] }),
          })),
          pageInfo: { hasNextPage: res.next !== null, endCursor: res.next },
        };
      },

      parliamentActLineage: async (
        _r: unknown,
        args: { actId: string; roles?: string[]; includeBallots?: boolean }
      ) =>
        unwrap(
          await getLineageForAct(deps, {
            actId: args.actId,
            ...(args.roles !== undefined && { roles: args.roles }),
            ...(args.includeBallots !== undefined && { includeBallots: args.includeBallots }),
          })
        ),

      parliamentVoteCohesion: async (
        _r: unknown,
        args: { billKey?: string; chamber?: string; from?: string; to?: string; group?: string }
      ) =>
        unwrap(
          await rankVoteCohesion(deps, {
            ...(args.billKey !== undefined && { billKey: args.billKey }),
            ...(args.chamber !== undefined && { chamber: args.chamber }),
            ...(args.from !== undefined && { from: args.from }),
            ...(args.to !== undefined && { to: args.to }),
            ...(args.group !== undefined && { group: args.group }),
          })
        ),

      parliamentResolveFilter: async (
        _r: unknown,
        args: { dim: string; q: string; legislature?: string }
      ) => unwrap(await resolveFilters(deps, args.dim as ParliamentResolveDim, args.q, args.legislature, 10)),

      parliamentPersonCandidates: async (
        _r: unknown,
        args: { status?: string; page?: number; pageSize?: number },
        context: unknown
      ) => {
        // API-key gated (§2.6) — internal correlation state, never public.
        if (!deps.isApiKeyAuthorized(context)) {
          throw new GraphQLError('data-quality requires an API key', { extensions: { code: 'FORBIDDEN', type: 'Forbidden' } });
        }
        const res = unwrap(
          await dataQualityCandidates(deps, args.status, { ...(args.page !== undefined && { page: args.page }), ...(args.pageSize !== undefined && { pageSize: args.pageSize }) })
        );
        return { candidates: res.rows, total: res.total, totalEstimated: res.estimated };
      },
    },

    // ── field resolvers ──────────────────────────────────────────────────────
    ParliamentMember: {
      group: async (parent: { groupId: string | null; legislature: string | null }) => {
        if (parent.groupId === null) return null;
        const groups = unwrap(await listGroups(deps, parent.legislature ?? undefined, undefined));
        return groups.find((g) => g.groupId === parent.groupId) ?? null;
      },
      person: async (parent: { personId: string | null; person?: unknown }) => {
        if (parent.person !== undefined) return parent.person; // eager from getMember
        if (parent.personId === null) return null;
        return unwrap(await deps.repo.findPerson(parent.personId));
      },
      groupIntervals: async (parent: { mandateKey: string; groupIntervals?: unknown }) =>
        parent.groupIntervals !== undefined
          ? parent.groupIntervals
          : unwrap(await deps.repo.listGroupIntervals(parent.mandateKey)),
      activityCounts: async (parent: { mandateKey: string; activityCounts?: unknown }) => {
        if (parent.activityCounts !== undefined) return parent.activityCounts;
        const detail = unwrap(await getMember(deps, parent.mandateKey));
        return detail?.activityCounts ?? { votes: 0, controlItems: 0, speeches: 0, initiatives: 0, declarations: 0 };
      },
      votes: async (parent: { mandateKey: string }, args: { first?: number; after?: string }) => {
        const page = { first: clampFirst(args.first, 100), ...(args.after !== undefined && { after: args.after }) };
        const res = unwrap(await getMemberVotes(deps, parent.mandateKey, page));
        return memberVoteConnection(res, parent.mandateKey);
      },
      controlItems: async (parent: { mandateKey: string }, args: { page?: number; pageSize?: number }) => {
        const res = unwrap(await getMemberControlItems(deps, parent.mandateKey, { ...(args.page !== undefined && { page: args.page }), ...(args.pageSize !== undefined && { pageSize: args.pageSize }) }));
        return { items: res.rows, total: res.total, totalEstimated: res.estimated };
      },
      speeches: async (parent: { mandateKey: string }, args: { page?: number; pageSize?: number }) => {
        const res = unwrap(await getMemberSpeeches(deps, parent.mandateKey, { ...(args.page !== undefined && { page: args.page }), ...(args.pageSize !== undefined && { pageSize: args.pageSize }) }));
        return { speeches: res.rows, total: res.total, totalEstimated: res.estimated };
      },
      initiatives: async (parent: { mandateKey: string }, args: { page?: number; pageSize?: number }) => {
        const res = unwrap(await getMemberInitiatives(deps, parent.mandateKey, { ...(args.page !== undefined && { page: args.page }), ...(args.pageSize !== undefined && { pageSize: args.pageSize }) }));
        return { initiatives: res.rows, total: res.total, totalEstimated: res.estimated };
      },
      declarations: async (parent: { mandateKey: string }) =>
        unwrap(await deps.repo.listMemberDeclarations(parent.mandateKey)),
    },

    ParliamentPerson: {
      // Person career view: when resolved from getPersonCareer the parent already
      // carries mandates/groupIntervals/careerTotals; lazily fill if reached bare.
      mandates: async (parent: { personId: string; mandates?: unknown }) =>
        parent.mandates !== undefined ? parent.mandates : unwrap(await deps.repo.listPersonMandates(parent.personId)),
      groupIntervals: async (parent: { personId: string; groupIntervals?: unknown }) =>
        parent.groupIntervals !== undefined ? parent.groupIntervals : unwrap(await deps.repo.listGroupIntervalsForPerson(parent.personId)),
      careerTotals: async (parent: { personId: string; careerTotals?: unknown }) => {
        if (parent.careerTotals !== undefined) return parent.careerTotals;
        const career = unwrap(await getPersonCareer(deps, parent.personId));
        return career?.careerTotals ?? { mandates: 0, votes: 0, initiatives: 0, speeches: 0 };
      },
    },

    ParliamentBill: {
      events: async (parent: { billKey: string; events?: unknown }) =>
        parent.events !== undefined ? parent.events : unwrap(await deps.repo.getBillEvents(parent.billKey)),
      documents: async (parent: { billKey: string; documents?: unknown }) =>
        parent.documents !== undefined ? parent.documents : unwrap(await deps.repo.getBillDocuments(parent.billKey)),
      initiators: async (parent: { billKey: string; initiators?: unknown }) =>
        parent.initiators !== undefined ? parent.initiators : unwrap(await deps.repo.getBillInitiators(parent.billKey)),
      relatedVotes: async (parent: { billKey: string; relatedVotes?: unknown }) =>
        parent.relatedVotes !== undefined ? parent.relatedVotes : unwrap(await deps.repo.listVotesForBill(parent.billKey)),
      actLinks: async (parent: { billKey: string; actLinks?: unknown }) =>
        parent.actLinks !== undefined ? parent.actLinks : unwrap(await deps.repo.getBillActLinks(parent.billKey)),
      voteLinks: async (parent: { billKey: string; voteLinks?: unknown }) =>
        parent.voteLinks !== undefined ? parent.voteLinks : unwrap(await deps.repo.getBillVoteLinks(parent.billKey)),
    },

    ParliamentBillActLink: {
      // Kernel cross-link (§6.7): a dangling targetActId resolves to null cleanly.
      legalAct: async (parent: { targetActId: string | null }) => {
        if (parent.targetActId === null || legalActLoader === undefined) return null;
        const ref = await legalActLoader.load(parent.targetActId);
        return ref === null ? null : { actId: ref.actId, title: ref.title, actType: ref.actType };
      },
    },

    ParliamentBillVoteLink: {
      vote: async (parent: { voteKey: string }) => unwrap(await deps.repo.findVote(parent.voteKey)),
    },

    ParliamentVote: {
      groupBreakdown: async (parent: { voteKey: string; groupBreakdownData?: unknown }) =>
        parent.groupBreakdownData !== undefined ? parent.groupBreakdownData : unwrap(await deps.repo.voteGroupBreakdown(parent.voteKey)),
      ballots: async (parent: { voteKey: string }, args: { first?: number; after?: string }) => {
        const page = { first: clampFirst(args.first, 200), ...(args.after !== undefined && { after: args.after }) };
        const res = unwrap(await getVoteBallots(deps, parent.voteKey, page));
        return ballotConnection(res, parent.voteKey);
      },
      bill: async (parent: { billKey: string | null }) =>
        parent.billKey === null ? null : unwrap(await deps.repo.findBill(parent.billKey)),
    },

    ParliamentMemberVote: {
      vote: async (parent: { voteKey: string }) => unwrap(await deps.repo.findVote(parent.voteKey)),
    },

    ParliamentControlItem: {
      member: async (parent: { mandateKey: string | null }) =>
        parent.mandateKey === null ? null : unwrap(await deps.repo.findMember(parent.mandateKey)),
    },

    ParliamentInitiative: {
      bill: async (parent: { billKey: string | null }) =>
        parent.billKey === null ? null : unwrap(await deps.repo.findBill(parent.billKey)),
    },

    ParliamentBallot: {
      member: async (parent: { mandateKey: string | null }) =>
        parent.mandateKey === null ? null : unwrap(await deps.repo.findMember(parent.mandateKey)),
    },

    Entity: {
      // Gated until recipient→CUI canonicalization (§4, §6.3): resolves null today,
      // never an error (graceful degrade — no parliament slice ≠ an error).
      parliamentControls: async (parent: { cui: string }) => {
        const r = await deps.repo.controlPresenceForRecipient(parent.cui);
        if (r.isErr()) return null;
        const p = r.value;
        if (p === null) return null;
        return { controlItemCount: p.count, lastItemDate: p.lastDate, topRecipient: p.topRecipient };
      },
    },
  };
};
