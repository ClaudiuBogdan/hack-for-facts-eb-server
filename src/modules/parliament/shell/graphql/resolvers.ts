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
  parliamentStenogramErrorCode,
  type ParliamentBallot,
  type ParliamentCommittee,
  type ParliamentMemberVote,
  type ParliamentResolveDim,
  type ParliamentSpeech,
  type ParliamentSpeechPopulation,
  type ParliamentSpeechSearchDepth,
  type ParliamentStenogramError,
  type ParliamentVote,
} from '../../core/types.js';
import {
  dataQualityCandidates,
  getBillDossier,
  getCommittee,
  getDataFreshness,
  getLineageForAct,
  getMember,
  getMemberActivityCounts,
  getMemberControlItems,
  getMemberInitiatives,
  getMemberSpeeches,
  getMemberSpeechActivity,
  getMemberSpeechesConnection,
  getMemberVoteActivity,
  getMemberVotes,
  getParliamentSpeech,
  getParliamentSpeechActivity,
  getParliamentSpeechContext,
  getParliamentStenogramSession,
  getPersonCareer,
  normalizeSpeechQ,
  getVoteBallots,
  getVoteDetail,
  listBills,
  listCommittees,
  listControlItems,
  listGroups,
  listMembers,
  listParliamentSpeeches,
  listParliamentStenogramSessions,
  listVotes,
  rankVoteCohesion,
  resolveFilters,
  type ParliamentStenogramUsecaseDeps,
  type ParliamentUsecaseDeps,
} from '../../core/usecases.js';
import {
  controlItemsFilterSpec,
  memberSpeechesFhash,
  memberVotesFhash,
  parliamentSpeechesFhash,
  stenogramSessionsFhash,
  votesFilterSpec,
} from '../filters/specs.js';

import type { ParliamentTranscriptSearchPort } from '../../core/ports.js';
import type { Result } from 'neverthrow';

export interface ParliamentResolverDeps extends ParliamentUsecaseDeps {
  /**
   * The canonical full-history transcript search projection. Nullable: `null` makes
   * a stenogram `q` return SEARCH_UNAVAILABLE rather than a title-only answer.
   */
  readonly transcriptSearch: ParliamentTranscriptSearchPort | null;
  /** Kernel cross-link loader (registered by the legal module). May be undefined if legal is disabled. */
  readonly legalActLoader: LegalActByIdLoader | undefined;
  /** True when an aux search engine is available (relaxes the votes q-only bound). */
  readonly searchEngineUp: boolean;
  /** Guard: is this request API-key authorized? (data-quality surface, §2.6). */
  readonly isApiKeyAuthorized: (context: unknown) => boolean;
}

const toGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, {
    extensions: { code: GRAPHQL_ERROR_CODE[error.type], type: error.type },
  });

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) throw toGraphqlError(result.error);
  return result.value;
};

/**
 * Same as `unwrap`, for the WIDENED stenogram error union. The two module-owned
 * variants get their own `extensions.code` (`TRANSCRIPT_UNAVAILABLE`,
 * `SEARCH_UNAVAILABLE`) from the single shared mapper, so the vocabulary a client
 * branches on is identical on GraphQL, REST and MCP. `reason` / `docType` ride along
 * in the extensions because they are the actionable part (a SOURCE_ONLY capture is
 * permanent; a missing projection is an operational gap).
 */
const toStenogramGraphqlError = (error: ParliamentStenogramError): GraphQLError =>
  new GraphQLError(error.message, {
    extensions: {
      code: parliamentStenogramErrorCode(error),
      type: error.type,
      ...(error.type === 'TranscriptUnavailable' && {
        reason: error.reason,
        sessionKey: error.sessionKey,
        // The sitting itself, whenever we hold it. This is what keeps
        // TRANSCRIPT_UNAVAILABLE actionable and distinct from NOT_FOUND: a
        // SOURCE_ONLY sitting is real, and the client renders its label plus an
        // "open the official transcript" action straight from here.
        session: error.session,
      }),
      ...(error.type === 'SearchUnavailable' && { docType: error.docType }),
    },
  });

