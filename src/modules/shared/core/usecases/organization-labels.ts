/**
 * Shared Kernel — batch organization labels (the identity-naming surface).
 *
 * Lives in the KERNEL, not in a source module: it reads only `core.organizations`
 * through the kernel `IdentityRepo` and applies a platform-wide identity policy.
 * Owning it in `reference` would make procurement (and every other consumer)
 * depend on a source module being mounted to name a party.
 *
 * Why the spine and not a role registry — measured on prod 2026-07-25:
 * `core.public_entities` is the public-INSTITUTION registry, so resolving buyer
 * names there returns nothing for 1,799 of 8,268 procurement buyers, which is
 * 41.5% of all contract award value (CFR, CNI, CNIR, Transgaz, Nuclearelectrica…
 * are state COMPANIES). The spine covers every role, with the canonical name
 * already chosen by the per-kind source ladder (CORE_ENTITIES.md §4).
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '../errors.js';
import { isWithheldOrganizationIdentifier, normalizeCui, type Cui } from '../types.js';

import type { IdentityRepo } from '../ports.js';

/**
 * Public request bound. This is a PUBLIC endpoint, so an unbounded CUI list lets
 * one request fan out into arbitrarily many statements and an arbitrarily large
 * response. Rejected with a typed error rather than truncated: silently dropping
 * the overflow would answer "unidentified" for real organizations with no way
 * for the caller to tell (AGENTS.md — no silent caps).
 *
 * 250 covers the measured consumer need: the procurement leaderboard asks for
 * `PROCUREMENT_RANKINGS_TOP_N` = 100 buyers plus 100 suppliers.
 */
export const MAX_ORGANIZATION_LABELS = 250;

export type OrganizationLabelStatus = 'named' | 'placeholder' | 'unavailable';

export interface OrganizationLabel {
  /**
   * The NORMALIZED identifier, or null when the input was withheld or
   * malformed — a withheld identifier must never be reflected back into a
   * response, and the `CUI` scalar promises normalized digits. Callers correlate
   * by POSITION: the result is always the same length as the request, in order.
   */
  readonly cui: Cui | null;
  readonly canonicalName: string | null;
  readonly displayName: string | null;
  readonly kind: string | null;
  readonly status: OrganizationLabelStatus;
}

const UNAVAILABLE: OrganizationLabel = {
  cui: null,
  canonicalName: null,
  displayName: null,
  kind: null,
  status: 'unavailable',
};

/**
 * A minted placeholder stores the CUI itself as its name
 * (`sources/unified/lanes/mint-missing-core.ts`, per CORE_ENTITIES.md §5).
 *
 * Tested by EQUALITY, not by "looks numeric": exactly one organization on prod
 * carries a numeric name that differs from its CUI, and a broader test would
 * suppress it — and any future legitimate numeric registry name.
 */
export const isPlaceholderName = (name: string, cui: Cui): boolean => name.trim() === cui;

export interface OrganizationLabelsDeps {
  readonly identityRepo: IdentityRepo;
}

export const makeOrganizationLabels = async (
  deps: OrganizationLabelsDeps,
  rawCuis: readonly string[]
): Promise<Result<readonly OrganizationLabel[], ApiError>> => {
  if (rawCuis.length > MAX_ORGANIZATION_LABELS) {
    return err(
      invalidInput(
        `at most ${String(MAX_ORGANIZATION_LABELS)} identifiers per request (received ${String(rawCuis.length)})`,
        'cuis'
      )
    );
  }

  // Withheld and malformed inputs are resolved to null HERE, so they never reach
  // the repo and never appear in the answer. They are indistinguishable from an
  // unknown CUI on purpose: the status must not confirm that an identity exists.
  const normalized = rawCuis.map((raw) => {
    const cui = normalizeCui(raw);
    return cui !== null && !isWithheldOrganizationIdentifier(cui) ? cui : null;
  });

  const servable = normalized.filter((c): c is Cui => c !== null);
  const found = await deps.identityRepo.findManyByCui(servable);
  if (found.isErr()) return err(found.error);

  return ok(
    normalized.map((cui): OrganizationLabel => {
      if (cui === null) return UNAVAILABLE;
      const org = found.value.get(cui);
      if (org?.cui == null) return { ...UNAVAILABLE, cui };
      const placeholder = isPlaceholderName(org.name, org.cui);
      return {
        cui: org.cui,
        canonicalName: placeholder ? null : org.name,
        // Always null: the derived `core.organizations.display_name` mangles
        // 585,811 rows (diacritics, and acronyms such as CFR → Cfr), and
        // CORE_ENTITIES.md §4 makes the raw registry string canonical.
        displayName: null,
        kind: org.kind,
        status: placeholder ? 'placeholder' : 'named',
      };
    })
  );
};
