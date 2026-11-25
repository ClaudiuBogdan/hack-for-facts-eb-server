/**
 * Whether a URL carries a personal numeric code (PRJ-HX7G, 25 Nov): a short link resolves
 * publicly, so a URL that carries one is never stored, and a stored one is never served.
 *
 * The rule is the kernel's: a run of 11+ digits joined by at most one space or dash each
 * (PERSON_CODE_RUN_PATTERN, as `hasPersonCodeRun`), found in every form a reader could see:
 * - the stored string as given (fragment and userinfo included), and with `+` in its query read as
 *   a space (how the client's search parser reads it);
 * - each percent-decoding of those, repeated until stable. Each run of escapes is decoded as a
 *   browser does (UTF-8, an invalid byte becomes U+FFFD), so one bad escape hides nothing else; a
 *   URL still changing after MAX_DECODES decodings is refused;
 * - each of those with JSON string escapes read (`\uXXXX`, `\t` and the other one-letter ones: a chart
 *   document is JSON in the query).
 * In each form an escape still left is not text (its hex digits never count), format, ignorable and
 * combining characters are dropped (they split a run without showing), and any Unicode decimal
 * digit counts as a digit. A host with a punycode label is refused (no Transparenta host has one),
 * read after hidden characters are dropped (a soft hyphen cannot hide one); userinfo is not the host.
 *
 * Two runs are not codes, or ordinary chart links would be refused: a run that lies wholly inside
 * one exact UUID token (8-4-4-4-12 ASCII hex, not touching a letter, digit or dash), whose all-digit
 * last group could make one, and a run of plain ASCII digits that is a whole decimal fraction (right
 * after "<digits>.", the number not part of a word), such as an unrounded annotation position
 * (`pX = 0.4123456789012345`). A run with a separator, other digits, or one that reaches outside
 * the UUID or the number, is still a code.
 *
 * Accepted residual (root, 25 Nov): a code split by commas, dots, slashes or quotes is not caught,
 * and the procurement name rule's folded check (any punctuation joins digits) is not used, because
 * it joins a list of company codes (`["4305857","4270740"]`) into one run.
 */

import { PERSON_CODE_RUN_PATTERN } from '@/common/person-code-run.js';

/** Percent-decodings tried before a URL that keeps changing is refused. */
const MAX_DECODES = 16;

const ESCAPE = /%[0-9A-Fa-f]{2}/gu;
const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/gu;
/** A JSON string escape: `\uXXXX` or a one-letter one (a chart document is JSON in the query). */
const JSON_ESCAPE = /\\(?:u([0-9A-Fa-f]{4})|([tnrbf/"\\]))/gu;
/** A JSON `\uXXXX` escape whose backslash is literal or still percent-encoded (`%5C`). */
const JSON_U_ESCAPE = /(?:\\|%5[Cc])u[0-9A-Fa-f]{4}/gu;
const JSON_SIMPLE: Readonly<Record<string, string>> = {
  t: '\t',
  n: '\n',
  r: '\r',
  b: '\b',
  f: '\f',
  '/': '/',
  '"': '"',
  '\\': '\\',
};
/** Characters that do not show: format, default-ignorable and combining marks. */
const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}]/gu;
const ANY_DIGIT = /\p{Nd}/gu;
const RUN = new RegExp(PERSON_CODE_RUN_PATTERN, 'gu');
const UUID =
  /(?<![0-9a-z-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-z-])/giu;
const PLAIN_DIGITS = /^[0-9]+$/u;
const DIGIT = /^[0-9]$/u;
/** What may stand right before a number (or before its minus sign): not part of a word. */
const NUMBER_START = /^[^\p{L}\p{N}_.]$/u;
/** What may follow a fraction's digits: an optional exponent, then not part of a word. */
const AFTER_FRACTION = /^(?:[eE][+-]?[0-9]+)?(?:[^\p{L}\p{N}_.]|$)/u;
/** The authority of an absolute URL (up to the path, query or fragment). */
const AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu;
const PUNYCODE_LABEL = /xn--/iu;

/** A punycode label in the host: after the last `@` of the authority (userinfo is not the host). */
const hasPunycodeHost = (text: string): boolean => {
  const authority = AUTHORITY.exec(text)?.[1];
  if (authority === undefined) return false;
  return PUNYCODE_LABEL.test(authority.slice(authority.lastIndexOf('@') + 1));
};
/** Invalid bytes become U+FFFD, as in a browser; never throws. */
const UTF8 = new TextDecoder('utf-8');

/** Every run of escapes decoded as UTF-8 (one bad byte spoils only itself). */
const decodeEscapes = (text: string): string =>
  text.replace(ESCAPE_RUN, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let index = 0; index < bytes.length; index += 1)
      bytes[index] = Number.parseInt(run.slice(index * 3 + 1, index * 3 + 3), 16);
    return UTF8.decode(bytes);
  });

