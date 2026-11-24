/**
 * The shipped free-text detector (owner decision 2026-11-20): a procurement
 * title is public unless it carries a personal marker. A text is WITHHELD when
 * ANY check is true. This is procurement-prod's rule (A1–A4 on the raw text,
 * B1–B5 on the folded text) as sent on 20 Nov, until its SQL form
 * (`serving.fl_text_public_hit`) is committed; the ClickHouse form of the same
 * rule is `clickhouse-free-text.ts`, and the two must agree.
 *
 * Interim use: the legacy procurement surfaces serve raw titles (no detector
 * upstream), so the API withholds the ones this rule hits until the CA lane
 * feeds them. Every boundary is written out, never `\b` before a letter, so
 * the rule can only withhold more than the PG `\m` form, never less.
 */

/** RE2's `\s` (ASCII only); JS's `\s` is wider and would withhold less in A2. */
const RE2_SPACE = '\\t\\n\\f\\r ';

/** A1: a 13-digit run (a personal numeric code). */
const THIRTEEN_DIGITS = /[0-9]{13}/u;
/** B3 (on the folded text): 13 digits with single separators. */
const THIRTEEN_SEPARATED_DIGITS = /[0-9]( ?[0-9]){12}/u;

const RAW_CHECKS: readonly RegExp[] = [
  THIRTEEN_DIGITS,
  // A2: an e-mail address.
  new RegExp(`[^${RE2_SPACE}@]+@[^${RE2_SPACE}@]+\\.[a-z]{2,}`, 'iu'),
  // A3: a Romanian phone number.
  /(\+40|\b0)[ .-]?[237]([ .-]?[0-9]){8}/u,
  // A4: a sole-trader marker.
  /(^|[^\p{L}\p{N}_])(pfa|p\.f\.a\.|i\.i\.|intreprindere individuala|întreprindere individuală)/iu,
];

const FOLDED_CHECKS: readonly RegExp[] = [
  THIRTEEN_SEPARATED_DIGITS,
  // B5: sole-trader and natural-person markers.
  /(^|[^\p{L}])p ?f ?a([^\p{L}]|$)|persoana ?fizica([^\p{L}]|$)|ntreprinderea? ?(individ|famil)/iu,
];

const DIGIT_RUNS = /[0-9]+(?: [0-9]+)*/gu;
const PHONE_IN_RUN = /(0|40)[237][0-9]{8}/u;

/** NFKD, combining marks dropped, every run of non-letters/non-digits one space. */
const fold = (decomposed: string): string =>
  decomposed
    .replace(/\p{Mn}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/^ +| +$/gu, '');

/**
 * The code points where Node's Unicode classes (\p{L}, \p{N}, \p{Mn}, \p{Nd})
 * equal the deployed ClickHouse RE2's, checked over every code point on
 * 20 Nov (Node 24.22 / Unicode 17 against ClickHouse 26.8: 9,115 code points
 * differ, all at U+088F or above and none inside these ranges). A text with any
 * other code point is withheld, so this form never withholds less than the
 * ClickHouse one. It held 1 of 314,993 distinct live titles.
 */
const OUTSIDE_STABLE_RANGES =
  // eslint-disable-next-line no-control-regex -- the range starts at U+0000 on purpose: control characters are not withheld.
  /[^\u0000-\u07FF\u1E00-\u1EFF\u2000-\u2BFF\uE000-\uF8FF\uFB00-\uFFFF\u{1F000}-\u{1FAFF}]/u;

/** B2: a non-ASCII decimal digit in the raw text. */
const hasNonAsciiDigit = (text: string): boolean => /\p{Nd}/u.test(text.replace(/[0-9]/gu, ''));

/** True when the rule withholds `text`. */
export const isFreeTextWithheld = (text: string): boolean => {
  if (OUTSIDE_STABLE_RANGES.test(text)) return true;
  if (RAW_CHECKS.some((check) => check.test(text))) return true;
  const decomposed = text.normalize('NFKD');
  // B1: an at sign in any form (fullwidth included, after NFKD).
  if (decomposed.includes('@')) return true;
  if (hasNonAsciiDigit(text)) return true;
  const folded = fold(decomposed);
  if (FOLDED_CHECKS.some((check) => check.test(folded))) return true;
  // B4: a Romanian phone number inside any digit run.
  return (folded.match(DIGIT_RUNS) ?? []).some((run) => PHONE_IN_RUN.test(run.replace(/ /gu, '')));
};

/** The text when the rule allows it; null when it is withheld (or absent). */
export const publicFreeText = (text: string | null): string | null =>
  text === null || isFreeTextWithheld(text) ? null : text;

/**
 * Whether a party name may carry a personal numeric code (a CNP): the rule's numeric checks
 * only (A1, B2, B3), behind its stable-range guard. "Never a CNP" (owner policy): a name the source wrote with one is withheld
 * whole. Party names are otherwise served as the source published them, so the rule's other
 * checks (sole-trader markers, phones, e-mail) do not apply to names.
 */
export const carriesPersonalCode = (name: string): boolean =>
  // The rule's stable-range guard too, so this check is never weaker than its numeric checks
  // (a Hangul filler, for one, is a letter that splits a digit run without folding to a space).
  OUTSIDE_STABLE_RANGES.test(name) ||
  THIRTEEN_DIGITS.test(name) ||
  hasNonAsciiDigit(name) ||
  THIRTEEN_SEPARATED_DIGITS.test(fold(name.normalize('NFKD')));

/** The party name when it carries no personal code; null when withheld (or absent). */
export const publicPartyName = (name: string | null): string | null =>
  name === null || carriesPersonalCode(name) ? null : name;

/**
 * 11+ digits, joined by at most one white-space character or dash each (how a code is split when
 * written: NBSP, thin space and tab are white space after NFKD; U+2010–2014 stay dashes, U+2212 too).
 */
const PERSON_CODE_RUN = /[0-9]([\s\p{Pd}\u2212]?[0-9]){10,}/u;
/** Invisible characters that split a digit run without showing: format characters, Hangul fillers. */
const INVISIBLE = /[\p{Cf}\u115F\u1160\u3164\uFFA0]/gu;

/**
 * A run of more than an organization code's digits (11+, also split by single white space or dashes):
 * the kernel treats such an identifier as a person's. A slash, a dot or a date does not join a run,
 * so a document number next to a date ("HCL nr. 123/24.11.2026") is no code. Refused where a
 * caller's text is echoed and matches no number column (analysis scope q, CPV q, totals q); the
 * legacy search q still matches contract numbers that long (50 bare ones on 24 Nov).
 */
export const hasPersonCodeRun = (text: string): boolean =>
  PERSON_CODE_RUN.test(text.normalize('NFKD').replace(INVISIBLE, ''));
