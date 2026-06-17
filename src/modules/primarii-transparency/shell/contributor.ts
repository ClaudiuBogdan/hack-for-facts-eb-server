/**
 * Primarii-transparency module — cross-source contributor (plan §4, §14.7).
 *
 * Registers ONE `SourceContributor` (source: 'primarii_transparency'). `presenceFor`
 * powers the entity-360 governance/transparency badge; `profileSlice` is the SINGLE
 * cross-source mechanism — the GraphQL `Entity.primariiTransparency` resolver calls
 * THIS (via `makeEntityProfileSlice`), not a divergent path.
 *
 * GRAIN GATE (§4): this contributor reports NO `flow_type` and NO spend total. The
 * salary `amount_ron` is a self-reported disclosure claim, not a payment — it is NOT
 * placed in the slice as money. The slice carries only QA/coverage facts.
 * `doc_type` owned: `primarii_transparency_entity` (entity-grain, search lane only).
 */

import { err, ok, type Result } from 'neverthrow';

import { getEntityTransparencyProfile, type PrimariiDeps } from '../core/usecases.js';

import type { PrimariiEntityProfile } from '../core/types.js';
import type {
  ApiError,
  Cui,
  EntityProfileSlice,
  SourceContributor,
  SourcePresence,
} from '@/modules/shared/index.js';

const PRIMARII_SOURCE = 'primarii_transparency';

/** Build the open profile slice from the transparency profile (QA facts only — no money). */
export const toProfileSlice = (profile: PrimariiEntityProfile): EntityProfileSlice => {
  const s = profile.status;
  const foundCount = profile.categories.filter((c) => c.status === 'found').length;
  const docCount = profile.documentCounts.reduce((a, c) => a + c.count, 0);
  const where = s.county !== null ? ` (${s.county})` : '';
  const summary =
    `${s.entityName}${where} — transparency ${s.dataQualityStatus}, result ${s.resultStatus}; ` +
    `publishes ${String(foundCount)}/3 required categories (organigrama/headcount/salaries), ` +
    `${String(docCount)} evidence documents.`;
  return {
    source: PRIMARII_SOURCE,
    kind: 'transparency',
    summary,
    // QA/coverage facts only — deliberately NOT the salary amounts (grain gate, §4).
    data: {
      dataQualityStatus: s.dataQualityStatus,
      resultStatus: s.resultStatus,
      evidenceCoverage: s.evidenceCoverage,
      missingRequiredCategories: s.missingRequiredCategories,
      categories: profile.categories.map((c) => ({ category: c.category, status: c.status })),
      documentCount: docCount,
    },
  };
};

export const makePrimariiContributor = (deps: PrimariiDeps): SourceContributor => ({
  source: PRIMARII_SOURCE,

  async presenceFor(cui: Cui): Promise<Result<SourcePresence | null, ApiError>> {
    const res = await deps.repo.presenceFor(cui);
    if (res.isErr()) return err(res.error);
    const p = res.value;
    // The repo returns a present record or null (never present:false), so a null
    // check is sufficient.
    if (p === null) return ok(null);

    const badges: string[] = ['transparency-qa'];
    if (p.dataQuality !== undefined) badges.push(`quality:${p.dataQuality}`);

    return ok({
      source: PRIMARII_SOURCE,
      present: true,
      label: 'Transparency QA',
      count: 1,
      badges,
      attrs: {
        dataQualityStatus: p.dataQuality ?? null,
        resultStatus: p.status ?? null,
      },
    });
  },

  async profileSlice(cui: Cui): Promise<Result<EntityProfileSlice | null, ApiError>> {
    const res = await getEntityTransparencyProfile(deps, cui);
    if (res.isErr()) return err(res.error);
    return ok(res.value === null ? null : toProfileSlice(res.value));
  },
});
