/**
 * Parliament unit tests — the GLOBAL speeches (stenograme) usecases over a MOCKED
 * port (no DB). Covers the boundedness truth table (mandateKey bound OR a fully-
 * bounded ≤366-day spokenAt window — the parliamentControlItems guard precedent),
 * the full-text depth decision threading (`wantFullText`), q normalization + the
 * length cap, the activity guards, findSpeech passthrough, and the pure
 * `spokenAtWindowDays` window math.
 */

import { ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  getParliamentSpeech,
  getParliamentSpeechActivity,
  hasSpeechesBound,
  listParliamentSpeeches,
  SPEECHES_FULLTEXT_WINDOW_MAX_DAYS,
  SPEECHES_MANDATE_KEYS_MAX,
  SPEECHES_WINDOW_MAX_DAYS,
  speechesFullTextEligible,
  spokenAtWindowDays,
  type ParliamentUsecaseDeps,
} from '@/modules/parliament/core/usecases.js';

import type { ParliamentRepo } from '@/modules/parliament/core/ports.js';
import type { ApiError, FilterInput } from '@/modules/shared/index.js';

const okp = <T>(v: T): Promise<Result<T, ApiError>> => Promise.resolve(ok(v));

/** A repo stub: every method rejects unless explicitly overridden (so a test that
 * hits an unexpected method fails loudly). */
const makeRepo = (over: Partial<ParliamentRepo>): ParliamentRepo => {
  const notImpl = (name: string) => (): never => {
    throw new Error(`unexpected repo call: ${name}`);
  };
  return new Proxy({} as ParliamentRepo, {
    get(_t, prop: string) {
      return over[prop as keyof ParliamentRepo] ?? notImpl(prop);
    },
  });
};

const deps = (repo: ParliamentRepo): ParliamentUsecaseDeps => ({ repo, meili: null });

const emptyPage = () =>
  okp({
    items: [],
    next: null,
    total: 0,
    totalEstimated: false,
    searchDepth: null,
    // The repo reports the APPLIED served population so the shell can fold it into
    // per-edge cursors; these usecase tests run under the pre-migration default.
    population: 'LEGACY' as const,
  });

const list = (filter: FilterInput, over: Partial<ParliamentRepo> = {}, q?: string) =>
  listParliamentSpeeches(deps(makeRepo(over)), { filter, page: { first: 20 }, q });

describe('spokenAtWindowDays — pure UTC window math', () => {
  it('computes an INCLUSIVE day span from a between range', () => {
    expect(
      spokenAtWindowDays({ spokenAt: { between: { from: '2025-01-01', to: '2025-01-01' } } })
    ).toBe(1);
    expect(
      spokenAtWindowDays({ spokenAt: { between: { from: '2025-01-01', to: '2025-12-31' } } })
    ).toBe(365);
  });

  it('computes the same span from gte+lte as from between', () => {
    expect(spokenAtWindowDays({ spokenAt: { gte: '2024-01-01', lte: '2024-12-31' } })).toBe(366); // leap year
    expect(
      spokenAtWindowDays({ spokenAt: { between: { from: '2024-01-01', to: '2024-12-31' } } })
    ).toBe(366);
  });

  it('takes the TIGHTEST bounds when gte/lte AND between are combined (they AND in SQL)', () => {
    expect(
      spokenAtWindowDays({
        spokenAt: {
          gte: '2025-01-01',
          lte: '2025-12-31',
          between: { from: '2025-06-01', to: '2025-06-30' },
        },
      })
    ).toBe(30);
  });

  it('returns null when either end is missing (gte-only / lte-only / between half-open)', () => {
    expect(spokenAtWindowDays({ spokenAt: { gte: '2025-01-01' } })).toBeNull();
    expect(spokenAtWindowDays({ spokenAt: { lte: '2025-12-31' } })).toBeNull();
    expect(spokenAtWindowDays({ spokenAt: { between: { from: '2025-01-01' } } })).toBeNull();
    expect(spokenAtWindowDays({ spokenAt: { between: { to: '2025-12-31' } } })).toBeNull();
  });

  it('returns null on malformed or impossible dates', () => {
    expect(spokenAtWindowDays({ spokenAt: { gte: 'yesterday', lte: '2025-12-31' } })).toBeNull();
    expect(spokenAtWindowDays({ spokenAt: { gte: '2025-1-1', lte: '2025-12-31' } })).toBeNull();
    // 2026-02-30 does not exist — Date.UTC would roll it to March; we reject it.
    expect(spokenAtWindowDays({ spokenAt: { gte: '2026-02-30', lte: '2026-03-31' } })).toBeNull();
  });

  it('returns null on an inverted window (from > to)', () => {
    expect(spokenAtWindowDays({ spokenAt: { gte: '2025-12-31', lte: '2025-01-01' } })).toBeNull();
  });

  it('returns null when spokenAt is absent or not an object', () => {
    expect(spokenAtWindowDays({})).toBeNull();
    expect(spokenAtWindowDays({ spokenAt: {} })).toBeNull();
  });
});

