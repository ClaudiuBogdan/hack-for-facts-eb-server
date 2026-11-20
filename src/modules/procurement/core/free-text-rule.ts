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

const RAW_CHECKS: readonly RegExp[] = [
  // A1: a 13-digit run (a personal numeric code).
  /[0-9]{13}/u,
  // A2: an e-mail address.
  new RegExp(`[^${RE2_SPACE}@]+@[^${RE2_SPACE}@]+\\.[a-z]{2,}`, 'iu'),
  // A3: a Romanian phone number.
  /(\+40|\b0)[ .-]?[237]([ .-]?[0-9]){8}/u,
  // A4: a sole-trader marker.
  /(^|[^\p{L}\p{N}_])(pfa|p\.f\.a\.|i\.i\.|intreprindere individuala|întreprindere individuală)/iu,
];

const FOLDED_CHECKS: readonly RegExp[] = [
  // B3: 13 digits with single separators.
  /[0-9]( ?[0-9]){12}/u,
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

/** True when the rule withholds `text`. */
export const isFreeTextWithheld = (text: string): boolean => {
  if (RAW_CHECKS.some((check) => check.test(text))) return true;
  const decomposed = text.normalize('NFKD');
  // B1: an at sign in any form (fullwidth included, after NFKD).
  if (decomposed.includes('@')) return true;
  // B2: a non-ASCII decimal digit in the raw text.
  if (/\p{Nd}/u.test(text.replace(/[0-9]/gu, ''))) return true;
  const folded = fold(decomposed);
  if (FOLDED_CHECKS.some((check) => check.test(folded))) return true;
  // B4: a Romanian phone number inside any digit run.
  return (folded.match(DIGIT_RUNS) ?? []).some((run) => PHONE_IN_RUN.test(run.replace(/ /gu, '')));
};

/** The text when the rule allows it; null when it is withheld (or absent). */
export const publicFreeText = (text: string | null): string | null =>
  text === null || isFreeTextWithheld(text) ? null : text;
