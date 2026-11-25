/**
 * Whether a URL carries a personal numeric code (PRJ-HX7G, 25 Nov): a short link resolves
 * publicly, so a URL that carries one is never stored.
 *
 * The rule is the kernel's: a run of 11+ digits joined by at most one space or dash each
 * (`hasPersonCodeRun`), on every form a reader could see. The checked forms are the stored string
 * as given (fragment and userinfo included) and each percent-decoding of it, repeated until it is
 * stable (double encoding included, at most MAX_DECODES times), each also with `+` read as a
 * space. Any Unicode decimal digit counts as a digit (fullwidth and Arabic-Indic codes are caught).
 *
 * Two things a chart URL carries are not codes and are blanked first, or ordinary shares would be
 * refused (the client stores a whole chart document as JSON in the query):
 * - a UUID (8-4-4-4-12 hex), whose all-digit last group could join a run across its dash;
 * - a decimal fraction (digits right after "<digit>."), such as a dragged annotation position
 *   (`pX = 0.4123456789012345`, stored unrounded).
 * The procurement name rule's folded check (any punctuation joins digits) is not used: it joins
 * a list of company codes (`["4305857","4270740"]`) into one run.
 */

import { hasPersonCodeRun } from '@/common/person-code-run.js';

/** Percent-decodings tried after the raw string (a code double- or triple-encoded is still caught). */
const MAX_DECODES = 4;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const DECIMAL_FRACTION = /(?<=[0-9]\.)[0-9]+/gu;
/** Every Unicode decimal digit, as an ASCII one (its value does not matter, only that it is a digit). */
const ANY_DIGIT = /\p{Nd}/gu;

/** The string once percent-decoded; null when it holds a malformed escape. */
const decodedOnce = (text: string): string | null => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/** The raw string and its percent-decodings, until stable or malformed. */
const forms = (url: string): string[] => {
  const out = [url];
  let current = url;
  for (let step = 0; step < MAX_DECODES; step += 1) {
    const next = decodedOnce(current);
    if (next === null || next === current) break;
    out.push(next);
    current = next;
  }
  return out;
};

const carriesCode = (text: string): boolean =>
  hasPersonCodeRun(
    text.normalize('NFKD').replace(ANY_DIGIT, '0').replace(UUID, ' ').replace(DECIMAL_FRACTION, ' ')
  );

/** True when any form of the URL a reader could see carries a personal numeric code. */
export const urlCarriesPersonalCode = (url: string): boolean =>
  forms(url).some((form) => carriesCode(form) || carriesCode(form.replace(/\+/gu, ' ')));