describe('hasSpeechesBound / speechesFullTextEligible — the boundedness truth table', () => {
  it('constants pin the documented contract', () => {
    expect(SPEECHES_WINDOW_MAX_DAYS).toBe(366);
    expect(SPEECHES_FULLTEXT_WINDOW_MAX_DAYS).toBe(92);
  });

  it('{} is NOT bound; chamber/q alone bound NOTHING', () => {
    expect(hasSpeechesBound({})).toBe(false);
    expect(hasSpeechesBound({ chamber: { eq: 'senat' } })).toBe(false);
    expect(hasSpeechesBound({ chamber: { in: ['senat', 'comun'] } })).toBe(false);
  });

  it('mandateKey eq/in with a real value IS bound', () => {
    expect(hasSpeechesBound({ mandateKey: { eq: '2:2020:12' } })).toBe(true);
    expect(hasSpeechesBound({ mandateKey: { in: ['2:2020:12', '1:2024:1'] } })).toBe(true);
  });

  it('empty mandateKey shapes do NOT count (fieldHasValue semantics — Codex BLOCKER #1)', () => {
    expect(hasSpeechesBound({ mandateKey: {} })).toBe(false);
    expect(hasSpeechesBound({ mandateKey: { eq: '' } })).toBe(false);
    expect(hasSpeechesBound({ mandateKey: { in: [] } })).toBe(false);
  });

  it('an over-cap mandateKey in: list is NOT a bound (cardinality cap)', () => {
    const many = Array.from(
      { length: SPEECHES_MANDATE_KEYS_MAX + 1 },
      (_, i) => `2:2020:${String(i)}`
    );
    expect(hasSpeechesBound({ mandateKey: { in: many } })).toBe(false);
    expect(hasSpeechesBound({ mandateKey: { in: many.slice(0, SPEECHES_MANDATE_KEYS_MAX) } })).toBe(
      true
    );
    // duplicates dedupe BEFORE the cap: 21 copies of one key are still one bound.
    expect(hasSpeechesBound({ mandateKey: { in: many.map(() => '2:2020:12') } })).toBe(true);
  });

  it('a fully-bounded window ≤366 days IS bound; 367 is NOT', () => {
    expect(hasSpeechesBound({ spokenAt: { gte: '2024-01-01', lte: '2024-12-31' } })).toBe(true); // 366 (leap)
    expect(hasSpeechesBound({ spokenAt: { gte: '2023-01-01', lte: '2024-01-02' } })).toBe(false); // 367
  });

  it('full-text eligibility: EXACTLY ONE mandateKey; window only ≤92 days', () => {
    expect(speechesFullTextEligible({ mandateKey: { eq: '2:2020:12' } })).toBe(true);
    expect(speechesFullTextEligible({ mandateKey: { in: ['2:2020:12'] } })).toBe(true);
    // two mandates: still a BOUND (the list works) but NOT full-text eligible —
    // the ~35k-rows parity argument holds per mandate, not per in: list.
    expect(speechesFullTextEligible({ mandateKey: { in: ['2:2020:12', '1:2024:1'] } })).toBe(false);
    expect(speechesFullTextEligible({ spokenAt: { gte: '2025-01-01', lte: '2025-04-02' } })).toBe(
      true
    ); // 92 days
    expect(speechesFullTextEligible({ spokenAt: { gte: '2025-01-01', lte: '2025-04-03' } })).toBe(
      false
    ); // 93 days
    expect(speechesFullTextEligible({ chamber: { eq: 'senat' } })).toBe(false);
  });
});

