/**
 * Canonical stenogram USECASES over in-memory fakes (no DB).
 *
 * These are the flow-level tests: every surface (GraphQL, MCP, REST) calls exactly
 * these three usecases, so the decisions proven here — typed errors, redirect
 * resolution, public-only visibility, the explicit search refusal — hold on all of
 * them by construction.
 */

import { describe, expect, it } from 'vitest';

import {
  getParliamentSpeechContext,
  getParliamentStenogramSession,
  getParliamentStenogramTranscript,
  listParliamentStenogramSessions,
  STENOGRAM_SEGMENT_PAGE_DEFAULT,
  STENOGRAM_SEGMENT_PAGE_MAX,
  STENOGRAM_TRANSCRIPT_CHUNK,
  type ParliamentStenogramUsecaseDeps,
} from '@/modules/parliament/core/usecases.js';

import {
  makeFakeParliamentRepo,
  makeFakeTranscriptSearch,
  stenogramReading,
  stenogramSegment,
  stenogramSession,
  type FakeStenogramData,
} from '../../fixtures/parliament-stenogram.js';

import type { ParliamentTranscriptSearchPort } from '@/modules/parliament/core/ports.js';

/** The regression key from the contract: it MUST resolve, and MUST never crash. */
const LEGACY_KEY = 'cdep:cdep_stenogram:9043:9:718';

/** A search hit as the port emits it: a SITTING plus its per-sitting block count. */
const hit = (sessionKey: string, matchedBlocks: number) => ({ sessionKey, matchedBlocks });

const deps = (
  data: FakeStenogramData = {},
  transcriptSearch: ParliamentTranscriptSearchPort | null = null
): ParliamentStenogramUsecaseDeps => ({
  repo: makeFakeParliamentRepo(data),
  meili: null,
  transcriptSearch,
});

const COMPLETE_SESSION: FakeStenogramData = {
  sessions: [{ session: stenogramSession() }],
  segments: stenogramReading(3).map((segment) => ({ segment })),
};

describe('getParliamentStenogramSession — typed outcomes are distinct', () => {
  it('returns the session plus its blocks in OFFICIAL printed order', async () => {
    const r = await getParliamentStenogramSession(deps(COMPLETE_SESSION), 'cdep:9043');
    expect(r.isOk()).toBe(true);
    const value = r._unsafeUnwrap();
    expect(value.session.sessionKey).toBe('cdep:9043');
    expect(value.totalSegments).toBe(3);
    expect(value.segments.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it('NOT_FOUND for an unknown session key', async () => {
    const r = await getParliamentStenogramSession(deps(COMPLETE_SESSION), 'cdep:does-not-exist');
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().type).toBe('NotFound');
  });

  it('NOT_FOUND — not a leak — for a RESTRICTED session (indistinguishable from absent)', async () => {
    const r = await getParliamentStenogramSession(
      deps({
        sessions: [{ session: stenogramSession(), privacyClass: 'restricted' }],
        segments: stenogramReading(3).map((segment) => ({ segment })),
      }),
      'cdep:9043'
    );
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().type).toBe('NotFound');
  });

  it('TRANSCRIPT_UNAVAILABLE/source_only for a SOURCE_ONLY capture — never NotFound', async () => {
    const r = await getParliamentStenogramSession(
      deps({
        sessions: [
          {
            session: stenogramSession({
              availability: 'SOURCE_ONLY',
              segmentCount: 0,
              speechCount: 0,
              speakerCount: 0,
            }),
          },
        ],
      }),
      'cdep:9043'
    );
    expect(r.isErr()).toBe(true);
    const error = r._unsafeUnwrapErr();
    expect(error.type).toBe('TranscriptUnavailable');
    if (error.type === 'TranscriptUnavailable') {
      expect(error.reason).toBe('source_only');
      expect(error.sessionKey).toBe('cdep:9043');
      // The sitting is real: the caller can still reach the official transcript.
      expect(error.message).toContain('source URL');
    }
  });

  it('TRANSCRIPT_UNAVAILABLE/no_public_segments when every block is restricted', async () => {
    const r = await getParliamentStenogramSession(
      deps({
        sessions: [{ session: stenogramSession() }],
        segments: stenogramReading(3).map((segment) => ({
          segment,
          privacyClass: 'restricted' as const,
        })),
      }),
      'cdep:9043'
    );
    expect(r.isErr()).toBe(true);
    const error = r._unsafeUnwrapErr();
    expect(error.type).toBe('TranscriptUnavailable');
    if (error.type === 'TranscriptUnavailable') expect(error.reason).toBe('no_public_segments');
  });

  it('TRANSCRIPT_UNAVAILABLE/projection_unavailable when the canonical migration is absent', async () => {
    const r = await getParliamentStenogramSession(
      deps({ ...COMPLETE_SESSION, projectionAvailable: false }),
      'cdep:9043'
    );
    expect(r.isErr()).toBe(true);
    const error = r._unsafeUnwrapErr();
    expect(error.type).toBe('TranscriptUnavailable');
    if (error.type === 'TranscriptUnavailable') expect(error.reason).toBe('projection_unavailable');
  });

  it('INVALID_INPUT for a blank session key (never a full-table read)', async () => {
    const r = await getParliamentStenogramSession(deps(COMPLETE_SESSION), '   ');
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().type).toBe('InvalidInput');
  });
});

