/**
 * Parliament module — MCP tools (plan 04 §8). Each tool calls the SAME usecase the
 * GraphQL resolver does (tri-surface equivalence, §14.7); output is the kernel
 * `{ ok, kind, query?, link?, item|items?, summary? }` object. Bounded sizes;
 * NEVER emits excluded columns (§2.6). Naming `<verb>_parliament_<noun>`.
 */

import {
  getParliamentLawLineageInput,
  getParliamentMemberActivityInput,
  getParliamentSpeechContextInput,
  getParliamentStenogramSessionInput,
  PARLIAMENT_MCP_KINDS,
  rankParliamentVoteCohesionInput,
  resolveParliamentFiltersInput,
  searchParliamentSpeechesInput,
  searchParliamentStenogramSessionsInput,
} from './io.js';
import {
  parliamentStenogramErrorCode,
  type MemberActivityKind,
  type ParliamentResolveDim,
  type ParliamentStenogramError,
} from '../../core/types.js';
import {
  getLineageForAct,
  getMemberActivityBundle,
  getParliamentSpeechContext,
  getParliamentStenogramSession,
  listParliamentSpeeches,
  listParliamentStenogramSessions,
  rankVoteCohesion,
  resolveFilters,
  type ParliamentStenogramUsecaseDeps,
} from '../../core/usecases.js';

import type { FilterInput, KernelMcpTool, McpToolOutput } from '@/modules/shared/index.js';

/**
 * MCP deps INCLUDE the transcript search port (`ParliamentStenogramUsecaseDeps`), so
 * the stenogram tools call exactly the same usecases as GraphQL and REST.
 */
export interface ParliamentMcpDeps extends ParliamentStenogramUsecaseDeps {
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
const errorOut = (kind: string, message: string): McpToolOutput => ({
  ok: false,
  kind,
  error: message,
});
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
      const res = await resolveFilters(
        deps,
        dim,
        q,
        strArg(args, 'legislature'),
        intArg(args, 'limit', 10)
      );
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
      if (actId === undefined)
        return errorOut(
          PARLIAMENT_MCP_KINDS.lineage,
          'actId is required (resolve a citation via the legal tools first)'
        );
      const roles = Array.isArray(args['roles'])
        ? (args['roles'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined;
      const res = await getLineageForAct(deps, {
        actId,
        ...(roles !== undefined && { roles }),
        includeBallots: boolArg(args, 'includeBallots'),
      });
      if (res.isErr()) return errorOut(PARLIAMENT_MCP_KINDS.lineage, res.error.message);
      const lineage = res.value;
      if (lineage === null) {
        return {
          ok: true,
          kind: PARLIAMENT_MCP_KINDS.lineage,
          query: { actId },
          summary: `No parliamentary lineage for act ${actId}.`,
        };
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
            (finalVote.ballotsResolved !== null
              ? `; ${n(finalVote.ballotsResolved)} ballots person-resolved`
              : '')
        );
      }
      return {
        ok: true,
        kind: PARLIAMENT_MCP_KINDS.lineage,
        query: { actId },
        link: `${clientBaseUrl}/parlament/lineage/acts/${actId}`,
        item: lineage,
        summary:
          (summaryParts.length > 0 ? summaryParts.join('; ') : `Lineage for act ${actId}.`) +
          (lineage.caveats.length > 0 ? ` (${lineage.caveats.join(' ')})` : ''),
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
        return errorOut(
          PARLIAMENT_MCP_KINDS.memberActivity,
          'one of mandateKey or personId is required'
        );
      }
      const kinds = Array.isArray(args['kinds'])
        ? (args['kinds'] as unknown[]).filter(
            (x): x is MemberActivityKind =>
              typeof x === 'string' && ['votes', 'control', 'speeches', 'initiatives'].includes(x)
          )
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
        return {
          ok: true,
          kind: PARLIAMENT_MCP_KINDS.memberActivity,
          query: { mandateKey, personId },
          summary: 'No such member/person.',
        };
      }
      const name =
        bundle.member?.fullName ?? bundle.person?.canonicalName ?? mandateKey ?? personId ?? '';
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
      const top = [...res.value].sort(
        (a, b) => (b.cohesionIndex ?? -1) - (a.cohesionIndex ?? -1)
      )[0];
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

