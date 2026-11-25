/**
 * 11+ digits, joined by at most one white-space character or dash each (how a code is split when
 * written: NBSP, thin space and tab are white space after NFKD, and NEL (U+0085, which `\s` omits);
 * U+2010–2014 stay dashes, U+2212 too).
 */
const PERSON_CODE_RUN = /[0-9]([\s\u0085\p{Pd}−]?[0-9]){10,}/u;
/** Invisible characters that split a digit run without showing: format characters, Hangul fillers. */
const INVISIBLE = /[\p{Cf}ᅟᅠㅤﾠ]/gu;

/**
 * A run of more than an organization code's digits (11+, also split by single white space or dashes):
 * the kernel treats such an identifier as a person's. A slash, a dot or a date does not join a run,
 * so a document number next to a date ("HCL nr. 123/24.11.2026") is no code. Refused where a
 * caller's text is echoed and matches no number column (analysis scope q, CPV q, totals q); the
 * legacy search q still matches contract numbers that long (50 bare ones on 24 Nov). Shared by
 * procurement (`free-text-rule.ts`) and the share-link guard (`share/core/personal-code-url.ts`).
 */
export const hasPersonCodeRun = (text: string): boolean =>
  PERSON_CODE_RUN.test(text.normalize('NFKD').replace(INVISIBLE, ''));
