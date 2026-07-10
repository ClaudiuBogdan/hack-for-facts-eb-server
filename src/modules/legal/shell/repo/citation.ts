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

import type { LegalCitationKey } from '../../core/types.js';

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
 * Parse a citation into a `{ actType, actNumber, actYear }` key with an empty
 * `issuerSlug` (the citation key lookup matches on the first three; the repo
 * picks the highest-in_degree act when several issuers share the number/year).
 *
 * Returns null when no numbered citation shape is present.
 */
export const parseCitation = (raw: string): (LegalCitationKey & { issuerSlug: string }) | null => {
  const text = fold(raw).replace(/nr\.?/gu, ' ').replace(/\s+/gu, ' ').trim();
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