describe('listParliamentSpeeches — bound guard (rejected PRE-repo)', () => {
  it('rejects {} with InvalidInput and NEVER calls the repo', async () => {
    const listSpeeches = vi.fn(emptyPage);
    const r = await list({}, { listSpeeches });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
    expect(listSpeeches).not.toHaveBeenCalled();
  });

  it('rejects gte-only, empty-shape mandateKey, and inverted/oversized windows', async () => {
    for (const filter of [
      { spokenAt: { gte: '2025-01-01' } },
      { mandateKey: {} },
      { mandateKey: { in: [] } },
      { spokenAt: { gte: '2025-12-31', lte: '2025-01-01' } }, // from > to
      { spokenAt: { gte: '2023-01-01', lte: '2024-01-02' } }, // 367 days
      { chamber: { eq: 'senat' }, q: { contains: 'lege' } }, // chamber/q bound nothing
    ] as FilterInput[]) {
      const r = await list(filter);
      expect(r.isErr(), JSON.stringify(filter)).toBe(true);
      if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
    }
  });

  it('accepts mandateKey eq and a 366-day (leap-year) window', async () => {
    const listSpeeches = vi.fn(emptyPage);
    expect((await list({ mandateKey: { eq: '2:2020:12' } }, { listSpeeches })).isOk()).toBe(true);
    expect(
      (await list({ spokenAt: { gte: '2024-01-01', lte: '2024-12-31' } }, { listSpeeches })).isOk()
    ).toBe(true);
    expect(listSpeeches).toHaveBeenCalledTimes(2);
  });

  it('rejects an over-cap mandateKey in: list with a SPECIFIC InvalidInput, pre-repo', async () => {
    const listSpeeches = vi.fn(emptyPage);
    const many = Array.from(
      { length: SPEECHES_MANDATE_KEYS_MAX + 1 },
      (_, i) => `2:2020:${String(i)}`
    );
    const r = await list({ mandateKey: { in: many } }, { listSpeeches });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.type).toBe('InvalidInput');
      expect(r.error.message).toContain('at most');
    }
    expect(listSpeeches).not.toHaveBeenCalled();
  });

  it('rejects a malformed spokenAt operand EVEN under a mandate bound (never reaches SQL)', async () => {
    const listSpeeches = vi.fn(emptyPage);
    const r = await list(
      { mandateKey: { eq: '2:2020:12' }, spokenAt: { gte: 'not-a-date' } },
      { listSpeeches }
    );
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
    expect(listSpeeches).not.toHaveBeenCalled();
  });
});

describe('listParliamentSpeeches — wantFullText threading + q handling', () => {
  it('threads wantFullText=true for a 92-day window, false for 93 days, true for mandateKey', async () => {
    const listSpeeches = vi.fn(emptyPage);
    const over = { listSpeeches };

    await list({ spokenAt: { gte: '2025-01-01', lte: '2025-04-02' } }, over, 'lege'); // 92 days
    expect(listSpeeches).toHaveBeenLastCalledWith(
      { first: 20 },
      { spokenAt: { gte: '2025-01-01', lte: '2025-04-02' } },
      'lege',
      true
    );

    await list({ spokenAt: { gte: '2025-01-01', lte: '2025-04-03' } }, over, 'lege'); // 93 days
    expect(listSpeeches).toHaveBeenLastCalledWith(
      { first: 20 },
      { spokenAt: { gte: '2025-01-01', lte: '2025-04-03' } },
      'lege',
      false
    );

    await list({ mandateKey: { eq: '2:2020:12' } }, over, 'lege');
    expect(listSpeeches).toHaveBeenLastCalledWith(
      { first: 20 },
      { mandateKey: { eq: '2:2020:12' } },
      'lege',
      true
    );
  });

  it('normalizes q (trim + lower-case; empty → undefined) before the repo', async () => {
    const listSpeeches = vi.fn(emptyPage);
    await list({ mandateKey: { eq: '2:2020:12' } }, { listSpeeches }, '  Lege  ');
    expect(listSpeeches).toHaveBeenLastCalledWith(
      { first: 20 },
      { mandateKey: { eq: '2:2020:12' } },
      'lege',
      true
    );
    await list({ mandateKey: { eq: '2:2020:12' } }, { listSpeeches }, '   ');
    expect(listSpeeches).toHaveBeenLastCalledWith(
      { first: 20 },
      { mandateKey: { eq: '2:2020:12' } },
      undefined,
      true
    );
  });

  it('rejects a q longer than SPEECH_Q_MAX BEFORE the repo', async () => {
    const listSpeeches = vi.fn(emptyPage);
    const r = await list({ mandateKey: { eq: '2:2020:12' } }, { listSpeeches }, 'x'.repeat(201));
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
    expect(listSpeeches).not.toHaveBeenCalled();
  });
});

