/**
 * Legal module — citation parsing (the identifier router, §9). Pure. Parses a
 * free-text citation like "legea 227/2015", "L 227/2015", "oug 57/2019",
 * "hg 1/2016" into a partial `LegalCitationKey` (no issuer_slug — that is
 * cross-checked against `act_citation_keys`). Returns null when the text is not a
 * recognizable numbered citation (then the alias/trigram path runs).
 *
 * This is deliberately conservative: it only fires on a clear `<type> <number>/<year>`
 * shape so the retrieval router can short-circuit to a direct act lookup (no
 * embeddings) — a fuzzy/topical query falls through to null and the hybrid path.
 */

import type { LegalCitationKey } from './types.js';

/** Map common Romanian act-type words/abbreviations to the `act_type` vocab. */
const TYPE_ALIASES: Record<string, string> = {
  lege: 'lege',
  legea: 'lege',
  l: 'lege',
  oug: 'oug',
  og: 'og',
  ordonanta: 'og',
  hotarare: 'hotarare',
  hotararea: 'hotarare',
  hg: 'hotarare',
  h: 'hotarare',
  ordin: 'ordin',
  ordinul: 'ordin',
  o: 'ordin',
  decizie: 'decizie',
  decizia: 'decizie',
  decret: 'decret',
  decretul: 'decret',
};

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/gu, '').toLowerCase();

/**
 * An alias as stored: folded and single-spaced. All 90 stored aliases are ASCII
 * lower case ("codul de procedura penala", measured 2026-10-18), so an input
 * with diacritics ("Codul de procedură penală") matched none of them.
 */
export const normalizeAlias = (raw: string): string => fold(raw).replace(/\s+/gu, ' ').trim();

/**
 * One spelling per citation: folded, "nr." dropped with or without a space
 * before its dot, and a dotted type abbreviation ("O.U.G.", "H.G.", "L.") joined
 * into its word. Read letter by letter, "O.U.G. 57/2019" was an ordin (`o`). An
 * abbreviation that is no known type word ("H.G.R.") stays as written, so the
 * permissive reading keeps its first letter, as before.
 */
const normalize = (raw: string): string => {
  const text = fold(raw).trim();
  const dotted = /^(?:[a-z] ?\. ?)+/u.exec(text)?.[0];
  const joined = dotted?.replace(/[ .]/gu, '');
  const head =
    dotted !== undefined && joined !== undefined && TYPE_ALIASES[joined] !== undefined
      ? `${joined} ${text.slice(dotted.length)}`
      : text;
  return head
    .replace(/\bnr *\.?/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
};

/**
 * Parse a citation into a `{ actType, actNumber, actYear }` key with an empty
 * `issuerSlug` (the citation key lookup matches on the first three; the repo
 * picks the highest-in_degree act when several issuers share the number/year).
 *
 * Returns null when no numbered citation shape is present.
 */
export const parseCitation = (raw: string): (LegalCitationKey & { issuerSlug: string }) | null => {
  const text = normalize(raw);
  // <typeword> ... <number>/<year>  e.g. "legea 227/2015", "oug 57 / 2019"
  const m = /^([a-z]+)\b.*?(\d{1,5})\s*\/\s*(\d{4})\b/u.exec(text);
  if (m === null) return null;
  const [, typeWord, num, year] = m;
  const actType = TYPE_ALIASES[typeWord ?? ''];
  if (actType === undefined || num === undefined || year === undefined) return null;
  const y = Number(year);
  if (y < 1850 || y > 2100) return null;
  return { actType, actNumber: num, actYear: y, issuerSlug: '' };
};

/**
 * The query IS one citation: a type word, an optional "nr.", the number and the
 * year, and nothing else. Issuer words ("ordinul ministrului finanțelor nr.
 * 1/2020"), a second citation ("legea 227/2015 și legea 95/2006") or trailing text
 * are constraints this key cannot express, so they return null: the caller must
 * not answer such a query with the key's acts as if it were exact (I-21).
 */
export const parseExactCitation = (raw: string): LegalCitationKey | null => {
  const text = normalize(raw).replace(/ ?[,;.:?!]+$/u, '');
  const m = /^([a-z]+) ?(\d{1,5}) ?\/ ?(\d{4})$/u.exec(text);
  if (m === null) return null;
  const [, typeWord, num, year] = m;
  const actType = TYPE_ALIASES[typeWord ?? ''];
  if (actType === undefined || num === undefined || year === undefined) return null;
  const y = Number(year);
  if (y < 1850 || y > 2100) return null;
  return { actType, actNumber: num, actYear: y, issuerSlug: '' };
};