describe('getParliamentStenogramSession — a LARGE ordered transcript pages without losing order', () => {
  const LARGE = 1_500;
  const large: FakeStenogramData = {
    sessions: [{ session: stenogramSession({ segmentCount: LARGE, speechCount: LARGE / 2 }) }],
    segments: stenogramReading(LARGE).map((segment) => ({ segment })),
  };

  it('caps a read at the default page size and reports the FULL total', async () => {
    const r = await getParliamentStenogramSession(deps(large), 'cdep:9043');
    const value = r._unsafeUnwrap();
    expect(value.segments).toHaveLength(STENOGRAM_SEGMENT_PAGE_DEFAULT);
    expect(value.totalSegments).toBe(LARGE);
    expect(value.segments[0]?.position).toBe(0);
    expect(value.segments.at(-1)?.position).toBe(STENOGRAM_SEGMENT_PAGE_DEFAULT - 1);
  });

  it('walks the whole reading, contiguously and in order, across pages', async () => {
    const seen: number[] = [];
    for (let offset = 0; offset < LARGE; offset += 500) {
      const page = await getParliamentStenogramSession(deps(large), 'cdep:9043', {
        offset,
        limit: 500,
      });
      seen.push(...page._unsafeUnwrap().segments.map((s) => s.position));
    }
    // No gaps, no duplicates, no reordering — the printed order is the contract.
    expect(seen).toEqual(Array.from({ length: LARGE }, (_v, i) => i));
  });

  it('clamps an over-large limit to the documented maximum', async () => {
    const r = await getParliamentStenogramSession(deps(large), 'cdep:9043', { limit: 99_999 });
    expect(r._unsafeUnwrap().segments.length).toBeLessThanOrEqual(STENOGRAM_SEGMENT_PAGE_MAX);
  });
});