describe('getParliamentSpeechActivity — guards + wantFullText=mandateKey-only', () => {
  const activity = () => okp({ year: 2025, days: [], availableYears: [2025], searchDepth: null });

  it('rejects a spokenAt inside filter and NEVER calls the repo (the year bounds the range)', async () => {
    const speechActivity = vi.fn(activity);
    const r = await getParliamentSpeechActivity(deps(makeRepo({ speechActivity })), 2025, {
      spokenAt: { gte: '2025-01-01' },
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
    expect(speechActivity).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range / non-integer year BEFORE the repo', async () => {
    const speechActivity = vi.fn(activity);
    for (const year of [123, 1989, 2101, 2025.5]) {
      const r = await getParliamentSpeechActivity(deps(makeRepo({ speechActivity })), year, {});
      expect(r.isErr(), String(year)).toBe(true);
      if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
    }
    expect(speechActivity).not.toHaveBeenCalled();
  });

  it('rejects a q longer than SPEECH_Q_MAX BEFORE the repo', async () => {
    const speechActivity = vi.fn(activity);
    const r = await getParliamentSpeechActivity(
      deps(makeRepo({ speechActivity })),
      2025,
      {},
      'x'.repeat(201)
    );
    expect(r.isErr()).toBe(true);
    expect(speechActivity).not.toHaveBeenCalled();
  });

  it('threads wantFullText = single-mandateKey ONLY (chamber/none/multi-mandate → false)', async () => {
    const speechActivity = vi.fn(activity);
    const d = deps(makeRepo({ speechActivity }));

    await getParliamentSpeechActivity(d, 2025, {}, ' Lege ');
    expect(speechActivity).toHaveBeenLastCalledWith(2025, {}, 'lege', false);

    await getParliamentSpeechActivity(d, 2025, { chamber: { eq: 'senat' } }, 'lege');
    expect(speechActivity).toHaveBeenLastCalledWith(
      2025,
      { chamber: { eq: 'senat' } },
      'lege',
      false
    );

    const two = { mandateKey: { in: ['2:2020:12', '1:2024:1'] } };
    await getParliamentSpeechActivity(d, 2025, two, 'lege');
    expect(speechActivity).toHaveBeenLastCalledWith(2025, two, 'lege', false);

    await getParliamentSpeechActivity(d, 2025, { mandateKey: { eq: '2:2020:12' } }, 'lege');
    expect(speechActivity).toHaveBeenLastCalledWith(
      2025,
      { mandateKey: { eq: '2:2020:12' } },
      'lege',
      true
    );
  });

  it('rejects an over-cap mandateKey in: list BEFORE the repo', async () => {
    const speechActivity = vi.fn(activity);
    const many = Array.from(
      { length: SPEECHES_MANDATE_KEYS_MAX + 1 },
      (_, i) => `2:2020:${String(i)}`
    );
    const r = await getParliamentSpeechActivity(deps(makeRepo({ speechActivity })), 2025, {
      mandateKey: { in: many },
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
    expect(speechActivity).not.toHaveBeenCalled();
  });
});

describe('getParliamentSpeech — passthrough', () => {
  it('forwards the key to repo.findSpeech and returns its value', async () => {
    const speech = {
      speechKey: 'senat:123',
      mandateKey: null,
      speakerName: 'Prim-ministrul',
      chamber: 'senat',
      spokenAt: '2025-06-01',
      title: null,
      summary: null,
      sourceUrl: null,
      sourceUrlKind: null,
      // A LEGACY row: the canonical pointers are false/null by construction (the DB
      // key-space CHECK ties `is_canonical` to the `canon:` prefix), and they read
      // the same way on a database where the canonical migration is not applied.
      isCanonical: false,
      sessionKey: null,
      position: null,
    };
    const findSpeech = vi.fn(() => okp<typeof speech | null>(speech));
    const r = await getParliamentSpeech(deps(makeRepo({ findSpeech })), 'senat:123');
    expect(findSpeech).toHaveBeenCalledWith('senat:123');
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value?.speechKey).toBe('senat:123');
  });

  it('passes null (unknown / quarantined / non-public) through', async () => {
    const findSpeech = vi.fn(() => okp(null));
    const r = await getParliamentSpeech(deps(makeRepo({ findSpeech })), 'nope');
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBeNull();
  });
});
