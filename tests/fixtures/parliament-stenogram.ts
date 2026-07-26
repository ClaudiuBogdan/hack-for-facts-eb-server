/**
 * In-memory fakes for the canonical stenogram surface (no DB, no mocking library —
 * the repo convention).
 *
 * The fake repo stores rows WITH their `privacy_class` and applies the SAME visibility
 * rules the SQL does (public session AND public block AND public redirect, with a
 * restricted row indistinguishable from an absent one). That is deliberate: it lets a
 * surface test prove that a restricted row never reaches a response body, which is the
 * property that actually matters. The proof that the REAL repo emits those predicates
 * in SQL is separate — `tests/unit/parliament/stenogram-repo-sql.test.ts` compiles the
 * Kysely queries and asserts the predicates directly.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  toStenogramSessionRef,
  type ParliamentSpeechRedirect,
  type ParliamentStenogramError,
  type ParliamentStenogramSegment,
  type ParliamentStenogramSession,
} from '@/modules/parliament/core/types.js';

import type {
  ParliamentRepo,
  ParliamentStenogramRepo,
  ParliamentTranscriptSearchPort,
} from '@/modules/parliament/core/ports.js';
import type { CursorPage, CursorPageRequest, FilterInput } from '@/modules/shared/index.js';

/** A stored session + its `privacy_class` (the column the API gates on). */
export interface FakeSessionRow {
  readonly session: ParliamentStenogramSession;
  readonly privacyClass?: 'public' | 'restricted';
}
export interface FakeSegmentRow {
  readonly segment: ParliamentStenogramSegment;
  readonly privacyClass?: 'public' | 'restricted';
}
export interface FakeRedirectRow {
  readonly redirect: ParliamentSpeechRedirect;
  readonly privacyClass?: 'public' | 'restricted';
}

export interface FakeStenogramData {
  readonly sessions?: readonly FakeSessionRow[];
  readonly segments?: readonly FakeSegmentRow[];
  readonly redirects?: readonly FakeRedirectRow[];
  /** false → every method reports `projection_unavailable` (the pre-migration state). */
  readonly projectionAvailable?: boolean;
  /** false → the three additive `parliament.speeches` columns are not selectable. */
  readonly canonicalColumnsAvailable?: boolean;
  /**
   * Canonical `parliament.speeches` keys that are RESTRICTED or quarantined. The
   * speech row's `privacy_class` is independent of its block's, so a public block whose
   * canonical speech row is restricted must not be served — this models that.
   */
  readonly restrictedCanonicalSpeechKeys?: readonly string[];
  /**
   * When set, every repo method fails with this error instead of answering. Used to
   * prove a transport/DB failure PROPAGATES rather than being flattened into
   * "not found" / "no context" / "no matches".
   */
  readonly failWith?: ParliamentStenogramError;
}

export const stenogramSession = (
  over: Partial<ParliamentStenogramSession> = {}
): ParliamentStenogramSession => ({
  sessionKey: 'cdep:9043',
  chamber: 'camera_deputatilor',
  sessionDate: '2003-09-29',
  sessionDateSource: 'stenogram_title',
  title: 'Ședința Camerei Deputaților din 29 septembrie 2003',
  sourceSystem: 'cdep_stenogram',
  availability: 'COMPLETE',
  sourceUrl: 'https://www.cdep.ro/pls/steno/steno2015.stenograma?ids=9043',
  sourceUrlKind: 'exact',
  sittingKey: 'sitting:cdep:2003-09-29',
  presidingText: 'Valer Dorneanu',
  startTimeText: '9.00',
  endTimeText: '13.30',
  segmentCount: 3,
  speechCount: 2,
  speakerCount: 2,
  captureDigest: 'capture-digest-9043',
  canonicalDigest: 'canonical-digest-9043',
  sourceUpdatedAt: '2026-07-20T04:31:00.000Z',
  ...over,
});