/** `+` read as a space in the query only (it is a plain plus in the path and the fragment). */
const plusAsSpace = (url: string): string => {
  const query = url.indexOf('?');
  const hash = url.indexOf('#');
  if (query < 0 || (hash >= 0 && hash < query)) return url;
  const end = hash < 0 ? url.length : hash;
  return url.slice(0, query) + url.slice(query, end).replace(/\+/gu, ' ') + url.slice(end);
};

/** The string and its percent-decodings; null when it is still changing after MAX_DECODES. */
const decodings = (start: string): string[] | null => {
  const out = [start];
  let current = start;
  for (let step = 0; step < MAX_DECODES; step += 1) {
    const next = decodeEscapes(current);
    if (next === current) return out;
    out.push(next);
    current = next;
  }
  return null;
};

const jsonUnescaped = (text: string): string =>
  text.replace(JSON_ESCAPE, (_escape, hex: string | undefined, simple: string | undefined) =>
    hex === undefined
      ? (JSON_SIMPLE[simple ?? ''] ?? '')
      : String.fromCharCode(Number.parseInt(hex, 16))
  );

/**
 * What a reader sees of a form: escapes still left (percent and JSON `\uXXXX`) are not text, hidden
 * characters are dropped. Digits are not mapped yet, so the exemptions below see ASCII only.
 */
const shown = (form: string): string =>
  form.replace(JSON_U_ESCAPE, '/').replace(ESCAPE, '/').normalize('NFKD').replace(HIDDEN, '');

/** Every Unicode decimal digit as ASCII zeros, keeping the length (so spans line up). */
const digitsMapped = (text: string): string =>
  text.replace(ANY_DIGIT, (digit) => '0'.repeat(digit.length));

/**
 * A run that is a whole decimal fraction in the shown text: ASCII digits right after
 * "<ASCII digits>.", the number not part of a word on either side (a minus sign may precede it),
 * an exponent allowed after it.
 */
const isFraction = (text: string, start: number, end: number): boolean => {
  if (!PLAIN_DIGITS.test(text.slice(start, end)) || text.charAt(start - 1) !== '.') return false;
  let first = start - 1;
  while (first > 0 && DIGIT.test(text.charAt(first - 1))) first -= 1;
  if (first === start - 1) return false;
  let before = first - 1;
  if (text.charAt(before) === '-') before -= 1;
  const leftOk = before < 0 || NUMBER_START.test(text.charAt(before));
  return leftOk && AFTER_FRACTION.test(text.slice(end));
};

const carriesCode = (text: string): boolean => {
  // UUID tokens in the shown text: ASCII hex only, so other digits never make one.
  const uuids = [...text.matchAll(UUID)].map((match) => [
    match.index,
    match.index + match[0].length,
  ]);
  for (const match of digitsMapped(text).matchAll(RUN)) {
    const start = match.index;
    const end = start + match[0].length;
    const inUuid = uuids.some(([from = 0, to = 0]) => start >= from && end <= to);
    if (!inUuid && !isFraction(text, start, end)) return true;
  }
  return false;
};

/** True when any form of the URL a reader could see carries a personal numeric code. */
export const urlCarriesPersonalCode = (url: string): boolean => {
  for (const start of [url, plusAsSpace(url)]) {
    const forms = decodings(start);
    if (forms === null) return true;
    for (const form of forms)
      for (const candidate of [form, jsonUnescaped(form)]) {
        const text = shown(candidate);
        if (hasPunycodeHost(text) || carriesCode(text)) return true;
      }
  }
  return false;
};
