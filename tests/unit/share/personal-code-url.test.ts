/**
 * PRJ-HX7G: a URL that carries a personal numeric code is never stored as a short link, and a
 * stored one never resolves. The code here is synthetic (13 digits, no real person's).
 *
 * The chart links come from the client's own serialiser at 119a0974
 * (`stringifySearchWith(JSON.stringify)` + `normalizeSearchEncoding`, src/router.tsx), with
 * synthetic content: an ordinary chart, a two-entity series filter, a moved annotation (positions
 * unrounded, as the drag handler stores them) and a series whose UUID ends in all digits.
 */

import { readFileSync } from 'node:fs';

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { urlCarriesPersonalCode } from '@/modules/share/core/personal-code-url.js';
import { buildCanonicalMetadata, generateCode } from '@/modules/share/core/url-utils.js';
import { createShortLink } from '@/modules/share/core/usecases/create-short-link.js';
import { makeShareLink } from '@/modules/share/core/usecases/make-share-link.js';
import { resolveShortLink } from '@/modules/share/core/usecases/resolve-short-link.js';

import {
  createTestShortLink,
  makeFakeShortLinkCache,
  makeFakeShortLinkRepo,
  testHasher,
} from '../../fixtures/fakes.js';

import type { ShortLinkRepository } from '@/modules/share/core/ports.js';

const CODE = '1234567890123';
const SPLIT = '1234567-890123';
const BASE = 'https://transparenta.eu';

const ChartUrlsSchema = Type.Object({
  ordinary: Type.String(),
  twoEntities: Type.String(),
  movedAnnotation: Type.String(),
  digitTailUuid: Type.String(),
});
const chartUrls = (() => {
  // eslint-disable-next-line no-restricted-syntax -- a checked-in fixture, validated just below
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../../fixtures/share/chart-urls.json', import.meta.url), 'utf8')
  );
  if (!Value.Check(ChartUrlsSchema, raw)) throw new Error('chart-urls.json: unexpected shape');
  return raw;
})();

const fullwidth = (digits: string): string =>
  digits.replace(/[0-9]/gu, (digit) => String.fromCodePoint(0xff10 + Number(digit)));
const arabicIndic = (digits: string): string =>
  digits.replace(/[0-9]/gu, (digit) => String.fromCodePoint(0x0660 + Number(digit)));
const percentEncoded = (text: string): string =>
  // ASCII only (the codes and escapes encoded here): one byte per character.
  text.replace(
    /[\x20-\x7E]/gu,
    (char) => `%${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(2, '0')}`
  );

/** A backslash, built so no escape sequence is written in this file by accident. */
const BACKSLASH = String.fromCharCode(92);
/** A chart title whose JSON escapes render the code once parsed. */
const jsonEscapedCode = [...CODE.matchAll(/[0-9]/gu)]
  .map((digit) => `${BACKSLASH}u003${digit[0]}`)
  .join('');
/** `-` percent-encoded `levels` times. */
const encodedDash = (levels: number): string => {
  let out = '-';
  for (let level = 0; level < levels; level += 1)
    out = out.replace(/%/gu, '%25').replace('-', '%2D');
  return out;
};