describe('sitting navigation — deterministic, chamber-scoped, public-only', () => {
  /**
   * Two CDep sittings around the anchor, plus a joint sitting between them. EVERY
   * sitting gets its own reading, so a navigation assertion is never confounded by an
   * unrelated `no_public_segments` refusal.
   */
  const neighbours: FakeStenogramData = {
    sessions: [
      { session: stenogramSession({ sessionKey: 'cdep:9000', sessionDate: '2003-09-22' }) },
      { session: stenogramSession() }, // cdep:9043 @ 2003-09-29
      { session: stenogramSession({ sessionKey: 'cdep:9100', sessionDate: '2003-10-06' }) },
      {
        session: stenogramSession({
          sessionKey: 'comun:77',
          sessionDate: '2003-09-30',
          chamber: 'comun',
        }),
      },
    ],
    segments: ['cdep:9000', 'cdep:9043', 'cdep:9100', 'comun:77'].flatMap((sessionKey) =>
      stenogramReading(3, sessionKey).map((segment) => ({ segment }))
    ),
  };

  it('resolves the immediate chamber neighbours and SKIPS the closer joint sitting', async () => {
    const r = await getParliamentStenogramSession(deps(neighbours), 'cdep:9043');
    const nav = r._unsafeUnwrap().navigation;
    expect(nav.previous?.sessionKey).toBe('cdep:9000');
    // comun:77 is chronologically nearer than cdep:9100 but a DIFFERENT assembly.
    expect(nav.next?.sessionKey).toBe('cdep:9100');
  });

  it('is null at the ends of a chamber history', async () => {
    const first = await getParliamentStenogramSession(deps(neighbours), 'cdep:9000');
    expect(first._unsafeUnwrap().navigation.previous).toBeNull();
    expect(first._unsafeUnwrap().navigation.next?.sessionKey).toBe('cdep:9043');

    const last = await getParliamentStenogramSession(deps(neighbours), 'cdep:9100');
    expect(last._unsafeUnwrap().navigation.next).toBeNull();
    expect(last._unsafeUnwrap().navigation.previous?.sessionKey).toBe('cdep:9043');
  });

  it('never surfaces a RESTRICTED neighbour — it steps over it to the next public one', async () => {
    const r = await getParliamentStenogramSession(
      deps({
        sessions: [
          { session: stenogramSession({ sessionKey: 'cdep:8900', sessionDate: '2003-09-15' }) },
          {
            session: stenogramSession({ sessionKey: 'cdep:9000', sessionDate: '2003-09-22' }),
            privacyClass: 'restricted',
          },
          { session: stenogramSession() },
        ],
        segments: ['cdep:8900', 'cdep:9000', 'cdep:9043'].flatMap((sessionKey) =>
          stenogramReading(3, sessionKey).map((segment) => ({ segment }))
        ),
      }),
      'cdep:9043'
    );
    // The restricted sitting is absent, not a hole a caller could probe for.
    expect(r._unsafeUnwrap().navigation.previous?.sessionKey).toBe('cdep:8900');
  });

  it('gives a dateless capture a DEFINED place under the same coalesced keyset', async () => {
    const r = await getParliamentStenogramSession(
      deps({
        sessions: [
          { session: stenogramSession() }, // 2003-09-29
          {
            session: stenogramSession({
              sessionKey: 'cdep:9999',
              sessionDate: null,
              sessionDateSource: 'none',
            }),
          },
        ],
        segments: ['cdep:9043', 'cdep:9999'].flatMap((sessionKey) =>
          stenogramReading(3, sessionKey).map((segment) => ({ segment }))
        ),
      }),
      'cdep:9999'
    );
    // A dateless capture coalesces to '' — it sorts BEFORE every dated sitting on the
    // ascending tuple, i.e. LAST on the list's descending order. Either way its place
    // is defined, which is the property that matters for a stable control.
    expect(r._unsafeUnwrap().navigation.previous).toBeNull();
    expect(r._unsafeUnwrap().navigation.next?.sessionKey).toBe('cdep:9043');
  });

  it('rides along with a SOURCE_ONLY refusal (the sitting still has neighbours)', async () => {
    const r = await getParliamentStenogramSession(
      deps({
        sessions: [
          { session: stenogramSession({ sessionKey: 'cdep:9000', sessionDate: '2003-09-22' }) },
          {
            session: stenogramSession({
              availability: 'SOURCE_ONLY',
              segmentCount: 0,
              speechCount: 0,
              speakerCount: 0,
            }),
          },
        ],
      }),
      'cdep:9043'
    );
    // The refusal still carries the sitting ref for the source action…
    expect(r.isErr()).toBe(true);
    const error = r._unsafeUnwrapErr();
    if (error.type === 'TranscriptUnavailable') {
      expect(error.session?.sourceUrl).toContain('https://');
      expect(error.session?.availability).toBe('SOURCE_ONLY');
    }
  });
});

