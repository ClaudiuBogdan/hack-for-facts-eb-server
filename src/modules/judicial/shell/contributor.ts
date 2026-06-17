/**
 * Judicial module — cross-source contributor (plan 08 §5). Registers ONE
 * `SourceContributor` (`source: 'judicial'`).
 *
 * PRIVACY-SAFE BY CONSTRUCTION: both `presenceFor` and `profileSlice` call the
 * GATED company-litigation usecase, which is `published`-only (empty in v1) and
 * structurally incapable of emitting a person name (it returns counts + a gated
 * company name). This is how Entity-360 stays privacy-safe without the kernel
 * knowing anything justice-specific.
 *
 * `flow_type`: judicial registers NONE (no money flow in litigation).
 */

import { ok, err, type Result } from 'neverthrow';

import { getCompanyLitigation, type JudicialRepos } from '../core/usecases.js';

import type {
  ApiError,
  Cui,
  EntityProfileSlice,
  SourceContributor,
  SourcePresence,
} from '@/modules/shared/index.js';

const JUDICIAL_SOURCE = 'judicial';

export const makeJudicialContributor = (
  repos: Pick<JudicialRepos, 'companyLinks'>
): SourceContributor => ({
  source: JUDICIAL_SOURCE,

  async presenceFor(cui: Cui): Promise<Result<SourcePresence | null, ApiError>> {
    const res = await getCompanyLitigation(repos, cui);
    if (res.isErr()) return err(res.error);
    const s = res.value;
    // present only when there is at least one PUBLISHED company-litigation link
    // (empty in v1) — never a candidate/needs_review row.
    if (s.caseCount === 0) return ok(null);
    return ok({
      source: JUDICIAL_SOURCE,
      present: true,
      label: 'Litigation',
      count: s.caseCount,
      badges: ['company-litigation'],
    });
  },

  async profileSlice(cui: Cui): Promise<Result<EntityProfileSlice | null, ApiError>> {
    const res = await getCompanyLitigation(repos, cui);
    if (res.isErr()) return err(res.error);
    const s = res.value;
    if (s.caseCount === 0) return ok(null);
    return ok({
      source: JUDICIAL_SOURCE,
      kind: 'companyLitigation',
      summary: `${String(s.caseCount)} published litigation case link(s).`,
      data: s as unknown as Record<string, unknown>,
    });
  },
});
