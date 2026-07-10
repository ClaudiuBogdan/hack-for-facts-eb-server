/**
 * Reference module — usecases (plan §4). Framework-free, over the module repos +
 * the injected KERNEL repos. Thin: GraphQL + MCP call the SAME usecase.
 *
 * `getPublicEntity` is the single source of truth for the registry detail — the
 * contributor's `profileSlice`, the GraphQL `Entity.reference` resolver, and the
 * `referencePublicEntity` query all go through it (§14.7 contributor parity). The
 * detail enriches the card with the canonical kernel `Territory` (one extra point
 * lookup via the kernel TerritoryRepo) so the join is never forked.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  normalizeCui,
  type ApiError,
  type CursorPage,
  type FilterInput,
  type IdentityRepo,
  type Organization,
  type TerritoryRepo,
  type Territory,
} from '@/modules/shared/index.js';

import {
  REFERENCE_RESOLVE_DIMS,
  type ReferenceAggregateDim,
  type ReferenceClassificationCode,
  type ReferenceCountBucket,
  type ReferenceCounty,
  type ReferencePublicEntity,
  type ReferencePublicEntityCard,
  type ReferenceRegion,
  type ReferenceResolveDim,
  type ReferenceResolveHit,
} from './types.js';

import type {
  ClassificationRepo,
  CountedCursorPage,
  CursorPageRequest,
  PublicEntityRepo,
  TerritoryQueryRepo,
} from './ports.js';

/** The kernel repos the reference usecases lean on (injected at wiring, never constructed here). */
export interface ReferenceDeps {
  readonly publicEntities: PublicEntityRepo;
  readonly classification: ClassificationRepo;
  readonly territories: TerritoryQueryRepo;
  readonly identityRepo: IdentityRepo;
  readonly territoryRepo: TerritoryRepo;
}

// ── public entities ───────────────────────────────────────────────────────────

/** Detail by CUI, enriched with the canonical kernel Territory (single source of truth). */
export const getPublicEntity = async (
  deps: ReferenceDeps,
  cui: string,
  includeTrace: boolean
): Promise<Result<ReferencePublicEntity | null, ApiError>> => {
  const res = await deps.publicEntities.findByCui(cui, includeTrace);
  if (res.isErr()) return err(res.error);
  const entity = res.value;
  if (entity === null) return ok(null);
  if (entity.territorialSirutaCode === null) return ok(entity);
  const terrRes = await deps.territoryRepo.byTerritorialSiruta(entity.territorialSirutaCode);
  if (terrRes.isErr()) return err(terrRes.error);
  return ok({ ...entity, territory: terrRes.value });
};

