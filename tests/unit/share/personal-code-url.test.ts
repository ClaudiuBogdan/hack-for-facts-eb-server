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
];

describe('urlCarriesPersonalCode', () => {
  it.each(REFUSED)('refuses %s', (_, url) => {
    expect(urlCarriesPersonalCode(url)).toBe(true);
  });

  it.each(ACCEPTED)('accepts %s', (_, url) => {
    expect(urlCarriesPersonalCode(url)).toBe(false);
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

  it('answers from the cache exactly as an unknown code, with no count', async () => {
    const { repo, calls } = recordingRepo();
    const cache = makeFakeShortLinkCache({ entries: new Map([[LINK_CODE, STORED]]) });
    const result = await resolveShortLink({ shortLinkRepo: repo, cache }, { code: LINK_CODE });
    expect(result._unsafeUnwrapErr()).toEqual(notFound);
    expect(calls).toEqual([]);
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
