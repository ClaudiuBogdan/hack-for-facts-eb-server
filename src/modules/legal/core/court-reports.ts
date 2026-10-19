/**
 * I-28 (scrapper `src/sources/portal-legislativ/prod/status.ts`, `courtRole`
 * and `timelineEvents`; keep the two in step): a judgment does not amend,
 * complete or suspend the act it cites. Two source readings of a stratified 30
 * of the 906 such references (2026-10-19) found none was the court's own
 * effect: 17 report another act's change, 10 are mentions, 3 rejected
 * challenges. The status timeline no longer stores them as events; the API
 * timeline must not rebuild them from the references either.
 *
 * Kept: an administrative court's (`contencios`) annulments and suspensions of
 * execution, a court's effect on another court decision (appeals), a court's
 * own `hotarare` (a plenary or board resolution, except the ECtHR's, which is
 * its judgment), judicial repeal references (kept as status events too), and
 * any act the predicate cannot classify.
 */

/** Issuers whose decisions are judgments (anchored: a joint order naming a court, the Court of Accounts or the CSM is not one). */
const COURT_ISSUER =
  /^(?:curtea-constitutionala|inalta-curte-de-casatie-si-justitie|curtea-suprema-de-justitie|curtea-de-apel-|tribunalul-|judecatoria-|curtea-europeana-a-drepturilor)/;

export type CourtRole = 'annulment' | 'judicial';

export interface CourtClassifiable {
  readonly actType: string;
  readonly issuerSlug: string | null;
}

export const courtRole = (act: CourtClassifiable | null | undefined): CourtRole | null => {
  const issuer = act?.issuerSlug ?? '';
  if (act === null || act === undefined || !COURT_ISSUER.test(issuer)) return null;
  if (act.actType === 'hotarare' && !issuer.startsWith('curtea-europeana')) return null;
  return issuer.includes('contencios') ? 'annulment' : 'judicial';
};

const REPORT_RELATIONS: ReadonlySet<string> = new Set(['modifica', 'completeaza', 'suspenda']);

/**
 * A judicial court's amendment, completion or suspension reference to an act
 * that is not itself a court decision. Unknown source (no role) or unknown
 * target: not a report.
 */
export const isCourtReport = (
  relation: string,
  source: CourtClassifiable | null | undefined,
  target: CourtClassifiable | null | undefined
): boolean =>
  REPORT_RELATIONS.has(relation) &&
  courtRole(source) === 'judicial' &&
  target !== null &&
  target !== undefined &&
  courtRole(target) === null;