describe('getParliamentStenogramTranscript — the COMPLETE reading, never a truncation', () => {
  const sitting = (count: number): FakeStenogramData => ({
    sessions: [{ session: stenogramSession({ segmentCount: count }) }],
    segments: stenogramReading(count).map((segment) => ({ segment })),
  });

  it('returns every block of a sitting LARGER than the internal chunk, contiguously', async () => {
    const count = STENOGRAM_TRANSCRIPT_CHUNK * 2 + 137;
    const r = await getParliamentStenogramTranscript(deps(sitting(count)), 'cdep:9043');
    const value = r._unsafeUnwrap();

    expect(value.segments).toHaveLength(count);
    expect(value.totalSegments).toBe(count);
    // No gaps, no duplicates, no reordering across the internal page boundaries.
    expect(value.segments.map((s) => s.position)).toEqual(
      Array.from({ length: count }, (_v, i) => i)
    );
  });

  it('agrees exactly with walking the SLICED read page by page', async () => {
    const count = STENOGRAM_TRANSCRIPT_CHUNK + 500;
    const data = sitting(count);
    const complete = await getParliamentStenogramTranscript(deps(data), 'cdep:9043');

    const walked: number[] = [];
    for (let offset = 0; offset < count; offset += 500) {
      const page = await getParliamentStenogramSession(deps(data), 'cdep:9043', {
        offset,
        limit: 500,
      });
      walked.push(...page._unsafeUnwrap().segments.map((s) => s.position));
    }
    expect(complete._unsafeUnwrap().segments.map((s) => s.position)).toEqual(walked);
  });

  it('carries the same navigation and typed refusals as the sliced read', async () => {
    const sourceOnly: FakeStenogramData = {
      sessions: [
        {
          session: stenogramSession({
            availability: 'SOURCE_ONLY',
            segmentCount: 0,
            speechCount: 0,
            speakerCount: 0,
          }),
        },
      ],
    };
    const r = await getParliamentStenogramTranscript(deps(sourceOnly), 'cdep:9043');
    expect(r.isErr()).toBe(true);
    const error = r._unsafeUnwrapErr();
    expect(error.type).toBe('TranscriptUnavailable');
    if (error.type === 'TranscriptUnavailable') {
      expect(error.reason).toBe('source_only');
      expect(error.session?.sessionKey).toBe('cdep:9043');
    }
  });

  it('propagates a repo failure instead of returning a short transcript', async () => {
    const r = await getParliamentStenogramTranscript(
      deps({
        ...sitting(10),
        failWith: { type: 'Database', message: 'connection reset by peer' },
      }),
      'cdep:9043'
    );
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().type).toBe('Database');
  });
});