export const stenogramSegment = (
  over: Partial<ParliamentStenogramSegment> = {}
): ParliamentStenogramSegment => {
  const sessionKey = over.sessionKey ?? 'cdep:9043';
  const position = over.position ?? 0;
  return {
    segmentKey: `${sessionKey}#${String(position).padStart(5, '0')}`,
    sessionKey,
    position,
    kind: 'SPEECH',
    text: 'Vă rog să luați loc.',
    textChars: 'Vă rog să luați loc.'.length,
    speakerName: 'Valer Dorneanu',
    speakerRef: '42',
    mandateKey: '2:2000:42',
    speechKey: `canon:${sessionKey}#${String(position).padStart(5, '0')}`,
    agendaRef: 'S1',
    sourceUrl: 'https://www.cdep.ro/pls/steno/steno2015.stenograma?ids=9043',
    sourceUrlKind: 'exact',
    ...over,
  };
};

/** A reading block of `n` sequential positions, alternating SPEECH and CONTEXT. */
export const stenogramReading = (
  count: number,
  sessionKey = 'cdep:9043'
): ParliamentStenogramSegment[] =>
  Array.from({ length: count }, (_v, i) =>
    stenogramSegment({
      sessionKey,
      position: i,
      kind: i % 2 === 0 ? 'SPEECH' : 'CONTEXT',
      text: `Block ${String(i)} of the printed transcript.`,
      textChars: `Block ${String(i)} of the printed transcript.`.length,
      speakerName: i % 2 === 0 ? `Speaker ${String(i)}` : null,
      speakerRef: i % 2 === 0 ? String(100 + i) : null,
      mandateKey: i % 2 === 0 ? `2:2000:${String(100 + i)}` : null,
      speechKey: i % 2 === 0 ? `canon:${sessionKey}#${String(i).padStart(5, '0')}` : null,
    })
  );

const isPublic = (klass: 'public' | 'restricted' | undefined): boolean =>
  (klass ?? 'public') === 'public';

