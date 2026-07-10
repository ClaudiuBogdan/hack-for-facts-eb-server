/**
 * Monitorul-Oficial (`mo/` area, plan 06) — the issuer-keyed cross-source
 * contributor (§4 / §14.7). MO has **no CUI** (gazette acts are not organizations),
 * so the link is **org name → issuer_slug** (best-effort, low-confidence). This is
 * the SINGLE module contributor (`source:'monitorul-oficial'`); the legal acts area
 * registers none (05 §4).
 *
 * Resolution path: `cui → org (kernel IdentityRepo.findByCui) → fold(name) → slug
 * candidates → countPublicationsByPartForIssuer/getIssuerSummary`. It is **never**
 * asserted as a CUI-grade link; `MoIssuerSummary.matchConfidence` labels it. If the
 * org or a matching issuer is absent, returns `null` gracefully (never an error).
 */

import { err, ok, type Result } from 'neverthrow';

import {
  foldDiacritics,
  type ApiError,
  type Cui,
  type EntityProfileSlice,
  type IdentityRepo,
  type SourceContributor,
  type SourcePresence,
} from '@/modules/shared/index.js';

import type { MonitorulRepo } from './ports.js';
import type { MoIssuerSummary } from './types.js';

const MO_SOURCE = 'monitorul-oficial';

export interface MoContributorDeps {
  readonly repo: MonitorulRepo;
  readonly identity: IdentityRepo;
}

/** Fold a name/slug to a comparable token set (diacritics + non-alnum stripped). */
const tokenize = (s: string): Set<string> =>
  new Set(
    foldDiacritics(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((t) => t.length > 2) // drop "de"/"al"/"a" noise words
  );

/**
 * Guard the best-effort org-name → issuer-slug match (Codex #5): accept only when
 * a clear majority of the issuer slug's significant tokens appear in the org name
 * (Jaccard-style containment). This rejects a spurious top-by-count hit whose name
 * doesn't actually match the organization.
 */
export const isPlausibleMatch = (orgName: string, issuerSlug: string): boolean => {
  const slugTokens = tokenize(issuerSlug.replace(/-/gu, ' '));
  if (slugTokens.size === 0) return false;
  const nameTokens = tokenize(orgName);
  let overlap = 0;
  for (const t of slugTokens) if (nameTokens.has(t)) overlap++;
  return overlap / slugTokens.size >= 0.6;
};

/**
 * Resolve a CUI to the best-effort issuer summary, or null. Looks up the org by
 * CUI, derives candidate `issuer_slug`s from its name (the slugs are themselves
 * diacritics-folded hyphenated names), and counts publications. We do NOT invent
 * slugs blindly: we probe the resolver (name → existing slugs) so a no-match
 * returns null rather than a zero-count phantom.
 */
const resolveIssuerForCui = async (
  deps: MoContributorDeps,
  cui: Cui
): Promise<Result<MoIssuerSummary | null, ApiError>> => {
  const orgRes = await deps.identity.findByCui(cui);
  if (orgRes.isErr()) return err(orgRes.error);
  const org = orgRes.value;
  if (org === null) return ok(null);

  // Probe issuer slugs by the org name (folded ILIKE over distinct slugs). Take a
  // few candidates and accept the first that PLAUSIBLY matches the org name (token
  // containment guard, Codex #5) — not merely the top-by-count fuzzy hit.
  const hitsRes = await deps.repo.resolveIssuer(org.name, 5);
  if (hitsRes.isErr()) return err(hitsRes.error);
  const match = hitsRes.value.find((h) => h.value !== '' && isPlausibleMatch(org.name, h.value));
  if (match === undefined) return ok(null);

  return deps.repo.getIssuerSummary(match.value);
};

/** Project the issuer summary into the open entity-360 slice shape. */
export const toMoProfileSlice = (summary: MoIssuerSummary): EntityProfileSlice => {
  const topType = summary.topActTypes[0];
  const slugLabel = summary.issuerSlug !== null ? summary.issuerSlug.replace(/-/gu, ' ') : 'issuer';
  const summaryText =
    `${slugLabel}: ${String(summary.publicationCount)} gazette publication(s)` +
    (topType !== undefined ? `; top type ${topType}` : '') +
    (summary.lastIssueDate !== null ? `; last ${summary.lastIssueDate}` : '') +
    ` (best-effort issuer match).`;
  return {
    source: MO_SOURCE,
    kind: 'mo_issuer_summary',
    summary: summaryText,
    data: summary as unknown as Record<string, unknown>,
  };
};

export const makeMonitorulContributor = (deps: MoContributorDeps): SourceContributor => ({
  source: MO_SOURCE,

  async presenceFor(cui: Cui): Promise<Result<SourcePresence | null, ApiError>> {
    const res = await resolveIssuerForCui(deps, cui);
    if (res.isErr()) return err(res.error);
    const summary = res.value;
    if (summary === null || summary.publicationCount === 0) return ok(null);
    return ok({
      source: MO_SOURCE,
      present: true,
      label: 'Monitorul Oficial',
      count: summary.publicationCount,
      badges: ['mo-issuer'],
      ...(summary.lastIssueDate !== null && { asOf: { publications: summary.lastIssueDate } }),
      attrs: {
        issuerSlug: summary.issuerSlug,
        topActTypes: summary.topActTypes,
        matchConfidence: summary.matchConfidence,
      },
    });
  },

  async profileSlice(cui: Cui): Promise<Result<EntityProfileSlice | null, ApiError>> {
    const res = await resolveIssuerForCui(deps, cui);
    if (res.isErr()) return err(res.error);
    return ok(res.value === null ? null : toMoProfileSlice(res.value));
  },
});