describe('getParliamentSpeechContext — canonical keys, legacy redirects, sitting navigation', () => {
  const reading = stenogramReading(7); // SPEECH at even positions, CONTEXT at odd

  it('resolves a CANONICAL key to its block and its neighbouring CONTRIBUTIONS', async () => {
    const r = await getParliamentSpeechContext(
      deps({
        sessions: [{ session: stenogramSession() }],
        segments: reading.map((segment) => ({ segment })),
      }),
      'canon:cdep:9043#00004'
    );
    const context = r._unsafeUnwrap();
    expect(context).not.toBeNull();
    expect(context?.segment?.position).toBe(4);
    // Positions 3 and 5 are CONTEXT blocks: the neighbours must be the SPEECH blocks
    // at 2 and 6, not the adjacent printed blocks.
    expect(context?.previousContribution?.position).toBe(2);
    expect(context?.nextContribution?.position).toBe(6);
    expect(context?.redirect).toBeNull();
    // Sitting navigation: the sitting spine link + counters ride on the session.
    expect(context?.session.sittingKey).toBe('sitting:cdep:2003-09-29');
    expect(context?.session.speechCount).toBeGreaterThan(0);
  });

  it('REGRESSION cdep:cdep_stenogram:9043:9:718 — an exact_segment redirect resolves the canonical context', async () => {
    const r = await getParliamentSpeechContext(
      deps({
        sessions: [{ session: stenogramSession() }],
        segments: reading.map((segment) => ({ segment })),
        redirects: [
          {
            redirect: {
              legacySpeechKey: LEGACY_KEY,
              sessionKey: 'cdep:9043',
              canonicalSpeechKey: 'canon:cdep:9043#00004',
              canonicalSegmentKey: 'cdep:9043#00004',
              canonicalPosition: 4,
              mappingKind: 'exact_segment',
              matchMethod: 'cdep_sitting_ids',
            },
          },
        ],
      }),
      LEGACY_KEY
    );
    expect(r.isOk()).toBe(true);
    const context = r._unsafeUnwrap();
    expect(context?.speechKey).toBe(LEGACY_KEY);
    expect(context?.segment?.segmentKey).toBe('cdep:9043#00004');
    expect(context?.session.sessionKey).toBe('cdep:9043');
    expect(context?.redirect?.mappingKind).toBe('exact_segment');
    expect(context?.redirect?.matchMethod).toBe('cdep_sitting_ids');
    expect(context?.previousContribution?.position).toBe(2);
  });

  it('REGRESSION cdep:cdep_stenogram:9043:9:718 — a session_only redirect resolves the SITTING, not a guessed turn', async () => {
    const r = await getParliamentSpeechContext(
      deps({
        sessions: [{ session: stenogramSession() }],
        segments: reading.map((segment) => ({ segment })),
        redirects: [
          {
            redirect: {
              legacySpeechKey: LEGACY_KEY,
              sessionKey: 'cdep:9043',
              canonicalSpeechKey: null,
              canonicalSegmentKey: null,
              canonicalPosition: null,
              mappingKind: 'session_only',
              matchMethod: 'cdep_sitting_ids',
            },
          },
        ],
      }),
      LEGACY_KEY
    );
    const context = r._unsafeUnwrap();
    expect(context?.session.sessionKey).toBe('cdep:9043');
    expect(context?.segment).toBeNull();
    expect(context?.previousContribution).toBeNull();
    expect(context?.nextContribution).toBeNull();
    expect(context?.redirect?.mappingKind).toBe('session_only');
  });

  it('REGRESSION cdep:cdep_stenogram:9043:9:718 — NEVER crashes when no redirect row exists', async () => {
    const r = await getParliamentSpeechContext(
      deps({ sessions: [{ session: stenogramSession() }] }),
      LEGACY_KEY
    );
    expect(r.isOk()).toBe(true);
    // Honest "not mapped yet" — not an error, not a throw, not a partial answer.
    expect(r._unsafeUnwrap()).toBeNull();
  });

  it('degrades to the sitting when a redirect points at a RESTRICTED block', async () => {
    const r = await getParliamentSpeechContext(
      deps({
        sessions: [{ session: stenogramSession() }],
        segments: [{ segment: stenogramSegment({ position: 4 }), privacyClass: 'restricted' }],
        redirects: [
          {
            redirect: {
              legacySpeechKey: LEGACY_KEY,
              sessionKey: 'cdep:9043',
              canonicalSpeechKey: 'canon:cdep:9043#00004',
              canonicalSegmentKey: 'cdep:9043#00004',
              canonicalPosition: 4,
              mappingKind: 'exact_segment',
              matchMethod: 'cdep_sitting_ids',
            },
          },
        ],
      }),
      LEGACY_KEY
    );
    const context = r._unsafeUnwrap();
    // The restricted block is absent from the answer; the legacy key still resolves.
    expect(context?.segment).toBeNull();
    expect(context?.session.sessionKey).toBe('cdep:9043');
  });

  it('returns null (not a leak) when the redirect names a RESTRICTED session', async () => {
    const r = await getParliamentSpeechContext(
      deps({
        sessions: [{ session: stenogramSession(), privacyClass: 'restricted' }],
        redirects: [
          {
            redirect: {
              legacySpeechKey: LEGACY_KEY,
              sessionKey: 'cdep:9043',
              canonicalSpeechKey: null,
              canonicalSegmentKey: null,
              canonicalPosition: null,
              mappingKind: 'session_only',
              matchMethod: 'cdep_sitting_ids',
            },
          },
        ],
      }),
      LEGACY_KEY
    );
    expect(r._unsafeUnwrap()).toBeNull();
  });

  it('ignores a RESTRICTED redirect row entirely', async () => {
    const r = await getParliamentSpeechContext(
      deps({
        sessions: [{ session: stenogramSession() }],
        redirects: [
          {
            redirect: {
              legacySpeechKey: LEGACY_KEY,
              sessionKey: 'cdep:9043',
              canonicalSpeechKey: null,
              canonicalSegmentKey: null,
              canonicalPosition: null,
              mappingKind: 'session_only',
              matchMethod: 'cdep_sitting_ids',
            },
            privacyClass: 'restricted',
          },
        ],
      }),
      LEGACY_KEY
    );
    expect(r._unsafeUnwrap()).toBeNull();
  });

  it('reports projection unavailability rather than pretending the key is unmapped', async () => {
    const r = await getParliamentSpeechContext(
      deps({ ...COMPLETE_SESSION, projectionAvailable: false }),
      LEGACY_KEY
    );
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().type).toBe('TranscriptUnavailable');
  });

  it('propagates a DATABASE failure — never flattens it into "no context"', async () => {
    const r = await getParliamentSpeechContext(
      deps({
        ...COMPLETE_SESSION,
        failWith: { type: 'Database', message: 'connection reset by peer' },
      }),
      LEGACY_KEY
    );
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().type).toBe('Database');
  });

  it("drops the highlight to session-only when the redirect's CANONICAL SPEECH row is restricted", async () => {
    const exactRedirect = {
      legacySpeechKey: LEGACY_KEY,
      sessionKey: 'cdep:9043',
      canonicalSpeechKey: 'canon:cdep:9043#00004',
      canonicalSegmentKey: 'cdep:9043#00004',
      canonicalPosition: 4,
      mappingKind: 'exact_segment',
      matchMethod: 'cdep_sitting_ids',
    };
    const r = await getParliamentSpeechContext(
      deps({
        sessions: [{ session: stenogramSession() }],
        segments: reading.map((segment) => ({ segment })),
        redirects: [{ redirect: exactRedirect }],
        // The BLOCK is public; the canonical speech row it points at is not. The two
        // carry independent privacy classes, and the stricter one must win.
        restrictedCanonicalSpeechKeys: ['canon:cdep:9043#00004'],
      }),
      LEGACY_KEY
    );
    const context = r._unsafeUnwrap();
    expect(context?.session.sessionKey).toBe('cdep:9043');
    expect(context?.segment).toBeNull();
    expect(context?.previousContribution).toBeNull();
    expect(context?.nextContribution).toBeNull();
    // The redirect ROW is still reported honestly — we just do not serve its target.
    expect(context?.redirect?.mappingKind).toBe('exact_segment');
  });

  it('refuses a canonical key whose own speech row is restricted', async () => {
    const r = await getParliamentSpeechContext(
      deps({
        sessions: [{ session: stenogramSession() }],
        segments: reading.map((segment) => ({ segment })),
        restrictedCanonicalSpeechKeys: ['canon:cdep:9043#00004'],
      }),
      'canon:cdep:9043#00004'
    );
    // No block, no redirect → no canonical context at all, rather than a leak.
    expect(r._unsafeUnwrap()).toBeNull();
  });
});