/** The cases PRJ-HX7G lists, and their neighbours. */
const REFUSED: readonly (readonly [string, string])[] = [
  ['plain, in the path', `${BASE}/companies/${CODE}`],
  ['plain, in a query value', `${BASE}/procurement?q=${CODE}`],
  ['percent-encoded', `${BASE}/procurement?q=${percentEncoded(CODE)}`],
  ['dash-separated', `${BASE}/procurement?furnizor=${SPLIT}`],
  ['space-separated', `${BASE}/procurement?q=1234567%20890123`],
  ['plus-separated', `${BASE}/procurement?cumparator=1234567+890123`],
  ['double-encoded', `${BASE}/procurement?q=${percentEncoded(percentEncoded(CODE))}`],
  ['fullwidth digits', `${BASE}/procurement?q=${fullwidth(CODE)}`],
  ['fullwidth, percent-encoded', `${BASE}/procurement?q=${encodeURIComponent(fullwidth(CODE))}`],
  ['Arabic-Indic digits', `${BASE}/procurement?q=${encodeURIComponent(arabicIndic(CODE))}`],
  ['in the fragment', `${BASE}/companies/14399840#${CODE}`],
  ['in the userinfo', `https://${CODE}@transparenta.eu/`],
  ['split by a zero-width space', `${BASE}/procurement?q=1234567%E2%80%8B890123`],
  [
    'inside JSON search state',
    `${BASE}/procurement?filters=${encodeURIComponent(JSON.stringify({ q: CODE }))}`,
  ],
  ['an 11-digit run (the kernel threshold)', `${BASE}/procurement?q=12345678901`],
  // Sol round 1 (25 Nov):
  ['next to an invalid escape', `${BASE}/procurement?bad=%FF&q=1234567%2D890123`],
  // One escape run with an invalid first byte: the browser still shows the digits after it.
  [
    'after an invalid byte in the same escape run',
    `${BASE}/procurement?q=%FF${percentEncoded(CODE)}`,
  ],
  // Not UUID tokens (an extra leading or trailing hex character): a 12-digit tail is a code.
  [
    'a 12-digit tail in a token one character longer at the start',
    `${BASE}/x?id=0a1b2c3d4-e5f6-4a7b-8c9d-446655440000`,
  ],
  [
    'a 12-digit tail in a token one character longer at the end',
    `${BASE}/x?id=a1b2c3d4-e5f6-4a7b-8c9d-446655440000f`,
  ],
  ['split after a decimal point', `${BASE}/procurement?q=0.1234567-890123`],
  ['in a UUID-like token with a 13-digit tail', `${BASE}/x?id=a1b2c3d4-e5f6-4a7b-8c9d-${CODE}`],
  ['split by a combining grapheme joiner', `${BASE}/procurement?q=1234567%CD%8F890123`],
  [
    'as JSON escapes in a chart title',
    `${BASE}/charts/x?chart=${encodeURIComponent(`{"title":"${jsonEscapedCode}"}`)}`,
  ],
  ['in a punycode host', 'https://xn--11b6ncbdcedfklmno.example/'],
  ['encoded five times', `${BASE}/procurement?q=1234567${encodedDash(5)}890123`],
  [
    'still changing after sixteen decodings',
    `${BASE}/procurement?q=1234567${encodedDash(17)}890123`,
  ],
];

/** Ordinary links that must still be shortened. */
const ACCEPTED: readonly (readonly [string, string])[] = [
  ['an ordinary chart link', chartUrls.ordinary],
  ['a two-entity series filter', chartUrls.twoEntities],
  ['a moved annotation (unrounded positions)', chartUrls.movedAnnotation],
  ['a series UUID with an all-digit tail', chartUrls.digitTailUuid],
  ['a 10-digit company code', `${BASE}/companies/1234567890?tab=summary`],
  ['a year list', `${BASE}/budget?years=${encodeURIComponent('[2016,2017,2018,2019,2020]')}`],
  ['a date range', `${BASE}/procurement?from=2025-03-10&to=2025-12-31`],
  ['a decimal amount', `${BASE}/procurement?min=0.12345678901234`],
  [
    'a learning page with a fragment',
    `${BASE}/ro/learning/path/module/lesson-1?section=quiz#answer`,
  ],
  // Sol round 1 (25 Nov): escape hex and a plain plus are not digits or separators.
  ['a 10-digit value after an encoded space', `${BASE}/procurement?q=%201234567890`],
  ['an encoded plus between digits', `${BASE}/procurement?q=1234567%2B890123`],
  ['a plus in the path', `${BASE}/x/1234567+890123`],
];

describe('urlCarriesPersonalCode', () => {
  it.each(REFUSED)('refuses %s', (_, url) => {
    expect(urlCarriesPersonalCode(url)).toBe(true);
  });

  it.each(ACCEPTED)('accepts %s', (_, url) => {
    expect(urlCarriesPersonalCode(url)).toBe(false);
  });

  it('answers the same on repeated calls (no regex state carried over)', () => {
    for (let round = 0; round < 3; round += 1) {
      for (const [, url] of REFUSED) expect(urlCarriesPersonalCode(url), url).toBe(true);
      for (const [, url] of ACCEPTED) expect(urlCarriesPersonalCode(url), url).toBe(false);
    }
  });

  it('never throws on a malformed escape, and still reads the raw string', () => {
    expect(urlCarriesPersonalCode(`${BASE}/x?q=%E0%A4%A&c=${CODE}`)).toBe(true);
    expect(urlCarriesPersonalCode(`${BASE}/x?q=%E0%A4%A`)).toBe(false);
  });
});