/** The canonical-stenogram slice of the repo, in memory. */
export const makeFakeStenogramRepo = (data: FakeStenogramData = {}): ParliamentStenogramRepo => {
  const projectionAvailable = data.projectionAvailable ?? true;
  const sessions = data.sessions ?? [];
  const segments = data.segments ?? [];
  const redirects = data.redirects ?? [];
  const restrictedSpeeches = new Set(data.restrictedCanonicalSpeechKeys ?? []);
  const failure = data.failWith;

  const unavailable = (sessionKey: string | null): ParliamentStenogramError => ({
    type: 'TranscriptUnavailable',
    message: 'the canonical stenogram projection is not available on this database',
    sessionKey,
    reason: 'projection_unavailable',
    session: null,
  });

  /** The gate every method passes through: injected failure, then availability. */
  const blocked = (sessionKey: string | null): ParliamentStenogramError | null =>
    failure ?? (projectionAvailable ? null : unavailable(sessionKey));

  const publicSession = (sessionKey: string): ParliamentStenogramSession | null =>
    sessions.find((r) => r.session.sessionKey === sessionKey && isPublic(r.privacyClass))
      ?.session ?? null;

  /**
   * Blocks visible for a session — ALL THREE gates, exactly as the SQL applies them:
   * public block, public parent session, and (when the block names one) a public
   * canonical speech row.
   */
  const publicSegments = (sessionKey: string): ParliamentStenogramSegment[] =>
    publicSession(sessionKey) === null
      ? []
      : segments
          .filter(
            (r) =>
              r.segment.sessionKey === sessionKey &&
              isPublic(r.privacyClass) &&
              (r.segment.speechKey === null || !restrictedSpeeches.has(r.segment.speechKey))
          )
          .map((r) => r.segment)
          .sort((a, b) => a.position - b.position);

  return {
    canonicalSpeechColumnsAvailable: () =>
      Promise.resolve(data.canonicalColumnsAvailable ?? projectionAvailable),
    stenogramProjectionAvailable: () => Promise.resolve(projectionAvailable),

    listStenogramSessions: (
      page: CursorPageRequest,
      filter: FilterInput,
      _q: string | undefined,
      sessionKeys: readonly string[] | undefined
    ): Promise<
      Result<
        CursorPage<ParliamentStenogramSession> & { total: number; totalEstimated: boolean },
        ParliamentStenogramError
      >
    > => {
      const gate = blocked(null);
      if (gate !== null) return Promise.resolve(err(gate));
      let visible = sessions.filter((r) => isPublic(r.privacyClass)).map((r) => r.session);
      if (sessionKeys !== undefined) {
        const allow = new Set(sessionKeys);
        visible = visible.filter((s) => allow.has(s.sessionKey));
      }
      const chamberEq = (filter['chamber'] as { eq?: string } | undefined)?.eq;
      if (chamberEq !== undefined) visible = visible.filter((s) => s.chamber === chamberEq);
      // The repo's keyset order: sessionDate desc (null last), sessionKey desc.
      visible.sort((a, b) => {
        const da = a.sessionDate ?? '';
        const db = b.sessionDate ?? '';
        if (da !== db) return da < db ? 1 : -1;
        return a.sessionKey < b.sessionKey ? 1 : -1;
      });
      const start =
        page.after === undefined
          ? 0
          : visible.findIndex((s) => s.sessionKey === decodeFakeCursor(page.after)) + 1;
      const slice = visible.slice(start, start + page.first);
      const last = slice.at(-1);
      const hasMore = start + slice.length < visible.length;
      return Promise.resolve(
        ok({
          items: slice,
          next: hasMore && last !== undefined ? encodeFakeCursor(last.sessionKey) : null,
          total: visible.length,
          totalEstimated: false,
        })
      );
    },

    findStenogramSession: (sessionKey: string) => {
      const gate = blocked(sessionKey);
      return Promise.resolve(gate !== null ? err(gate) : ok(publicSession(sessionKey)));
    },

    listStenogramSegments: (sessionKey: string, slice: { offset: number; limit: number }) => {
      const gate = blocked(sessionKey);
      if (gate !== null) return Promise.resolve(err(gate));
      const all = publicSegments(sessionKey);
      return Promise.resolve(
        ok({ segments: all.slice(slice.offset, slice.offset + slice.limit), total: all.length })
      );
    },

    adjacentSessions: (anchor: {
      sessionKey: string;
      sessionDate: string | null;
      chamber: string;
    }) => {
      const gate = blocked(anchor.sessionKey);
      if (gate !== null) return Promise.resolve(err(gate));
      // The repo's keyset, chamber-scoped and public-only: compare the coalesced
      // (date, key) tuple exactly as the SQL does.
      const tuple = (s: ParliamentStenogramSession): string =>
        `${s.sessionDate ?? ''} ${s.sessionKey}`;
      const anchorTuple = `${anchor.sessionDate ?? ''} ${anchor.sessionKey}`;
      const siblings = sessions
        .filter((r) => isPublic(r.privacyClass) && r.session.chamber === anchor.chamber)
        .map((r) => r.session)
        .sort((a, b) => (tuple(a) < tuple(b) ? -1 : tuple(a) > tuple(b) ? 1 : 0));
      const before = siblings.filter((s) => tuple(s) < anchorTuple);
      const after = siblings.filter((s) => tuple(s) > anchorTuple);
      return Promise.resolve(
        ok({
          previous: before.length > 0 ? toStenogramSessionRef(before[before.length - 1]!) : null,
          next: after.length > 0 ? toStenogramSessionRef(after[0]!) : null,
        })
      );
    },

    findSegmentBySpeechKey: (speechKey: string) => {
      const gate = blocked(null);
      if (gate !== null) return Promise.resolve(err(gate));
      const row = segments.find(
        (r) => r.segment.speechKey === speechKey && isPublic(r.privacyClass)
      );
      const visible =
        row !== undefined &&
        publicSession(row.segment.sessionKey) !== null &&
        (row.segment.speechKey === null || !restrictedSpeeches.has(row.segment.speechKey))
          ? row.segment
          : null;
      return Promise.resolve(ok(visible));
    },

    findSegmentByKey: (segmentKey: string) => {
      const gate = blocked(null);
      if (gate !== null) return Promise.resolve(err(gate));
      const row = segments.find(
        (r) => r.segment.segmentKey === segmentKey && isPublic(r.privacyClass)
      );
      const visible =
        row !== undefined &&
        publicSession(row.segment.sessionKey) !== null &&
        (row.segment.speechKey === null || !restrictedSpeeches.has(row.segment.speechKey))
          ? row.segment
          : null;
      return Promise.resolve(ok(visible));
    },

    canonicalSpeechIsPublic: (speechKey: string) => {
      const gate = blocked(null);
      return Promise.resolve(gate !== null ? err(gate) : ok(!restrictedSpeeches.has(speechKey)));
    },

    findSpeechRedirect: (legacySpeechKey: string) => {
      const gate = blocked(null);
      if (gate !== null) return Promise.resolve(err(gate));
      return Promise.resolve(
        ok(
          redirects.find(
            (r) => r.redirect.legacySpeechKey === legacySpeechKey && isPublic(r.privacyClass)
          )?.redirect ?? null
        )
      );
    },

    adjacentContributions: (sessionKey: string, position: number) => {
      const gate = blocked(sessionKey);
      if (gate !== null) return Promise.resolve(err(gate));
      // Previous/next CONTRIBUTION — SPEECH blocks only, never the adjacent block.
      const speeches = publicSegments(sessionKey).filter((s) => s.kind === 'SPEECH');
      return Promise.resolve(
        ok({
          previous: [...speeches].reverse().find((s) => s.position < position) ?? null,
          next: speeches.find((s) => s.position > position) ?? null,
        })
      );
    },
  };
};

