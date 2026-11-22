/**
 * The human citation of a legal_v2 act (pure).
 *
 * legal_v2 stores the act's natural key (`lege:363:2018:`) in
 * `acts.display_citation`: the raw projection's v0 placeholder "until the
 * loader's citation formatter is ported" (15-raw-projection.sql). The legacy
 * `legal.acts.display_citation` is that formatter's output, computed in the
 * scrapper by `displayCitation` (portal-legislativ/prod/identity.ts). This is
 * a port of that function over legal_v2's own identity (type, number, year,
 * issuer): a citation is identity, so it is never bridged from `legal`.
 *
 * Where the legacy formatter fell back to the document's denomination (an
 * unknown type, or no number or year), legal_v2 has none; the fallback is a
 * readable form of the type with whatever number and year the act has. A
 * stored citation that is no longer the natural key (the loader ported the
 * formatter) is served as stored.
 */

/** The legacy labels, verbatim (identity.ts displayCitation). */
const LABELS: Readonly<Record<string, string>> = {
  lege: 'Legea',
  oug: 'OUG',
  og: 'OG',
  ordin: 'Ordinul',
  decizie: 'Decizia',
  decret: 'Decretul',
  'decret-lege': 'Decretul-lege',
};

/**
 * identity.ts GOVERNMENT_BODY (I-25): a committee or office under the
 * Government adopts its own decisions, which are not Government decisions.
 * Applied to the issuer slug with its hyphens read as spaces.
 */
const GOVERNMENT_BODY =
  /\bguvernul\b[^a-z]*(?:romaniei\b)?[^a-z]*(?:comitetul|comisia|oficiul|consiliul|departamentul|secretariatul|cancelaria|agentia|autoritatea|corpul|institutul)\b/u;

const typeLabel = (type: string, issuerSlug: string | null): string | null => {
  if (Object.hasOwn(LABELS, type)) return LABELS[type] ?? null;
  if (type === 'hotarare') {
    const issuer = (issuerSlug ?? '').replace(/-/gu, ' ');
    return issuer.includes('guvernul') && !GOVERNMENT_BODY.test(issuer) ? 'HG' : 'Hotărârea';
  }
  return null;
};

/** `anexa` → `Anexa`, `cod-procedura` → `Cod procedura`: a readable type. */
const fallbackLabel = (type: string): string => {
  const words = type.replace(/[-_]+/gu, ' ').trim();
  if (words === '' || words === 'unknown') return 'Act';
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

export interface V2CitationParts {
  readonly actNaturalKey: string;
  readonly actType: string;
  readonly actNumber: string | null;
  readonly actYear: number | null;
  readonly issuerSlug: string | null;
  readonly storedCitation: string;
}

export const v2DisplayCitation = (p: V2CitationParts): string => {
  if (p.storedCitation !== '' && p.storedCitation !== p.actNaturalKey) return p.storedCitation;
  const number = p.actNumber !== null && p.actNumber !== '' ? p.actNumber : null;
  const label = typeLabel(p.actType, p.issuerSlug);
  if (label !== null && number !== null && p.actYear !== null) {
    return `${label} nr. ${number}/${String(p.actYear)}`;
  }
  const head = label ?? fallbackLabel(p.actType);
  if (number !== null && p.actYear !== null) return `${head} nr. ${number}/${String(p.actYear)}`;
  if (number !== null) return `${head} nr. ${number}`;
  if (p.actYear !== null) return `${head} din ${String(p.actYear)}`;
  return head;
};
