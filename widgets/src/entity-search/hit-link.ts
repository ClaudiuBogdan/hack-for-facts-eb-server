/**
 * Entity-search widget — where a row opens and what registry status it shows.
 * Pure (no DOM), so it is unit-tested apart from the widget's bootstrap.
 */

export const SITE_BASE = 'https://transparenta.eu';

export interface HitLinkView {
  /** The client page the server built for this hit (registry NGOs), with the environment's base. */
  readonly link?: string;
  /** The index's own url: external source deep-links or site-relative paths. */
  readonly url?: string;
}

const isHttp = (value: string): boolean => /^https?:\/\//i.test(value);

/**
 * The page a row opens. The server's `link` first — the hit's client page,
 * built with the environment's own base (registry NGOs, whose index documents
 * carry no url) — then the index's `url`. Both are treated as untrusted: only
 * absolute http(s) URLs, or a site-relative path for `url`; anything else
 * (other schemes, protocol-relative `//`, host-suffix fragments) is dropped.
 */
export const hitHref = (hit: HitLinkView): string | undefined => {
  if (hit.link !== undefined && isHttp(hit.link)) return hit.link;
  const url = hit.url;
  if (url === undefined || url === '') return undefined;
  if (isHttp(url)) return url;
  if (url.startsWith('/') && !url.startsWith('//')) return `${SITE_BASE}${url}`;
  return undefined;
};

/**
 * The chip a registry NGO shows: its legal registry status where it is one of
 * the registry's closing statuses, in the registry's own words. None for a
 * registered NGO, an absent status, or a status the widget does not know (as
 * the client: an unknown status is never shown as closed). A switch, so no
 * inherited key of an object (`constructor`, `__proto__`) can pass for one.
 */
export const ngoStatusChip = (status: string | undefined): string | undefined => {
  switch (status?.trim()) {
    case 'Radiat':
      return 'Radiat';
    case 'Dizolvata':
      return 'Dizolvată';
    case 'In Lichidare':
      return 'În lichidare';
    default:
      return undefined;
  }
};