/** Opaque-enough cursor for the fake (the REAL cursor contract is kernel-tested). */
const encodeFakeCursor = (sessionKey: string): string =>
  Buffer.from(`fake:${sessionKey}`, 'utf8').toString('base64url');
const decodeFakeCursor = (cursor: string | undefined): string =>
  cursor === undefined ? '' : Buffer.from(cursor, 'base64url').toString('utf8').slice(5);

/**
 * A full `ParliamentRepo` whose stenogram slice is the fake above and whose every
 * other method THROWS — so a test that accidentally reaches an unrelated read fails
 * loudly instead of silently passing (the `makeRepo` proxy pattern already used by
 * tests/unit/parliament/global-speeches.test.ts).
 */
export const makeFakeParliamentRepo = (
  data: FakeStenogramData = {},
  over: Partial<ParliamentRepo> = {}
): ParliamentRepo => {
  const stenogram = makeFakeStenogramRepo(data);
  return new Proxy({} as ParliamentRepo, {
    get(_t, prop: string) {
      if (prop in over) return over[prop as keyof ParliamentRepo];
      if (prop in stenogram) return stenogram[prop as keyof ParliamentStenogramRepo];
      return (): never => {
        throw new Error(`unexpected repo call: ${prop}`);
      };
    },
  });
};

/**
 * A transcript search projection fake. `available:false` is the state that must produce
 * SEARCH_UNAVAILABLE — never a title-only fallback — and `reason` distinguishes an
 * unreadable `search.documents` from a doc type that was simply never built.
 *
 * `hits` is a session list (already grouped and ranked, as the real port returns), so a
 * test cannot accidentally assert on a doc-level shape the port never emits.
 */
export const makeFakeTranscriptSearch = (opts: {
  readonly available: boolean;
  readonly reason?: 'ok' | 'relation_unavailable' | 'doc_type_unbuilt';
  readonly hits?: readonly { readonly sessionKey: string; readonly matchedBlocks: number }[];
  readonly truncated?: boolean;
  readonly docType?: string;
  readonly onSearch?: (q: string) => void;
  /** When set, the search itself fails — it must NOT read as "no matches". */
  readonly failWith?: ParliamentStenogramError;
}): ParliamentTranscriptSearchPort => ({
  docType: opts.docType ?? 'parliament_speech_segment',
  available: () =>
    Promise.resolve({
      available: opts.available,
      reason: opts.reason ?? (opts.available ? 'ok' : 'doc_type_unbuilt'),
    }),
  searchSessionKeys: (q: string) => {
    opts.onSearch?.(q);
    if (opts.failWith !== undefined) return Promise.resolve(err(opts.failWith));
    return Promise.resolve(ok({ sessions: opts.hits ?? [], truncated: opts.truncated ?? false }));
  },
});