const unwrapStenogram = <T>(result: Result<T, ParliamentStenogramError>): T => {
  if (result.isOk()) return result.value;
  throw toStenogramGraphqlError(result.error);
};

const clampFirst = (first: number | undefined, max: number): number =>
  Math.min(Math.max(first ?? 20, 1), max);

/**
 * Drop filter fields whose value is `null`. A GraphQL-nullable input field can arrive as
 * `null` ({legislature:null}, {q:null}); treat that as ABSENT so the default-latest /
 * bound logic applies and the kernel composer never sees a null value (which it would
 * mishandle). Op-level nulls ({field:{eq:null}}) are already handled downstream.
 */
const sansNull = (filter: FilterInput | undefined): FilterInput => {
  // Read as unknown: the type omits null, but `filter: null` can arrive at runtime.
  const f: unknown = filter;
  if (f === null || typeof f !== 'object') return {};
  return Object.fromEntries(
    Object.entries(f as Record<string, unknown>).filter(([, v]) => v !== null)
  ) as FilterInput;
};

export const makeParliamentResolvers = (deps: ParliamentResolverDeps): Record<string, unknown> => {
  const { legalActLoader } = deps;
  /** The stenogram usecases take the search port alongside the repo. */
  const stenogramDeps: ParliamentStenogramUsecaseDeps = {
    repo: deps.repo,
    meili: deps.meili,
    transcriptSearch: deps.transcriptSearch,
  };

  const voteConnection = (
    page: CursorPage<ParliamentVote> & { total: number; totalEstimated: boolean },
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
    // The count over the SAME filter as the page (capped; see the repo) — what
    // lets the list say "412 votes match" instead of only "the most recent 10".
    total: page.total,
    totalEstimated: page.totalEstimated,
  });

  const ballotConnection = (page: CursorPage<ParliamentBallot>, voteKey: string) => {
    const fhash = filterHash(`ballots:${voteKey}`);
    return {
      // voteKey is carried so the ParliamentBallotConnection.total field resolver can
      // count lazily (M16) — only when the client actually selects `total`.
      voteKey,
      edges: page.items.map((node) => ({
        node,
        cursor: buildNextCursor({ sort: 'rowIndex', dir: 'asc', fhash, lastKeys: [node.rowIndex] }),
      })),
      pageInfo: { hasNextPage: page.next !== null, endCursor: page.next },
    };
  };

  const committeeConnection = (
    page: CursorPage<ParliamentCommittee>,
    chamber: string | undefined,
    legislature: string | undefined
  ) => {
    // Same fhash the repo encoded `next` with (committees:<chamber>:<legislature>).
    const fhash = filterHash(`committees:${chamber ?? ''}:${legislature ?? ''}`);
    return {
      edges: page.items.map((node) => ({
        node,
        cursor: buildNextCursor({
          sort: 'committeeKey',
          dir: 'asc',
          fhash,
          lastKeys: [node.committeeKey],
        }),
      })),
      pageInfo: { hasNextPage: page.next !== null, endCursor: page.next },
    };
  };

  const memberVoteConnection = (
    page: CursorPage<ParliamentMemberVote> & { total: number },
    mandateKey: string,
    filter: FilterInput
  ) => {
    // Per-edge cursors MUST use the SAME fhash the repo encoded `next` with
    // (memberVotesFhash(mandateKey, filter)) so paging on an edge cursor matches.
    const fhash = memberVotesFhash(mandateKey, filter);
    return {
      edges: page.items.map((node) => ({
        node,
        cursor: buildNextCursor({
          sort: 'memberVote',
          dir: 'desc',
          fhash,
          lastKeys: [node.voteDate ?? '', node.voteKey, node.rowIndex],
        }),
      })),
      pageInfo: { hasNextPage: page.next !== null, endCursor: page.next },
      total: page.total,
    };
  };

  const memberSpeechConnection = (
    page: CursorPage<ParliamentSpeech> & {
      total: number;
      population: ParliamentSpeechPopulation;
    },
    mandateKey: string,
    filter: FilterInput,
    q: string | undefined
  ) => {
    // Per-edge cursors MUST use the SAME fhash the repo encoded `next` with
    // (memberSpeechesFhash(mandateKey, filter, q, APPLIED population)) and the SAME
    // keyset shape ([spokenAt, speechKey]) so paging on an edge cursor matches. The
    // population comes back FROM the repo — never re-derived here, which could disagree.
    const fhash = memberSpeechesFhash(mandateKey, filter, q, page.population);
    return {
      edges: page.items.map((node) => ({
        node,
        cursor: buildNextCursor({
          sort: 'spokenAt',
          dir: 'desc',
          fhash,
          lastKeys: [node.spokenAt ?? '', node.speechKey],
        }),
      })),
      pageInfo: { hasNextPage: page.next !== null, endCursor: page.next },
      total: page.total,
    };
  };

  const speechConnection = (
    page: CursorPage<ParliamentSpeech> & {
      total: number;
      totalEstimated: boolean;
      searchDepth: ParliamentSpeechSearchDepth | null;
      population: ParliamentSpeechPopulation;
    },
    filter: FilterInput,
    q: string | undefined
  ) => {
    // Per-edge cursors MUST use the SAME fhash the repo encoded `next` with —
    // parliamentSpeechesFhash(filter, q, APPLIED depth; 'none' when no q, APPLIED
    // population) — and the SAME keyset shape ([spokenAt ?? '', speechKey]) so paging on
    // an edge cursor matches the repo tuple predicate exactly. Both probe-derived values
    // come back FROM the repo rather than being re-derived here.
    const fhash = parliamentSpeechesFhash(filter, q, page.searchDepth ?? 'none', page.population);
    return {
      edges: page.items.map((node) => ({
        node,
        cursor: buildNextCursor({
          sort: 'spokenAt',
          dir: 'desc',
          fhash,
          lastKeys: [node.spokenAt ?? '', node.speechKey],
        }),
      })),
      pageInfo: { hasNextPage: page.next !== null, endCursor: page.next },
      total: page.total,
      totalEstimated: page.totalEstimated,
      searchDepth: page.searchDepth,
    };
  };

  return {
    Query: {
      parliamentMembers: async (
        _r: unknown,
        args: { filter?: FilterInput; page?: number; pageSize?: number }
      ) => {
        const res = unwrap(
          await listMembers(deps, {
            filter: sansNull(args.filter),
            sort: 'name',
            page: {
              ...(args.page !== undefined && { page: args.page }),
              ...(args.pageSize !== undefined && { pageSize: args.pageSize }),
            },
          })
        );
        return { members: res.rows, total: res.total, totalEstimated: res.estimated };
      },

      // IDENTITY ONLY — one query. person / groupIntervals / activityCounts are
      // resolved by the field resolvers below, and only when they are selected, so
      // an ancillary read can never turn a real member into a false "not found".
      parliamentMember: async (_r: unknown, args: { mandateKey: string }) =>
        unwrap(await getMember(deps, args.mandateKey)),

      parliamentPerson: async (_r: unknown, args: { personId: string }) => {
        const career = unwrap(await getPersonCareer(deps, args.personId));
        if (career === null) return null;
        // Flatten the career into a ParliamentPerson; mandates / groupIntervals /
        // careerTotals are carried so the field resolvers don't refetch.
        return {
          ...career.person,
          mandates: career.mandates,
          groupIntervals: career.groupIntervals,
          careerTotals: career.careerTotals,
        };
      },

      parliamentGroups: async (
        _r: unknown,
        args: { legislature?: string; chamber?: string; current?: boolean }
      ) => unwrap(await listGroups(deps, args.legislature, args.chamber, args.current)),

      parliamentGroupMembers: async (
        _r: unknown,
        args: { groupId: string; legislature?: string; current?: boolean }
      ) => unwrap(await deps.repo.listGroupMembers(args.groupId, args.legislature, args.current)),

      parliamentBills: async (
        _r: unknown,
        args: { filter?: FilterInput; sort?: string; page?: number; pageSize?: number }
      ) => {
        const res = unwrap(
          await listBills(deps, {
            filter: sansNull(args.filter),
            sort: args.sort ?? 'updated_desc',
            page: {
              ...(args.page !== undefined && { page: args.page }),
              ...(args.pageSize !== undefined && { pageSize: args.pageSize }),
            },
          })
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
          dossierBillKeys: dossier.viewBillKeys,
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
        args: {
          filter?: Record<string, unknown>;
          sort?: string;
          dir?: string;
          first?: number;
          after?: string;
        }
      ) => {
        const sort = args.sort === 'voteKey' ? 'voteKey' : 'voteDate';
        // DESC stays the default, so every existing caller keeps its order. `dir` is
        // threaded into decodeCursor/buildNextCursor exactly like `sort` (repo +
        // voteConnection below), which is what makes a DESC cursor replayed under ASC
        // a clean INVALID_INPUT instead of a silently reversed page.
        const dir = args.dir === 'ASC' ? 'asc' : 'desc';
        const filter = sansNull(args.filter as FilterInput | undefined);
        const page = {
          first: clampFirst(args.first, 100),
          ...(args.after != null && { after: args.after }),
        };
        const res = unwrap(
          await listVotes(deps, { filter, sort, dir, page, searchEngineUp: deps.searchEngineUp })
        );
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
        const filter = sansNull(args.filter as FilterInput | undefined);
        const page = {
          first: clampFirst(args.first, 100),
          ...(args.after != null && { after: args.after }),
        };
        const res = unwrap(await listControlItems(deps, filter, page));
        const fhash = fhashFor(controlItemsFilterSpec, filter);
        return {
          edges: res.items.map((node) => ({
            node,
            cursor: buildNextCursor({
              sort: 'itemDate',
              dir: 'desc',
              fhash,
              lastKeys: [node.itemDate ?? '', node.itemKey],
            }),
          })),
          pageInfo: { hasNextPage: res.next !== null, endCursor: res.next },
        };
      },

      parliamentSpeeches: async (
        _r: unknown,
        args: { filter?: Record<string, unknown>; q?: string; first?: number; after?: string }
      ) => {
        const filter = sansNull(args.filter as FilterInput | undefined);
        // Normalize q ONCE and thread the SAME value to the usecase (→ repo fhash)
        // and the connection builder, so the per-edge cursor fhash matches the repo's.
        const q = normalizeSpeechQ(args.q);
        const page = {
          first: clampFirst(args.first, 100),
          ...(args.after != null && { after: args.after }),
        };
        const res = unwrap(await listParliamentSpeeches(deps, { filter, page, q }));
        return speechConnection(res, filter, q);
      },

      parliamentSpeechActivity: async (
        _r: unknown,
        args: { year: number; filter?: Record<string, unknown>; q?: string }
      ) =>
        unwrap(
          await getParliamentSpeechActivity(
            deps,
            args.year,
            sansNull(args.filter as FilterInput | undefined),
            normalizeSpeechQ(args.q)
          )
        ),

      parliamentSpeech: async (_r: unknown, args: { speechKey: string }) =>
        unwrap(await getParliamentSpeech(deps, args.speechKey)),

      parliamentStenogramSessions: async (
        _r: unknown,
        args: { filter?: Record<string, unknown>; q?: string; first?: number; after?: string }
      ) => {
        const filter = sansNull(args.filter as FilterInput | undefined);
        // Normalize q ONCE and thread the SAME value into the usecase (→ repo fhash)
        // and the connection builder, so a per-edge cursor matches the repo's `next`.
        const q = normalizeSpeechQ(args.q);
        const page = {
          first: clampFirst(args.first, 100),
          ...(args.after != null && { after: args.after }),
        };
        const res = await listParliamentStenogramSessions(stenogramDeps, { filter, page, q });
        const value = unwrapStenogram(res);
        const fhash = stenogramSessionsFhash(filter, q);
        return {
          edges: value.items.map((node) => ({
            node,
            cursor: buildNextCursor({
              sort: 'sessionDate',
              dir: 'desc',
              fhash,
              lastKeys: [node.sessionDate ?? '', node.sessionKey],
            }),
          })),
          pageInfo: { hasNextPage: value.next !== null, endCursor: value.next },
          total: value.total,
          totalEstimated: value.totalEstimated,
        };
      },

      parliamentStenogramSession: async (
        _r: unknown,
        args: { sessionKey: string; offset?: number; limit?: number }
      ) =>
        unwrapStenogram(
          await getParliamentStenogramSession(stenogramDeps, args.sessionKey, {
            ...(args.offset !== undefined && { offset: args.offset }),
            ...(args.limit !== undefined && { limit: args.limit }),
          })
        ),

      parliamentSpeechContext: async (_r: unknown, args: { speechKey: string }) =>
        unwrapStenogram(await getParliamentSpeechContext(stenogramDeps, args.speechKey)),

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
      ) =>
        unwrap(
          await resolveFilters(deps, args.dim as ParliamentResolveDim, args.q, args.legislature, 10)
        ),

      parliamentPersonCandidates: async (
        _r: unknown,
        args: { status?: string; page?: number; pageSize?: number },
        context: unknown
      ) => {
        // API-key gated (§2.6) — internal correlation state, never public.
        if (!deps.isApiKeyAuthorized(context)) {
          throw new GraphQLError('data-quality requires an API key', {
            extensions: { code: 'FORBIDDEN', type: 'Forbidden' },
          });
        }
        const res = unwrap(
          await dataQualityCandidates(deps, args.status, {
            ...(args.page !== undefined && { page: args.page }),
            ...(args.pageSize !== undefined && { pageSize: args.pageSize }),
          })
        );
        return { candidates: res.rows, total: res.total, totalEstimated: res.estimated };
      },

      // B4: nullable root (H2) — a query error isolates to this field, not the siblings.
      parliamentDataFreshness: async () => unwrap(await getDataFreshness(deps)),

      parliamentCommittees: async (
        _r: unknown,
        args: { chamber?: string; legislature?: string; first?: number; after?: string }
      ) => {
        const page = {
          first: clampFirst(args.first, 100),
          ...(args.after != null && { after: args.after }),
        };
        const res = unwrap(await listCommittees(deps, args.chamber, args.legislature, page));
        return committeeConnection(res, args.chamber, args.legislature);
      },

      parliamentCommittee: async (_r: unknown, args: { committeeKey: string }) => {
        const detail = unwrap(await getCommittee(deps, args.committeeKey));
        if (detail === null) return null;
        // Flatten the committee fields onto the detail (the members/linkedBills/
        // meetingsCount stay as carried arrays/scalars — no field resolvers needed).
        return {
          ...detail.committee,
          members: detail.members,
          linkedBills: detail.linkedBills,
          linkedBillsTotal: detail.linkedBillsTotal,
          meetingsCount: detail.meetingsCount,
        };
      },
    },

    // ── field resolvers ──────────────────────────────────────────────────────
    ParliamentMember: {
      // H1a: build the group from the member's OWN fields (chamber-slug groupId +
      // groupName + chamber) — no DB hit, no N+1. The old code called
      // listGroups(undefined chamber) → the whole-parliament branch whose groupId is the
      // party NAME ("PNL"), then matched it against the member's chamber-SLUG groupId
      // ("pnl-senat") → never matched → null for 100% of members.
      group: (parent: {
        groupId: string | null;
        groupName: string | null;
        chamber: string | null;
      }) =>
        parent.groupId === null
          ? null
          : {
              groupId: parent.groupId,
              chamber: parent.chamber ?? '',
              name: parent.groupName ?? parent.groupId,
              memberCount: null,
            },
      person: async (parent: { personId: string | null; person?: unknown }) => {
        if (parent.person !== undefined) return parent.person; // eager (person career view)
        if (parent.personId === null) return null;
        return unwrap(await deps.repo.findPerson(parent.personId));
      },
      groupIntervals: async (parent: { mandateKey: string; groupIntervals?: unknown }) =>
        parent.groupIntervals !== undefined
          ? parent.groupIntervals
          : unwrap(await deps.repo.listGroupIntervals(parent.mandateKey)),
      /**
       * ANCILLARY + NULLABLE. One bounded query. On a read failure this returns
       * `null` — "counts unavailable" — instead of throwing (which non-null
       * propagation would turn into `parliamentMember: null`, a false 404) and
       * instead of the old fabricated all-zero object (indistinguishable from a
       * member who genuinely never voted or spoke).
       */
      activityCounts: async (parent: { mandateKey: string; activityCounts?: unknown }) => {
        if (parent.activityCounts !== undefined) return parent.activityCounts;
        const counts = await getMemberActivityCounts(deps, parent.mandateKey);
        return counts.isErr() ? null : counts.value;
      },
      votes: async (
        parent: { mandateKey: string },
        args: { first?: number; after?: string; filter?: FilterInput }
      ) => {
        const filter = sansNull(args.filter);
        const page = {
          first: clampFirst(args.first, 100),
          ...(args.after != null && { after: args.after }),
        };
        const res = unwrap(await getMemberVotes(deps, parent.mandateKey, page, filter));
        return memberVoteConnection(res, parent.mandateKey, filter);
      },
      voteActivity: async (
        parent: { mandateKey: string },
        args: { year: number; filter?: FilterInput }
      ) =>
        unwrap(
          await getMemberVoteActivity(deps, parent.mandateKey, args.year, sansNull(args.filter))
        ),
      controlItems: async (
        parent: { mandateKey: string },
        args: { page?: number; pageSize?: number }
      ) => {
        const res = unwrap(
          await getMemberControlItems(deps, parent.mandateKey, {
            ...(args.page !== undefined && { page: args.page }),
            ...(args.pageSize !== undefined && { pageSize: args.pageSize }),
          })
        );
        return { items: res.rows, total: res.total, totalEstimated: res.estimated };
      },
      speeches: async (
        parent: { mandateKey: string },
        args: { page?: number; pageSize?: number }
      ) => {
        const res = unwrap(
          await getMemberSpeeches(deps, parent.mandateKey, {
            ...(args.page !== undefined && { page: args.page }),
            ...(args.pageSize !== undefined && { pageSize: args.pageSize }),
          })
        );
        return { speeches: res.rows, total: res.total, totalEstimated: res.estimated };
      },
      speechesConnection: async (
        parent: { mandateKey: string },
        args: { first?: number; after?: string; filter?: FilterInput; q?: string }
      ) => {
        const filter = sansNull(args.filter);
        // Normalize q ONCE and thread the SAME value to the usecase (→ repo fhash) and
        // the connection builder, so the per-edge cursor fhash matches the repo's.
        const q = normalizeSpeechQ(args.q);
        const page = {
          first: clampFirst(args.first, 100),
          ...(args.after != null && { after: args.after }),
        };
        const res = unwrap(
          await getMemberSpeechesConnection(deps, parent.mandateKey, page, filter, q)
        );
        return memberSpeechConnection(res, parent.mandateKey, filter, q);
      },
      speechActivity: async (
        parent: { mandateKey: string },
        args: { year: number; filter?: FilterInput; q?: string }
      ) =>
        unwrap(
          await getMemberSpeechActivity(
            deps,
            parent.mandateKey,
            args.year,
            sansNull(args.filter),
            normalizeSpeechQ(args.q)
          )
        ),
      initiatives: async (
        parent: { mandateKey: string },
        args: { page?: number; pageSize?: number }
      ) => {
        const res = unwrap(
          await getMemberInitiatives(deps, parent.mandateKey, {
            ...(args.page !== undefined && { page: args.page }),
            ...(args.pageSize !== undefined && { pageSize: args.pageSize }),
          })
        );
        return { initiatives: res.rows, total: res.total, totalEstimated: res.estimated };
      },
      declarations: async (parent: { mandateKey: string }) =>
        unwrap(await deps.repo.listMemberDeclarations(parent.mandateKey)),
      // B2: lazy — only hit when the client selects committeeMemberships.
      committeeMemberships: async (parent: { mandateKey: string }) =>
        unwrap(await deps.repo.listMemberCommitteeMemberships(parent.mandateKey)),
    },

    ParliamentSpeech: {
      // fullText is LAZY: a single-row lookup into parliament.speech_texts, run ONLY
      // when the client selects it (never materialized in the list/count queries).
      // Degrades to null when the transcript table/row is absent (parallel slice).
      fullText: async (parent: { speechKey: string; fullText?: string | null }) =>
        parent.fullText !== undefined
          ? parent.fullText
          : unwrap(await deps.repo.getSpeechFullText(parent.speechKey)),
      // member is LAZY (the ParliamentControlItem.member pattern): one findMember
      // lookup, only when selected; a NULL-mandate turn resolves null.
      member: async (parent: { mandateKey: string | null }) =>
        parent.mandateKey === null ? null : unwrap(await deps.repo.findMember(parent.mandateKey)),
      // context is LAZY and NARROWLY tolerant. A speech read must not fail merely
      // because the canonical projection is not deployed on this database, so THAT one
      // condition resolves null (the dedicated parliamentSpeechContext root reports it
      // explicitly for a caller who asked for context specifically).
      //
      // Everything else PROPAGATES. A Database/Upstream/Timeout failure is not "this
      // turn has no canonical context" — swallowing it here would turn an outage into
      // a silent, plausible-looking null on every speech in the response.
      context: async (parent: { speechKey: string }) => {
        const res = await getParliamentSpeechContext(stenogramDeps, parent.speechKey);
        if (res.isOk()) return res.value;
        const error = res.error;
        if (error.type === 'TranscriptUnavailable' && error.reason === 'projection_unavailable') {
          return null;
        }
        throw toStenogramGraphqlError(error);
      },
    },

    ParliamentStenogramSegment: {
      // Lazy member resolution, same shape as ParliamentSpeech.member: an unmatched
      // speaker (guest, minister) has a null mandateKey and resolves null.
      member: async (parent: { mandateKey: string | null }) =>
        parent.mandateKey === null ? null : unwrap(await deps.repo.findMember(parent.mandateKey)),
    },

    ParliamentGroupInterval: {
      // H1b: the SDL exposes ParliamentGroupInterval.group but NO resolver existed →
      // graphql-js default resolver → parent.group (undefined) → null for 100% of
      // intervals. Resolve the interval's groupId slug via the parliamentary_groups
      // registry (covers historical/migrated groups like POT/PIR — M7).
      group: async (parent: { groupId: string }) =>
        unwrap(await deps.repo.findGroup(parent.groupId)),
    },

    ParliamentPerson: {
      // Person career view: when resolved from getPersonCareer the parent already
      // carries mandates/groupIntervals/careerTotals; lazily fill if reached bare.
      mandates: async (parent: { personId: string; mandates?: unknown }) =>
        parent.mandates !== undefined
          ? parent.mandates
          : unwrap(await deps.repo.listPersonMandates(parent.personId)),
      groupIntervals: async (parent: { personId: string; groupIntervals?: unknown }) =>
        parent.groupIntervals !== undefined
          ? parent.groupIntervals
          : unwrap(await deps.repo.listGroupIntervalsForPerson(parent.personId)),
      careerTotals: async (parent: { personId: string; careerTotals?: unknown }) => {
        if (parent.careerTotals !== undefined) return parent.careerTotals;
        const career = unwrap(await getPersonCareer(deps, parent.personId));
        return career?.careerTotals ?? { mandates: 0, votes: 0, initiatives: 0, speeches: 0 };
      },
    },

    ParliamentBill: {
      events: async (parent: { billKey: string; events?: unknown }) =>
        parent.events !== undefined
          ? parent.events
          : unwrap(await deps.repo.getBillEvents(parent.billKey)),
      documents: async (parent: { billKey: string; documents?: unknown }) =>
        parent.documents !== undefined
          ? parent.documents
          : unwrap(await deps.repo.getBillDocuments(parent.billKey)),
      initiators: async (parent: { billKey: string; initiators?: unknown }) =>
        parent.initiators !== undefined
          ? parent.initiators
          : unwrap(await deps.repo.getBillInitiators(parent.billKey)),
      relatedVotes: async (parent: { billKey: string; relatedVotes?: unknown }) =>
        parent.relatedVotes !== undefined
          ? parent.relatedVotes
          : unwrap(await deps.repo.listVotesForBill(parent.billKey)),
      actLinks: async (parent: { billKey: string; actLinks?: unknown }) =>
        parent.actLinks !== undefined
          ? parent.actLinks
          : unwrap(await deps.repo.getBillActLinks(parent.billKey)),
      voteLinks: async (parent: { billKey: string; voteLinks?: unknown }) =>
        parent.voteLinks !== undefined
          ? parent.voteLinks
          : unwrap(await deps.repo.getBillVoteLinks(parent.billKey)),
      // B1: lazy — NON-AUTHORITATIVE AI metadata, only fetched when explicitly selected.
      aiMetadata: async (parent: { billKey: string }) =>
        unwrap(await deps.repo.findBillAiMetadata(parent.billKey)),
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
      // Derived from the COUNTS THEMSELVES, not from `outcome` — the point of the
      // field is to stop laundering a two-number comparison through a word that
      // reads as the bill's fate. Null counts stay null: a vote whose tally the
      // source never published makes no statement at all (202 such rows), and
      // defaulting it to "adopted" is exactly the fabrication being removed.
      tallyRelation: (parent: {
        tally?: { pentru?: number | null; impotriva?: number | null } | null;
      }) => {
        const pentru = parent.tally?.pentru;
        if (pentru == null) return null;
        return pentru > (parent.tally?.impotriva ?? 0)
          ? 'for_exceeds_against'
          : 'for_does_not_exceed_against';
      },
      groupBreakdown: async (parent: { voteKey: string; groupBreakdownData?: unknown }) =>
        parent.groupBreakdownData !== undefined
          ? parent.groupBreakdownData
          : unwrap(await deps.repo.voteGroupBreakdown(parent.voteKey)),
      ballots: async (parent: { voteKey: string }, args: { first?: number; after?: string }) => {
        const page = {
          first: clampFirst(args.first, 200),
          ...(args.after != null && { after: args.after }),
        };
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
      // B1: lazy — NON-AUTHORITATIVE AI metadata (public rows only), fetched on select.
      aiMetadata: async (parent: { itemKey: string }) =>
        unwrap(await deps.repo.findControlItemAiMetadata(parent.itemKey)),
    },

    ParliamentInitiative: {
      bill: async (parent: { billKey: string | null }) =>
        parent.billKey === null ? null : unwrap(await deps.repo.findBill(parent.billKey)),
    },

    ParliamentBallot: {
      member: async (parent: { mandateKey: string | null }) =>
        parent.mandateKey === null ? null : unwrap(await deps.repo.findMember(parent.mandateKey)),
    },

    ParliamentBallotConnection: {
      // M16: exact ballot count for the vote, resolved lazily (one count query) only
      // when the client selects `total` — so a normal `ballots(first:n)` page pays nothing.
      total: async (parent: { voteKey: string }) =>
        unwrap(await deps.repo.ballotResolution(parent.voteKey)).total,
    },

    Entity: {
      // Gated until recipient→CUI canonicalization (§4, §6.3): resolves null today,
      // never an error (graceful degrade — no parliament slice ≠ an error).
      parliamentControls: async (parent: { cui: string }) => {
        const r = await deps.repo.controlPresenceForRecipient(parent.cui);
        if (r.isErr()) return null;
        const p = r.value;
        if (p === null) return null;
        return {
          controlItemCount: p.count,
          lastItemDate: p.lastDate,
          topRecipient: p.topRecipient,
        };
      },
    },
  };
};