/** A repo that records every call: a refused URL must cause none. */
const recordingRepo = (base: ShortLinkRepository = makeFakeShortLinkRepo()) => {
  const calls: string[] = [];
  const repo: ShortLinkRepository = {
    getByCode: (code) => {
      calls.push('getByCode');
      return base.getByCode(code);
    },
    getByOriginalUrl: (url) => {
      calls.push('getByOriginalUrl');
      return base.getByOriginalUrl(url);
    },
    createOrAssociateUser: (input) => {
      calls.push('createOrAssociateUser');
      return base.createOrAssociateUser(input);
    },
    countRecentForUser: (userId, since) => {
      calls.push('countRecentForUser');
      return base.countRecentForUser(userId, since);
    },
    incrementAccessStats: (code) => {
      calls.push('incrementAccessStats');
      return base.incrementAccessStats(code);
    },
  };
  return { repo, calls };
};

describe('createShortLink refuses a URL with a personal code', () => {
  it.each(REFUSED)('stores nothing for %s', async (_, url) => {
    const { repo, calls } = recordingRepo();
    const result = await createShortLink(
      { shortLinkRepo: repo, hasher: testHasher },
      { userId: 'u', url }
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toEqual({
      type: 'PersonalCodeInUrlError',
      message: 'This link carries a personal numeric code and cannot be shortened.',
    });
    expect(JSON.stringify(error)).not.toMatch(/[0-9]{7}/u);
    expect(calls).toEqual([]);
  });

  it.each(ACCEPTED)('still shortens %s', async (_, url) => {
    const { repo, calls } = recordingRepo();
    const result = await createShortLink(
      { shortLinkRepo: repo, hasher: testHasher },
      { userId: 'u', url }
    );
    expect(result.isOk()).toBe(true);
    expect(calls).toContain('createOrAssociateUser');
  });

  it('makeShareLink logs the refusal without the URL', async () => {
    const warnings: Record<string, unknown>[] = [];
    const url = `${BASE}/procurement?q=${CODE}`;
    const shared = await makeShareLink(
      {
        shortLinkRepo: makeFakeShortLinkRepo(),
        hasher: testHasher,
        config: {
          publicBaseUrl: BASE,
          allowedOrigins: [BASE],
          dailyLimit: 100,
          cacheTtlSeconds: 60,
        },
      },
      { url, userId: 'u' },
      { warn: (_message, meta) => warnings.push(meta ?? {}), error: () => undefined }
    );
    expect(shared).toBe(url);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.['error']).toBe('PersonalCodeInUrlError');
    expect(JSON.stringify(warnings)).not.toContain(CODE);
  });
});

describe('resolveShortLink never serves a stored URL with a personal code', () => {
  const STORED = `${BASE}/procurement?q=${CODE}`;
  const LINK_CODE = 'ABC123DEF456GHIJ';
  const notFound = {
    type: 'ShortLinkNotFoundError',
    message: `Short link with code '${LINK_CODE}' not found`,
    code: LINK_CODE,
  };

  it('answers from the database exactly as an unknown code, with no cache fill or count', async () => {
    const { repo, calls } = recordingRepo(
      makeFakeShortLinkRepo({
        shortLinks: [createTestShortLink({ code: LINK_CODE, originalUrl: STORED })],
      })
    );
    const cache = makeFakeShortLinkCache();
    const stored = await resolveShortLink({ shortLinkRepo: repo, cache }, { code: LINK_CODE });
    const unknown = await resolveShortLink(
      { shortLinkRepo: makeFakeShortLinkRepo(), cache: makeFakeShortLinkCache() },
      { code: LINK_CODE }
    );
    expect(stored._unsafeUnwrapErr()).toEqual(notFound);
    expect(stored._unsafeUnwrapErr()).toEqual(unknown._unsafeUnwrapErr());
    expect(await cache.get(LINK_CODE)).toBeNull();
    expect(calls).toEqual(['getByCode']);
  });

  it('reads a blocked cache entry as a miss: the database answers, as for an unknown code', async () => {
    const { repo, calls } = recordingRepo();
    const cache = makeFakeShortLinkCache({ entries: new Map([[LINK_CODE, STORED]]) });
    const result = await resolveShortLink({ shortLinkRepo: repo, cache }, { code: LINK_CODE });
    expect(result._unsafeUnwrapErr()).toEqual(notFound);
    // The lookup an unknown code makes, and no access count.
    expect(calls).toEqual(['getByCode']);
  });

  it('still resolves an ordinary chart link', async () => {
    const repo = makeFakeShortLinkRepo({
      shortLinks: [
        createTestShortLink({ code: LINK_CODE, originalUrl: chartUrls.movedAnnotation }),
      ],
    });
    const result = await resolveShortLink(
      { shortLinkRepo: repo, cache: makeFakeShortLinkCache() },
      { code: LINK_CODE }
    );
    expect(result._unsafeUnwrap().url).toBe(chartUrls.movedAnnotation);
  });
});