export const listPublicEntities = (
  deps: ReferenceDeps,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CountedCursorPage<ReferencePublicEntityCard>, ApiError>> =>
  deps.publicEntities.list(filter, page);

export const getPublicEntityChildren = (
  deps: ReferenceDeps,
  cui: string
): Promise<Result<readonly ReferencePublicEntityCard[], ApiError>> =>
  deps.publicEntities.findChildren(cui);

export const aggregatePublicEntities = (
  deps: ReferenceDeps,
  by: ReferenceAggregateDim,
  filter: FilterInput
): Promise<Result<readonly ReferenceCountBucket[], ApiError>> =>
  deps.publicEntities.aggregate(by, filter);

// ── territories ────────────────────────────────────────────────────────────────

/** Detail by surrogate id OR `siruta:`-prefixed territorial SIRUTA (EXACTLY one of). */
export const getTerritory = async (
  deps: ReferenceDeps,
  args: { id?: string | number | null; siruta?: string | null }
): Promise<Result<Territory | null, ApiError>> => {
  const sirutaArg =
    args.siruta !== null && args.siruta !== undefined && args.siruta !== '' ? args.siruta : null;
  const idArg = args.id !== null && args.id !== undefined && args.id !== '' ? args.id : null;
  // The SDL says "exactly one of" — reject the ambiguous both-present case rather
  // than silently letting siruta win (review SHOULD-FIX).
  if (sirutaArg !== null && idArg !== null) {
    return err(invalidInput('provide exactly one of id or siruta, not both', 'id'));
  }
  if (sirutaArg !== null) {
    return deps.territoryRepo.byTerritorialSiruta(sirutaArg);
  }
  if (idArg !== null) {
    // Accept the dual-id grammar `siruta:1234567` on the id slot too (REST parity).
    const asStr = String(idArg);
    if (asStr.startsWith('siruta:')) {
      return deps.territoryRepo.byTerritorialSiruta(asStr.slice('siruta:'.length));
    }
    const n = Number(asStr);
    if (!Number.isInteger(n))
      return err(invalidInput('territory id must be an integer or siruta: code', 'id'));
    return deps.territories.byId(n);
  }
  return err(invalidInput('provide id or siruta', 'id'));
};

export const listTerritories = (
  deps: ReferenceDeps,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CountedCursorPage<Territory>, ApiError>> => deps.territories.list(filter, page);

export const listCounties = (
  deps: ReferenceDeps
): Promise<Result<readonly ReferenceCounty[], ApiError>> => deps.territories.listCountyRollups();

export const listRegions = (
  deps: ReferenceDeps
): Promise<Result<readonly ReferenceRegion[], ApiError>> => deps.territories.listRegionRollups();

// ── classification ─────────────────────────────────────────────────────────────

export const getClassificationCode = (
  deps: ReferenceDeps,
  system: string,
  code: string
): Promise<Result<ReferenceClassificationCode | null, ApiError>> =>
  deps.classification.findOne(system, code);

export const listClassificationCodes = (
  deps: ReferenceDeps,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<ReferenceClassificationCode>, ApiError>> =>
  deps.classification.list(filter, page);

export const listClassificationSystems = (
  deps: ReferenceDeps
): Promise<Result<readonly { readonly system: string; readonly count: number }[], ApiError>> =>
  deps.classification.listSystems();

// ── organization (kernel pass-through) ──────────────────────────────────────────

export const getOrganizationRef = async (
  deps: ReferenceDeps,
  rawCui: string
): Promise<Result<Organization | null, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
  return deps.identityRepo.findByCui(cui);
};

// ── resolve (the four discovery dimensions) ─────────────────────────────────────

/** Resolve limits are clamped here so the territory/org kernel calls can't be fed a negative/huge limit. */
const clampResolveLimit = (limit: number): number => Math.min(Math.max(Math.floor(limit), 1), 50);

export const resolveReference = async (
  deps: ReferenceDeps,
  dim: ReferenceResolveDim,
  q: string,
  rawLimit: number
): Promise<Result<readonly ReferenceResolveHit[], ApiError>> => {
  if (!REFERENCE_RESOLVE_DIMS.includes(dim)) {
    return err(invalidInput(`unknown resolve dimension '${dim as string}'`, 'dim'));
  }
  const limit = clampResolveLimit(rawLimit);
  switch (dim) {
    case 'public_entity':
      return deps.publicEntities.resolve(q, limit);
    case 'classification':
      return deps.classification.resolve(null, q, limit);
    case 'territory': {
      const res = await deps.territoryRepo.searchUat(q, limit);
      if (res.isErr()) return err(res.error);
      return ok(
        res.value.flatMap((t): ReferenceResolveHit[] => {
          if (t.territorialSirutaCode === null) return [];
          const hint = t.region ?? t.countyName;
          return [
            {
              kind: 'territory',
              value: t.territorialSirutaCode,
              label: t.name,
              ...(hint !== null && { hint }),
            },
          ];
        })
      );
    }
    case 'organization': {
      // A digits-only query is a CUI: short-circuit through findByCui (exact) so a
      // CUI input resolves even though the name index wouldn't match it. Otherwise
      // fall back to the bounded name search. Both yield CUI-valued hits (orgs with
      // no CUI are dropped — a null `value` is useless as a downstream filter).
      const cui = normalizeCui(q);
      if (cui !== null && q.replace(/\D/gu, '') === q.replace(/^RO/iu, '').replace(/\D/gu, '')) {
        const byCui = await deps.identityRepo.findByCui(cui);
        if (byCui.isErr()) return err(byCui.error);
        const org = byCui.value;
        if (org !== null && org.cui !== null) {
          const orgCui = org.cui;
          return ok([
            {
              kind: 'organization',
              value: orgCui,
              label: org.name,
              score: 1,
              ...(org.countyName !== null && { hint: org.countyName }),
            },
          ]);
        }
      }
      const res = await deps.identityRepo.searchByName(q, limit);
      if (res.isErr()) return err(res.error);
      return ok(
        res.value.flatMap((m): ReferenceResolveHit[] =>
          m.cui === null
            ? []
            : [
                {
                  kind: 'organization',
                  value: m.cui,
                  label: m.name,
                  ...(typeof m.score === 'number' && { score: m.score }),
                  ...(m.countyName !== null && { hint: m.countyName }),
                },
              ]
        )
      );
    }
  }
};
