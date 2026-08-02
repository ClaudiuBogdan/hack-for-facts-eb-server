/**
 * Legal module — version provenance for served text (§5.2-C honesty). Pure.
 *
 * The corpus is **original published texts only**: `act_documents.version_kind`
 * is `original|corp|stub-header|republicare` and `'consolidare'` is 0 rows
 * (verified on prod 2026-08-01). So an act's served text/summary is the act AS
 * PUBLISHED, not the law as it stands — Legea nr. 227/2015 serves its 2015 text
 * while carrying 295 incoming modifica/completeaza edges. Every text answer must
 * say so; these helpers render that in Romanian.
 *
 * FORWARD-COMPAT (the reason `latestConsolidation*` exists before the data does):
 * when the consolidation-timeline lane loads `version_kind='consolidare'` rows,
 * `latestConsolidationDate` turns non-null and the note gains its clause with NO
 * change here. Today the lookup finds nothing and the clause is simply absent.
 */

import type { LegalVersionProvenance } from './types.js';

/**
 * `version_kind` → how to name that text to a reader. `corp` is the body document
 * linked to a stub-header and `stub-header` is a header-only expression: both are
 * the act as first published, so both read as "original". `republicare` is a
 * republished form — calling it "original" would misdate it by years.
 */
const KIND_LABEL: Record<string, string> = {
  original: 'text original',
  corp: 'text original',
  'stub-header': 'text original',
  republicare: 'text republicat',
  consolidare: 'text consolidat',
};

const UNKNOWN_KIND_LABEL = 'versiune necunoscută';

/**
 * The kinds that ARE the act as first published. Only for these can we say the
 * amendments came "de atunci": the count is every incoming modifica/completeaza
 * edge on the act, unscoped by date, so against a LATER expression (a
 * republication, or a non-canonical document addressed directly) some of those
 * edges may predate the text being shown. An unknown kind falls here too — the
 * neutral wording is the safe default.
 */
const PUBLISHED_FORM_KINDS = new Set(['original', 'corp', 'stub-header']);

/**
 * The result-set caveat for `legalSearch` / `search_legal_acts`: one line saying
 * the whole answer set is published-form text. Per-hit counts ride on each hit's
 * own provenance note.
 */
export const LEGAL_ORIGINAL_TEXT_CAVEAT =
  'Textele și rezumatele servite sunt versiunile publicate ale actelor și nu garantează forma consolidată curentă — verificați forma în vigoare pe legislatie.just.ro.';

/**
 * Romanian binds a numeral to its noun with `de` from 20 upward, and for compound
 * numerals the LAST TWO DIGITS decide: 104 is "104 ori", 120 is "120 de ori".
 * Five acts in the corpus land in that 1–19 tail (104, 107, 108, 109, 204), so a
 * plain `n >= 20` test would misword all of them.
 */
export const countWithNoun = (n: number, noun: string): string => {
  const tail = n % 100;
  return tail >= 1 && tail <= 19 ? `${String(n)} ${noun}` : `${String(n)} de ${noun}`;
};

/**
 * The status-badge clause. Zero is its own sentence — "modificat de 0 acte" is
 * nonsense — and 4,771 acts (nearly half the amended corpus) need the singular.
 */
export const amendmentCountPhrase = (n: number): string => {
  if (n === 0) return 'nicio modificare înregistrată';
  if (n === 1) return 'modificat de un act';
  return `modificat de ${countWithNoun(n, 'acte')}`;
};

/**
 * The amendment clause inside the provenance note. Against a published form the
 * edges genuinely post-date the text, so "de atunci" is fair; against any later
 * or unknown expression we report operations recorded ON THE ACT without
 * claiming they came after the date being shown.
 */
const amendedClause = (n: number, versionKind: string): string => {
  if (n === 0) return 'nicio modificare înregistrată';
  if (PUBLISHED_FORM_KINDS.has(versionKind)) {
    return n === 1
      ? 'modificat o dată de atunci'
      : `modificat de ${countWithNoun(n, 'ori')} de atunci`;
  }
  return n === 1
    ? 'o operațiune de modificare/completare înregistrată pentru act'
    : `${countWithNoun(n, 'operațiuni')} de modificare/completare înregistrate pentru act`;
};

/**
 * Render the honesty note for one act's served text. The verify clause points at
 * `sourceUrl` (legislatie.just.ro) and NOTHING else — our own act page serves the
 * stale text this note exists to warn about. No link → no clause.
 */
export const versionProvenanceNote = (p: LegalVersionProvenance): string => {
  const label = KIND_LABEL[p.versionKind] ?? UNKNOWN_KIND_LABEL;
  const dated =
    p.versionDate === null ? `${label} (dată necunoscută)` : `${label} din ${p.versionDate}`;
  const amended = amendedClause(p.amendedAfterPublication, p.versionKind);
  const consolidation =
    p.latestConsolidationDate === null
      ? ''
      : `; ultima consolidare ${p.latestConsolidationDate}${
          p.latestConsolidationLoaded ? '' : ' (neîncărcată încă)'
        }`;
  const hasNewer = p.amendedAfterPublication > 0 || p.latestConsolidationDate !== null;
  const verify =
    p.sourceUrl !== null && hasNewer
      ? ` — verifică forma consolidată pe portal: ${p.sourceUrl}`
      : '';
  return `${dated}; ${amended}${consolidation}${verify}`;
};
