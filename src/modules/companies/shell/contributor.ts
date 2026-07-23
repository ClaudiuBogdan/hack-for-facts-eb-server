/**
 * Companies module — cross-source contributor (plan §4, §14.7).
 *
 * Registers ONE `SourceContributor` (`source: 'companies'`) into the kernel
 * registry. `presenceFor` powers entity-360 badges; `profileSlice` is the SINGLE
 * cross-source mechanism — the GraphQL `Entity.company` resolver resolves through
 * THIS (via the kernel `makeEntityProfileSlice`), not a divergent path.
 *
 * Identity is link-not-merge: presence is keyed by CUI in `core.organizations`
 * (kind='company') / `companies_v2.registrations`; this module never reassigns
 * `org_id`s. `flow_type` registered: NONE (companies only appear as a flows
 * payee, never originating a flow type — §4 grain gate).
 */

import { ok, err, type Result } from 'neverthrow';

import { isWithheldCompanyIdentifier } from '../core/usecases.js';

import type { CompaniesRepository } from '../core/ports.js';
import type {
  ApiError,
  Cui,
  EntityProfileSlice,
  SourceContributor,
  SourcePresence,
} from '@/modules/shared/index.js';

const COMPANIES_SOURCE = 'companies';

export const makeCompaniesContributor = (repo: CompaniesRepository): SourceContributor => ({
  source: COMPANIES_SOURCE,

  async presenceFor(cui: Cui): Promise<Result<SourcePresence | null, ApiError>> {
    // Withheld identifiers (>10 digits, CNP-shaped) contribute NOTHING —
    // absence, not an error, so an entity-360 page renders without a company
    // badge and the response never confirms a registry row exists.
    if (isWithheldCompanyIdentifier(cui)) return ok(null);
    const res = await repo.presenceCounts(cui);
    if (res.isErr()) return err(res.error);
    const p = res.value;
    if (p === null) return ok(null);

    const badges: string[] = ['company'];
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
        headlineStatus: p.headlineStatus,
        financials: p.financials,
        caenActivities: p.caenActivities,
        representatives: p.representatives,
      },
    });
  },

  async profileSlice(cui: Cui): Promise<Result<EntityProfileSlice | null, ApiError>> {
    if (isWithheldCompanyIdentifier(cui)) return ok(null);
    const res = await repo.profileSlice(cui);
    if (res.isErr()) return err(res.error);
    const slice = res.value;
    if (slice === null) return ok(null);
    const summary =
      slice.name +
      (slice.legalForm !== null ? ` (${slice.legalForm})` : '') +
      (slice.headlineStatus !== null ? `, status ${slice.headlineStatus.label}` : '') +
      (slice.vatPayer === true ? ', VAT payer' : '') +
      '.';
    return ok({
      source: COMPANIES_SOURCE,
      kind: 'company_profile',
      summary,
      data: slice as unknown as Record<string, unknown>,
    });
  },
});
