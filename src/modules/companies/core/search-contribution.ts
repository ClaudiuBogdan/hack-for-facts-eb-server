/**
 * Companies module — the company contribution of the kernel global search
 * (scrapper `search-generation-control-contract.md` §2 and §6). Pure: the
 * pin-once / recheck orchestration and the value mapping over two ports.
 *
 * The kernel hands over the CUI identities of one candidate page (at most
 * 50; every canonical CUI key of 1–10 digits, short ones such as `1`
 * included: the PRIVACY population) and receives, read fresh under ONE
 * captured registry scope:
 *  - the core parent class of each CUI: `private` (a known core organization
 *    of any kind that is not public, a NULL class included: the candidate is
 *    withheld whatever role it plays), `company` (a public company parent of
 *    the ONRC company-contribution shape, 2–10 digits: the public directory
 *    spine, natural-person forms and core-only companies included) or `none`;
 *  - for company parents, when asked and the scope is published, the current
 *    company values under the pinned edition, attributed like every other
 *    company label of this API (`displayName`), and the county of the
 *    identity's own public institution role, if any (generic-county fallback).
 * The read is rechecked before returning (`runPinned`); the final decision
 * for a served answer is `confirmServedScope` on the same scope key. The
 * broader company profile / history / directory admission is NOT changed here
 * and declares no CUI shape legally invalid.
 */

import { err, type Result } from 'neverthrow';

import {
  MAX_SERVED_CUI_DIGITS,
  invalidInput,
  serviceUnavailable,
  type ApiError,
  type SearchCompanyContributionPort,
  type SearchCuiParent,
  type SearchHitCompany,
} from '@/modules/shared/index.js';

import {
  REGISTRY_MOVED_MESSAGE,
  confirmServedScope,
  displayName,
  isPublished,
  registryScopeKey,
  runPinned,
  scopeFromKey,
  type CompanyRegistryCuiProfile,
  type CompanyRegistryEnvelope,
  type CompanyRegistryScopePort,
} from './registry.js';

/** One candidate page of the global search (its limit bound). */
export const SEARCH_HYDRATION_BOUND = 50;

/**
 * The privacy population's key shape: a canonical positive CUI (no sign, no
 * leading zero) within the served bound. Anything else is refused, never
 * normalized: the kernel withholds such candidates itself.
 */
const CANONICAL_CUI = new RegExp(`^[1-9][0-9]{0,${String(MAX_SERVED_CUI_DIGITS - 1)}}$`, 'u');

/** The repository read behind the contribution (one bounded batch per call). */
export interface CompanySearchReadPort {
  /**
   * The parent class of every CUI (any kind) and, when `withValues` (only
   * ever true for a published scope), the current values and the own public
   * institution county of the public company parents of the ONRC company
   * shape (2–10 digits). Exactly one entry per requested CUI.
   */
  readSearchCompanies(
    cuis: readonly string[],
    scope: CompanyRegistryEnvelope,
    withValues: boolean
  ): Promise<Result<ReadonlyMap<string, SearchCuiParent>, ApiError>>;
}

/** A personal-shaped identifier value, withheld from every identifier list (§2). */
const PERSONAL_SHAPED = /^(RO)?[0-9]{11,}$/iu;

/**
 * The current company values of one public company parent under the pinned
 * edition (`profile` null: not in the edition). Activity: true on any public
 * original 1048, false only with complete status coverage, else unknown.
 */
export const companySearchValues = (input: {
  readonly coreName: string;
  readonly profile: CompanyRegistryCuiProfile | null;
  readonly hasActiveObservation: boolean;
  readonly identifiers: readonly string[];
}): SearchHitCompany => {
  const { profile } = input;
  const { name, nameSource } = displayName(input.coreName, profile);
  return {
    registryState: profile === null ? 'not_in_edition' : 'in_edition',
    name,
    nameSource,
    legalForm: profile?.legalForm.value ?? null,
    countyCode: profile?.countyCode.value ?? null,
    countyName: profile?.countyName ?? null,
    active: input.hasActiveObservation
      ? true
      : profile?.statusCoverage === 'complete'
        ? false
        : null,
    identifiers: input.identifiers.filter((value) => !PERSONAL_SHAPED.test(value)),
  };
};

export const makeCompanySearchContribution = (
  scopePort: CompanyRegistryScopePort,
  reader: CompanySearchReadPort
): SearchCompanyContributionPort => ({
  hydrate: async (cuis, withValues) => {
    const requested = [...new Set(cuis)];
    if (requested.length > SEARCH_HYDRATION_BOUND) {
      return err(
        invalidInput(
          `at most ${String(SEARCH_HYDRATION_BOUND)} search candidates per company read`,
          'cuis'
        )
      );
    }
    if (!requested.every((cui) => CANONICAL_CUI.test(cui))) {
      return err(invalidInput('search candidates must be canonical CUIs', 'cuis'));
    }
    const pinned = await runPinned(
      scopePort,
      (scope) => reader.readSearchCompanies(requested, scope, withValues && isPublished(scope)),
      // Recheck what would be served: a CUI turning private moves the scope.
      (parents) =>
        [...parents.entries()].flatMap(([cui, parent]) => (parent.kind === 'private' ? [] : [cui]))
    );
    return pinned.map(({ value, scope }) => ({
      scopeKey: registryScopeKey(scope),
      published: isPublished(scope),
      parents: value,
    }));
  },
  confirm: async (scopeKey, cuis) => {
    const scope = scopeFromKey(scopeKey);
    // Only keys this API issued are ever handed back here.
    if (scope === null) return err(serviceUnavailable(REGISTRY_MOVED_MESSAGE));
    return confirmServedScope(scopePort, scope, cuis);
  },
});