describe('listParliamentStenogramSessions — full-history q is answered or REFUSED, never narrowed', () => {
  const twoSessions: FakeStenogramData = {
    sessions: [
      { session: stenogramSession({ sessionKey: 'cdep:9043', sessionDate: '2003-09-29' }) },
      { session: stenogramSession({ sessionKey: 'cdep:9100', sessionDate: '2004-02-11' }) },
    ],
  };

  it('lists sessions newest-first with NO boundedness argument required', async () => {
    const r = await listParliamentStenogramSessions(deps(twoSessions), {
      filter: {},
      page: { first: 10 },
    });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().items.map((s) => s.sessionKey)).toEqual(['cdep:9100', 'cdep:9043']);
  });

  it('excludes RESTRICTED sessions from the list', async () => {
    const r = await listParliamentStenogramSessions(
      deps({
        sessions: [
          { session: stenogramSession({ sessionKey: 'cdep:9043' }) },
          {
            session: stenogramSession({ sessionKey: 'cdep:9100', sessionDate: '2004-02-11' }),
            privacyClass: 'restricted',
          },
        ],
      }),
      { filter: {}, page: { first: 10 } }
    );
    expect(r._unsafeUnwrap().items.map((s) => s.sessionKey)).toEqual(['cdep:9043']);
  });

  it('SEARCH_UNAVAILABLE when NO search port is wired — and the list is not silently returned', async () => {
    const r = await listParliamentStenogramSessions(deps(twoSessions, null), {
      filter: {},
      page: { first: 10 },
      q: 'buget',
    });
    expect(r.isErr()).toBe(true);
    const error = r._unsafeUnwrapErr();
    expect(error.type).toBe('SearchUnavailable');
    if (error.type === 'SearchUnavailable') {
      // The refusal names the projection, and says there is no fallback.
      expect(error.message).toContain('no title-only fallback');
    }
  });

  it('SEARCH_UNAVAILABLE naming the DOC TYPE when the projection was never built', async () => {
    const r = await listParliamentStenogramSessions(
      deps(twoSessions, makeFakeTranscriptSearch({ available: false, reason: 'doc_type_unbuilt' })),
      { filter: {}, page: { first: 10 }, q: 'buget' }
    );
    expect(r.isErr()).toBe(true);
    const error = r._unsafeUnwrapErr();
    expect(error.type).toBe('SearchUnavailable');
    if (error.type === 'SearchUnavailable') {
      expect(error.docType).toBe('parliament_speech_segment');
      expect(error.message).toContain('projection not built');
      expect(error.message).toContain('no title-only fallback');
    }
  });

  it('SEARCH_UNAVAILABLE naming the RELATION when search.documents is unreadable', async () => {
    const r = await listParliamentStenogramSessions(
      deps(
        twoSessions,
        makeFakeTranscriptSearch({ available: false, reason: 'relation_unavailable' })
      ),
      { filter: {}, page: { first: 10 }, q: 'buget' }
    );
    const error = r._unsafeUnwrapErr();
    expect(error.type).toBe('SearchUnavailable');
    // An operator must be able to tell "the index was never built" from "I cannot read
    // the index table" — they are different incidents.
    if (error.type === 'SearchUnavailable') {
      expect(error.message).toContain('search.documents is not readable');
    }
  });

  it('propagates a search FAILURE — never reports it as "no sitting matched"', async () => {
    const r = await listParliamentStenogramSessions(
      deps(
        twoSessions,
        makeFakeTranscriptSearch({
          available: true,
          failWith: { type: 'Database', message: 'search.documents read failed' },
        })
      ),
      { filter: {}, page: { first: 10 }, q: 'buget' }
    );
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().type).toBe('Database');
  });

  it('never calls the projection when there is no q (an unsearched list must not depend on it)', async () => {
    const asked: string[] = [];
    const r = await listParliamentStenogramSessions(
      deps(
        twoSessions,
        makeFakeTranscriptSearch({ available: false, onSearch: (q) => asked.push(q) })
      ),
      { filter: {}, page: { first: 10 } }
    );
    expect(r.isOk()).toBe(true);
    expect(asked).toEqual([]);
  });

  it('narrows to the resolved session keys — and an EMPTY hit set yields an EMPTY page', async () => {
    const narrowed = await listParliamentStenogramSessions(
      deps(
        twoSessions,
        makeFakeTranscriptSearch({ available: true, hits: [hit('cdep:9043', 12)] })
      ),
      { filter: {}, page: { first: 10 }, q: 'buget' }
    );
    expect(narrowed._unsafeUnwrap().items.map((s) => s.sessionKey)).toEqual(['cdep:9043']);

    const empty = await listParliamentStenogramSessions(
      deps(twoSessions, makeFakeTranscriptSearch({ available: true, hits: [] })),
      { filter: {}, page: { first: 10 }, q: 'nimic' }
    );
    // "Searched, nothing matched" — NOT an unfiltered list.
    expect(empty._unsafeUnwrap().items).toEqual([]);
    expect(empty._unsafeUnwrap().total).toBe(0);
  });

  it('flags the total as ESTIMATED when the projection truncated its hit set', async () => {
    const r = await listParliamentStenogramSessions(
      deps(
        twoSessions,
        makeFakeTranscriptSearch({
          available: true,
          hits: [hit('cdep:9043', 40), hit('cdep:9100', 3)],
          truncated: true,
        })
      ),
      { filter: {}, page: { first: 10 }, q: 'buget' }
    );
    expect(r._unsafeUnwrap().totalEstimated).toBe(true);
  });

  it('rejects an over-long q at the boundary rather than passing it to the projection', async () => {
    const asked: string[] = [];
    const r = await listParliamentStenogramSessions(
      deps(
        twoSessions,
        makeFakeTranscriptSearch({ available: true, onSearch: (q) => asked.push(q) })
      ),
      { filter: {}, page: { first: 10 }, q: 'x'.repeat(500) }
    );
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(asked).toEqual([]);
  });
});