  const speechesTool: KernelMcpTool = {
    name: 'search_parliament_speeches',
    description:
      'Global parliamentary speeches (stenograme): filter by speaker mandateKey, chamber and/or a spoken-at date window, with optional free-text q over title + summary (+ the verbatim transcript when mandate-bound or the window is at most 92 days). BOUNDEDNESS: pass a mandateKey OR both from and to (at most 366 days apart) — an unbounded call is refused. Resolve a person → mandateKey first via resolve_parliament_filters / get_parliament_member_activity.',
    inputShape: searchParliamentSpeechesInput,
    async handler(args): Promise<McpToolOutput> {
      const q = strArg(args, 'q');
      const mandateKey = strArg(args, 'mandateKey');
      const chamber = strArg(args, 'chamber');
      const from = strArg(args, 'from');
      const to = strArg(args, 'to');
      const after = strArg(args, 'after');
      const limit = Math.min(Math.max(intArg(args, 'limit', 20), 1), 100);
      // Build the SAME FilterInput shape the GraphQL root takes; guard errors
      // (unbounded, bad dates, q too long, bad cursor) surface in-band as {ok:false, error}.
      const filter: FilterInput = {
        ...(mandateKey !== undefined && { mandateKey: { eq: mandateKey } }),
        ...(chamber !== undefined && { chamber: { eq: chamber } }),
        ...((from !== undefined || to !== undefined) && {
          spokenAt: {
            ...(from !== undefined && { gte: from }),
            ...(to !== undefined && { lte: to }),
          },
        }),
      };
      const res = await listParliamentSpeeches(deps, {
        filter,
        page: { first: limit, ...(after !== undefined && { after }) },
        q,
      });
      if (res.isErr()) return errorOut(PARLIAMENT_MCP_KINDS.speeches, res.error.message);
      const page = res.value;
      const count = page.totalEstimated ? '≥10000' : n(page.total);
      const depthWords =
        page.searchDepth === null
          ? ''
          : page.searchDepth === 'FULL_TEXT'
            ? '; q searched title + summary + verbatim transcript'
            : '; q searched title + summary only (transcript depth needs a single mandateKey or a window of at most 92 days)';
      return {
        ok: true,
        kind: PARLIAMENT_MCP_KINDS.speeches,
        query: { q, mandateKey, chamber, from, to, limit },
        link: `${clientBaseUrl}/parlament/stenograme`,
        items: page.items,
        meta: {
          total: page.total,
          totalEstimated: page.totalEstimated,
          searchDepth: page.searchDepth,
          hasNextPage: page.next !== null,
          // Replay via the `after` input (same query args) to fetch older matches.
          nextCursor: page.next,
        },
        summary: `${count} speech(es); showing ${n(page.items.length)}${depthWords}.`,
      };
    },
  };

  // ── canonical stenogram: one SEARCH tool + two READ tools ────────────────────
  // All three go through the SAME usecases the GraphQL roots and the REST transcript
  // route use, so boundedness, privacy and availability cannot differ per surface.
  // Availability/refusal errors surface IN-BAND as {ok:false, error:<code>} with the
  // SAME code vocabulary REST and GraphQL use (`parliamentStenogramErrorCode`).
  const stenogramErrorOut = (kind: string, error: ParliamentStenogramError): McpToolOutput => ({
    ok: false,
    kind,
    error: error.message,
    // `errorCode` is the kernel's transport-neutral field, aligned with GraphQL's
    // extensions.code — so an agent branches on the SAME vocabulary REST and GraphQL
    // use. `errorType` only exists for the kernel variants (the two module-owned ones
    // are outside `ApiError['type']`), and is set only when it applies.
    errorCode: parliamentStenogramErrorCode(error),
    ...(error.type !== 'TranscriptUnavailable' &&
      error.type !== 'SearchUnavailable' && { errorType: error.type }),
    // A refusal must still be ACTIONABLE. For a sitting we hold but cannot read, the
    // session ref travels with the failure so an agent can cite the official
    // transcript URL (with its precision) instead of reporting a dead end — the same
    // payload REST and GraphQL attach.
    ...(error.type === 'TranscriptUnavailable' && {
      meta: {
        reason: error.reason,
        sessionKey: error.sessionKey,
        session: error.session,
      },
    }),
    ...(error.type === 'SearchUnavailable' && { meta: { docType: error.docType } }),
  });

