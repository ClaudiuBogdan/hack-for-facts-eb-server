/**
 * Companies module — cross-source contributor (plan §4, §14.7).
 *
 * Registers ONE `SourceContributor` (`source: 'companies'`) into the kernel
 * registry. `presenceFor` powers entity-360 badges; `profileSlice` is the SINGLE
 * cross-source mechanism — the GraphQL `Entity.company` resolver resolves through
 * THIS (via the kernel `makeEntityProfileSlice`), not a divergent path. The
 * kernel entity-360, `get_entity_snapshot` and ask context inherit these
 * summaries, so they carry the same registry semantics: ONRC values only as
 * the pinned edition's qualified consensus, the registry state otherwise.
 *
 * Guarded facts: a registry guard refusal (the scope moved, the parent turned
 * non-public, the parent check is unreadable) is an `accessRefused` error, so
 * the composing entity response withholds the entity instead of reading it as
 * a missing badge. `confirmServed` is the final decision the composing
 * response takes after its fan-out, for the scope each served fact names.
 *
 * Identity is link-not-merge: presence is keyed by CUI on the public `company`
 * spine of `core.organizations`; this module never reassigns `org_id`s.
 * `flow_type` registered: NONE (companies only appear as a flows payee).
 */

import { ok, err, type Result } from 'neverthrow';

import {
  accessRefused,
  normalizeCui,
  type ApiError,
  type Cui,
  type EntityProfileSlice,
  type SourceContributor,
  type SourcePresence,
} from '@/modules/shared/index.js';

import {
  confirmServedScope,
  isRegistryGuardRefusal,
  registryScopeKey,
  scopeFromKey,
  type CompanyRegistryEnvelope,
} from '../core/registry.js';
import {
  isWithheldCompanyIdentifier,
  makeCompanyEntitySlices,
  makeCompanyPresence,
} from '../core/usecases.js';

import type { CompaniesRepository } from '../core/ports.js';

const COMPANIES_SOURCE = 'companies';

/** A registry guard refusal as the kernel's typed access refusal; any other error stays advisory. */
const asGuardError = (error: ApiError): ApiError =>
  isRegistryGuardRefusal(error) ? accessRefused(error.message) : error;

/**
 * The scope a served presence (its `registryScopeKey`) or slice (its envelope)
 * was read under, re-derived through its key: only a scope this API issues.
 */
const servedScope = (
  served: SourcePresence | EntityProfileSlice
): CompanyRegistryEnvelope | null => {
  if ('present' in served) {
    const key = served.attrs?.['registryScopeKey'];
    return typeof key === 'string' ? scopeFromKey(key) : null;
  }
  const registry: unknown = served.data?.['registry'];
  return typeof registry === 'object' && registry !== null
    ? scopeFromKey(registryScopeKey(registry as CompanyRegistryEnvelope))
    : null;
};

export const makeCompaniesContributor = (repo: CompaniesRepository): SourceContributor => ({
  source: COMPANIES_SOURCE,

  async presenceFor(cui: Cui): Promise<Result<SourcePresence | null, ApiError>> {
    // Withheld identifiers (>10 digits, CNP-shaped) contribute NOTHING —
    // absence, not an error, so an entity-360 page renders without a company
    // badge and the response never confirms a registry row exists.
    if (isWithheldCompanyIdentifier(cui)) return ok(null);
    const res = await makeCompanyPresence({ repo }, cui);
    if (res.isErr()) return err(asGuardError(res.error));
    const p = res.value.presence;
    if (p === null) return ok(null);

    const badges: string[] = ['company'];
    // Only a complete status consensus of the pinned edition is a status badge.
    if (p.headlineStatus !== null) badges.push(`status:${p.headlineStatus}`);
    if (p.financials > 0) badges.push('has-financials');

    const asOf: Record<string, string | null> = {};
    if (p.onrcAsOf !== null) asOf['onrc'] = p.onrcAsOf;
    if (p.anafAsOf !== null) asOf['anaf'] = p.anafAsOf;

    return ok({
      source: COMPANIES_SOURCE,
      present: true,
      label: 'Company',
      // `count` = number of financial-statement years on file (the entity-360 badge metric).
      count: p.financials,
      badges,
      ...(Object.keys(asOf).length > 0 && { asOf }),
      attrs: {
        name: p.name,
        nameSource: p.nameSource,
        registryCuiState: p.registryCuiState,
        registryState: res.value.registry.state,
        registryEditionId: res.value.registry.editionId,
        // The scope this presence was read under (the final decision rechecks it).
        registryScopeKey: registryScopeKey(res.value.registry),
        headlineStatus: p.headlineStatus,
        financials: p.financials,
        caenActivities: p.caenActivities,
        representatives: p.representatives,
      },
    });
  },

  async profileSlice(cui: Cui): Promise<Result<EntityProfileSlice | null, ApiError>> {
    if (isWithheldCompanyIdentifier(cui)) return ok(null);
    const res = await makeCompanyEntitySlices({ repo }, [cui]);
    if (res.isErr()) return err(asGuardError(res.error));
    const slice = [...res.value.values()][0];
    if (slice === undefined) return ok(null);
    const summary =
      slice.name +
      (slice.nameSource === 'core_organization' ? ' (directory name)' : '') +
      (slice.legalForm !== null ? ` (${slice.legalForm})` : '') +
      (slice.headlineStatus !== null ? `, ONRC status ${slice.headlineStatus.label}` : '') +
      (slice.registryCuiState === 'in_edition'
        ? ''
        : `, ONRC registry: ${slice.registryCuiState.replace(/_/gu, ' ')}`) +
      (slice.vatPayer === true ? ', VAT payer' : '') +
      '.';
    return ok({
      source: COMPANIES_SOURCE,
      kind: 'company_profile',
      summary,
      data: slice as unknown as Record<string, unknown>,
    });
  },

  /**
   * The served fact's scope must still hold and the CUI's core organization
   * must still be public (a mandatory check: unreadable refuses). A fact
   * naming no scope this API issued, or no normalizable CUI, is refused,
   * never passed.
   */
  async confirmServed(
    cui: Cui,
    served: SourcePresence | EntityProfileSlice
  ): Promise<Result<void, ApiError>> {
    const scope = servedScope(served);
    const normalized = normalizeCui(cui);
    if (scope === null || normalized === null) {
      return err(accessRefused('the company fact cannot be rechecked; retry'));
    }
    const res = await confirmServedScope(repo, scope, [normalized]);
    return res.isErr() ? err(asGuardError(res.error)) : ok(undefined);
  },
});
