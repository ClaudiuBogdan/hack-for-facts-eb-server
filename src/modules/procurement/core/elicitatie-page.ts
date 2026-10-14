/**
 * P33 — a record's own page on e-licitatie.ro.
 *
 * The portal addresses a page by its internal numeric id, never by the public
 * number (CAN…, SCNA…, DA…) that the data.gov.ro exports carry. A record links
 * only when that id is known:
 *
 *   - `own_record`: the record was captured from e-licitatie and carries its id.
 *   - `number_and_buyer`: a data.gov.ro award row whose public number and buyer
 *     CUI equal exactly one captured e-licitatie award notice
 *     (user decision 2026-10-14: an exact match only, never a guessed link).
 *     Several candidates or none leave the record without a link.
 *
 * The data.gov.ro `sourceUrl` stays the record's custody link; this is an
 * additional, navigational field.
 */

export type ElicitatiePageKind = 'award_notice' | 'direct_acquisition';
export type ElicitatiePageMatch = 'own_record' | 'number_and_buyer';

export interface ElicitatiePage {
  readonly url: string;
  readonly kind: ElicitatiePageKind;
  readonly match: ElicitatiePageMatch;
}

export const ELICITATIE_PUBLIC_ORIGIN = 'https://e-licitatie.ro';

/** Native refs as the scrapper writes them (procedures.source_ref, direct_acquisitions.da_key). */
export const NATIVE_NOTICE_REF_PREFIX = 'elicitatie:';
export const NATIVE_DA_KEY_PREFIX = 'elicitatie_da:';

const PORTAL_ID_PATTERN = /^[1-9]\d{0,18}$/u;

const PAGE_PATH: Record<ElicitatiePageKind, string> = {
  award_notice: '/pub/notices/ca-notices/view-c/',
  direct_acquisition: '/pub/direct-acquisition/view/',
};

/** The portal page for an id, or null when the id is not a portal id. */
export const elicitatiePageOf = (
  kind: ElicitatiePageKind,
  portalId: string | null,
  match: ElicitatiePageMatch
): ElicitatiePage | null => {
  if (portalId === null || !PORTAL_ID_PATTERN.test(portalId)) return null;
  return { url: `${ELICITATIE_PUBLIC_ORIGIN}${PAGE_PATH[kind]}${portalId}`, kind, match };
};

/** `elicitatie:100426518` → `100426518`; anything else → null. */
export const portalIdFromRef = (ref: string | null, prefix: string): string | null => {
  if (ref?.startsWith(prefix) !== true) return null;
  const id = ref.slice(prefix.length);
  return PORTAL_ID_PATTERN.test(id) ? id : null;
};

/**
 * The accepted rule's last step: exactly one distinct captured candidate.
 * Several distinct portal ids are ambiguous, so the record gets no link. A null
 * entry is a candidate that may not be served (restricted, or not a portal
 * ref): it still counts, so it never leaves another candidate looking unique.
 */
export const soleCandidate = (ids: readonly (string | null)[]): string | null => {
  if (ids.some((id) => id === null)) return null;
  const distinct = new Set(ids);
  if (distinct.size !== 1) return null;
  const [only] = distinct;
  return only ?? null;
};