  const stenogramSessionsTool: KernelMcpTool = {
    name: 'search_parliament_stenogram_sessions',
    description:
      'Canonical parliamentary transcripts (stenograme) at the SITTING grain: filter by chamber, date window or year, availability, and/or a speaker mandateKey, with optional free-text q across the WHOLE transcript history. Needs no date bound (one row per captured sitting, indexed by date). Returns each sitting with its official source URL, source precision, and block/speech/speaker counts — then read one with get_parliament_stenogram_session. If q cannot be answered over the full history the call FAILS with SEARCH_UNAVAILABLE rather than silently matching titles only.',
    inputShape: searchParliamentStenogramSessionsInput,
    async handler(args): Promise<McpToolOutput> {
      const q = strArg(args, 'q');
      const chamber = strArg(args, 'chamber');
      const from = strArg(args, 'from');
      const to = strArg(args, 'to');
      const availability = strArg(args, 'availability');
      const mandateKey = strArg(args, 'mandateKey');
      const after = strArg(args, 'after');
      const yearRaw = args['year'];
      const year = typeof yearRaw === 'number' && Number.isInteger(yearRaw) ? yearRaw : undefined;
      const limit = Math.min(Math.max(intArg(args, 'limit', 20), 1), 100);
      // The SAME FilterInput shape the GraphQL root builds — one filter vocabulary.
      const filter: FilterInput = {
        ...(chamber !== undefined && { chamber: { eq: chamber } }),
        ...(availability !== undefined && { availability: { eq: availability } }),
        ...(mandateKey !== undefined && { mandateKey: { eq: mandateKey } }),
        ...(year !== undefined && { year: { eq: year } }),
        ...((from !== undefined || to !== undefined) && {
          sessionDate: {
            ...(from !== undefined && { gte: from }),
            ...(to !== undefined && { lte: to }),
          },
        }),
      };
      const res = await listParliamentStenogramSessions(deps, {
        filter,
        page: { first: limit, ...(after !== undefined && { after }) },
        q,
      });
      if (res.isErr()) return stenogramErrorOut(PARLIAMENT_MCP_KINDS.stenogramSessions, res.error);
      const page = res.value;
      const count = page.totalEstimated ? `≥${n(page.total)}` : n(page.total);
      return {
        ok: true,
        kind: PARLIAMENT_MCP_KINDS.stenogramSessions,
        query: { q, chamber, from, to, year, availability, mandateKey, limit },
        link: `${clientBaseUrl}/parlament/stenograme`,
        items: page.items,
        meta: {
          total: page.total,
          totalEstimated: page.totalEstimated,
          hasNextPage: page.next !== null,
          nextCursor: page.next,
          searchScope: q === undefined ? null : 'full_history_canonical_blocks',
        },
        summary: `${count} sitting(s); showing ${n(page.items.length)}${
          q === undefined ? '' : ' matched across the full canonical transcript history'
        }.`,
      };
    },
  };