describe('round 1 of the review: legacy rows, outages and logs', () => {
  const LINK_CODE = 'ABC123DEF456GHIJ';
  const STORED = `${BASE}/procurement?q=${CODE}`;

  it('treats a blocked cache entry as a miss: an outage answers as for an unknown code', async () => {
    const failing = { ...makeFakeShortLinkRepo({ simulateDbError: true }) };
    const blocked = await resolveShortLink(
      {
        shortLinkRepo: failing,
        cache: makeFakeShortLinkCache({ entries: new Map([[LINK_CODE, STORED]]) }),
      },
      { code: LINK_CODE }
    );
    const unknown = await resolveShortLink(
      { shortLinkRepo: failing, cache: makeFakeShortLinkCache() },
      { code: LINK_CODE }
    );
    expect(blocked._unsafeUnwrapErr()).toEqual(unknown._unsafeUnwrapErr());
    expect(blocked._unsafeUnwrapErr().type).toBe('DatabaseError');
  });

  it('writes nothing to the cache for a blocked entry', async () => {
    const writes: string[] = [];
    const base = makeFakeShortLinkCache({ entries: new Map([[LINK_CODE, STORED]]) });
    const cache = {
      get: base.get,
      set: (code: string, url: string) => {
        writes.push(code);
        return base.set(code, url);
      },
    };
    const { repo, calls } = recordingRepo();
    const result = await resolveShortLink({ shortLinkRepo: repo, cache }, { code: LINK_CODE });
    expect(result._unsafeUnwrapErr().type).toBe('ShortLinkNotFoundError');
    expect(writes).toEqual([]);
    expect(calls).toEqual(['getByCode']);
  });

  it("never hands out a blocked legacy row's code for a clean URL with the same metadata", async () => {
    const clean = `${BASE}/x`;
    const legacy = `${BASE}/x#${CODE}`;
    const code = generateCode(testHasher, buildCanonicalMetadata(clean));
    expect(generateCode(testHasher, buildCanonicalMetadata(legacy))).toBe(code);
    const { repo, calls } = recordingRepo(
      makeFakeShortLinkRepo({
        shortLinks: [
          createTestShortLink({
            code,
            originalUrl: legacy,
            metadata: buildCanonicalMetadata(legacy),
          }),
        ],
      })
    );
    const result = await createShortLink(
      { shortLinkRepo: repo, hasher: testHasher },
      { userId: 'u', url: clean }
    );
    expect(result._unsafeUnwrapErr().type).toBe('HashCollisionError');
    expect(calls).toEqual(['getByCode']);
  });

  it('makeShareLink keeps the URL out of the error log when the warning logger throws', async () => {
    const errors: Record<string, unknown>[] = [];
    const url = `${BASE}/procurement?q=${CODE}`;
    await makeShareLink(
      {
        shortLinkRepo: makeFakeShortLinkRepo(),
        hasher: testHasher,
        config: {
          publicBaseUrl: BASE,
          allowedOrigins: [BASE],
          dailyLimit: 100,
          cacheTtlSeconds: 60,
        },
      },
      { url, userId: 'u' },
      {
        warn: () => {
          throw new Error('logger down');
        },
        error: (_message, meta) => errors.push(meta ?? {}),
      }
    );
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toContain(CODE);
  });
});
