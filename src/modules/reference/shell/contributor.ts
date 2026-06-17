/**
 * Reference module — cross-source contributor (plan §4, §14.7).
 *
 * Registers ONE `SourceContributor` (source: 'reference'). `presenceFor` powers the
 * entity-360 registry badge; `profileSlice` is the SINGLE cross-source mechanism —
 * the GraphQL `Entity.reference` resolver calls THIS (via `makeEntityProfileSlice`),
 * not a divergent path. The slice wraps the registry CARD (no field_trace —
 * MCP/agent-safe) into the kernel's open `{ source, kind, summary?, data? }` shape.
 *
 * `flow_type` registered: none (the reference module produces no money flows).
 * `doc_type` registered: none in v1 (the search lane does not project public_entities).
 */

import { err, ok, type Result } from 'neverthrow';

import type { PublicEntityRepo } from '../core/ports.js';
import type { ReferencePublicEntityCard } from '../core/types.js';
import type {
  ApiError,
  Cui,
  EntityProfileSlice,
  SourceContributor,
  SourcePresence,
} from '@/modules/shared/index.js';

const REFERENCE_SOURCE = 'reference';

/** Build the open profile slice from the registry card (no second query, no field_trace). */
export const toProfileSlice = (card: ReferencePublicEntityCard): EntityProfileSlice => {
  const countyName = card.territory?.countyName ?? null;
  const where = countyName !== null ? `, ${countyName}` : '';
  const summary =
    `${card.name} — ${card.entityType ?? 'public entity'}${where}` +
    (card.isUat ? ' (UAT)' : '') +
    (card.defaultReportType !== null ? `; default report: ${card.defaultReportType}.` : '.');
  return {
    source: REFERENCE_SOURCE,
    kind: 'public_entity',
    summary,
    data: card as unknown as Record<string, unknown>,
  };
};

export const makeReferenceContributor = (repo: PublicEntityRepo): SourceContributor => ({
  source: REFERENCE_SOURCE,

  async presenceFor(cui: Cui): Promise<Result<SourcePresence | null, ApiError>> {
    const res = await repo.findByCui(cui, false);
    if (res.isErr()) return err(res.error);
    const card = res.value;
    if (card === null) return ok(null);

    const badges: string[] = ['public-entity'];
    if (card.isUat) badges.push('uat');
    if (card.entityType !== null) badges.push(card.entityType);

    return ok({
      source: REFERENCE_SOURCE,
      present: true,
      label: 'Registry',
      count: 1,
      badges,
      attrs: {
        name: card.name,
        entityType: card.entityType,
        category: card.category,
        isUat: card.isUat,
        territorialSirutaCode: card.territorialSirutaCode,
      },
    });
  },

  async profileSlice(cui: Cui): Promise<Result<EntityProfileSlice | null, ApiError>> {
    const res = await repo.findByCui(cui, false);
    if (res.isErr()) return err(res.error);
    return ok(res.value === null ? null : toProfileSlice(res.value));
  },
});