  const stenogramTranscriptTool: KernelMcpTool = {
    name: 'get_parliament_stenogram_session',
    description:
      "Read one sitting's canonical transcript: the ordered reading blocks in OFFICIAL printed order, each with its kind (SPEECH / AGENDA_HEADING / VOTE_RESULT / CONTEXT), the speaker name AS PRINTED, the roster-validated mandateKey when the source printed a member id (null for guests/ministers — never guessed from a name), the agenda reference in scope, and per-block source precision. Large sittings are paged with offset/limit (read meta.totalSegments). Fails with TRANSCRIPT_UNAVAILABLE when the sitting is real but yields no reading (a SOURCE_ONLY capture), and NOT_FOUND when there is no such sitting.",
    inputShape: getParliamentStenogramSessionInput,
    async handler(args): Promise<McpToolOutput> {
      const sessionKey = strArg(args, 'sessionKey');
      if (sessionKey === undefined) {
        return errorOut(PARLIAMENT_MCP_KINDS.stenogramTranscript, 'sessionKey is required');
      }
      const offset = Math.max(intArg(args, 'offset', 0), 0);
      // A tighter default than REST/GraphQL: an MCP result is read by a model, so the
      // block budget per call is deliberately small.
      const limit = Math.min(Math.max(intArg(args, 'limit', 100), 1), 500);
      const res = await getParliamentStenogramSession(deps, sessionKey, { offset, limit });
      if (res.isErr()) {
        return stenogramErrorOut(PARLIAMENT_MCP_KINDS.stenogramTranscript, res.error);
      }
      const { session, segments, totalSegments, navigation } = res.value;
      const shown = offset + segments.length;
      return {
        ok: true,
        kind: PARLIAMENT_MCP_KINDS.stenogramTranscript,
        query: { sessionKey, offset, limit },
        link: session.sourceUrl,
        item: { session, segments, navigation },
        meta: {
          totalSegments,
          offset,
          returned: segments.length,
          hasMore: shown < totalSegments,
          availability: session.availability,
          sourceUrlKind: session.sourceUrlKind,
          canonicalDigest: session.canonicalDigest,
          // Chamber-scoped neighbours, so an agent can walk a chamber's sittings
          // without re-deriving the ordering.
          previousSessionKey: navigation.previous?.sessionKey ?? null,
          nextSessionKey: navigation.next?.sessionKey ?? null,
        },
        summary:
          `${session.title ?? sessionKey} (${session.chamber}, ${session.sessionDate ?? 'undated'}): ` +
          `blocks ${n(offset)}–${n(shown)} of ${n(totalSegments)}, ${n(session.speechCount)} speeches by ${n(session.speakerCount)} speaker(s).`,
      };
    },
  };

  const speechContextTool: KernelMcpTool = {
    name: 'get_parliament_speech_context',
    description:
      "Place one contribution in its sitting: the canonical reading block, the sitting it belongs to, and the previous/next CONTRIBUTION (the neighbouring speeches, not the adjacent narration). Accepts a canonical 'canon:' key OR a LEGACY 'cdep:'/'senat:' key — a legacy key is resolved through the speech redirects, so an old link still lands on the canonical reading; when only the sitting could be proven, the block is null and the redirect says 'session_only'. Returns no item (never an error) for a key the canonical lane has not mapped.",
    inputShape: getParliamentSpeechContextInput,
    async handler(args): Promise<McpToolOutput> {
      const speechKey = strArg(args, 'speechKey');
      if (speechKey === undefined) {
        return errorOut(PARLIAMENT_MCP_KINDS.speechContext, 'speechKey is required');
      }
      const res = await getParliamentSpeechContext(deps, speechKey);
      if (res.isErr()) return stenogramErrorOut(PARLIAMENT_MCP_KINDS.speechContext, res.error);
      const context = res.value;
      if (context === null) {
        return {
          ok: true,
          kind: PARLIAMENT_MCP_KINDS.speechContext,
          query: { speechKey },
          summary: `No canonical stenogram context for speech ${speechKey} (unknown key, or not mapped to a canonical reading yet).`,
        };
      }
      const redirected = context.redirect !== null;
      return {
        ok: true,
        kind: PARLIAMENT_MCP_KINDS.speechContext,
        query: { speechKey },
        link: context.segment?.sourceUrl ?? context.session.sourceUrl,
        item: context,
        meta: {
          redirected,
          mappingKind: context.redirect?.mappingKind ?? null,
          position: context.segment?.position ?? null,
          sessionKey: context.session.sessionKey,
          sittingKey: context.session.sittingKey,
          speechCount: context.session.speechCount,
        },
        summary:
          (redirected ? `Legacy key ${speechKey} redirected to ` : '') +
          (context.segment !== null
            ? `block ${n(context.segment.position)} of ${context.session.sessionKey}` +
              ` (${context.segment.speakerName ?? 'unattributed'}), ` +
              (context.previousContribution === null ? 'first' : 'with a previous') +
              ` contribution and ${context.nextContribution === null ? 'no next' : 'a next'} one.`
            : `sitting ${context.session.sessionKey} only — no single reading block could be proven for this legacy row.`),
      };
    },
  };

  return [
    resolveTool,
    lineageTool,
    activityTool,
    cohesionTool,
    speechesTool,
    stenogramSessionsTool,
    stenogramTranscriptTool,
    speechContextTool,
  ];
};
