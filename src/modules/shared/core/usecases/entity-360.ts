/**
 * Shared Kernel — Entity-360 usecase (foundation §4.4, §14.6).
 *
 * Assembles a cross-source entity profile keyed by CUI. The org identity +
 * unified flow summary come from kernel repos; per-source presence/profile come
 * from the contributor registry (adding a source needs no kernel edit). The
 * unified flow summary is the ONLY place flows.money_flows is authoritative
 * (the grain gate, §14.6) — source-native top-N stays in source modules.
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '../errors.js';
import { normalizeCui,
  type Cui,
  type EntityProfileSlice,
  type FlowSummary,
  type OrgIdentifier,
  type Organization,
  type SourcePresence,
  type Territory } from '../types.js';

import type {
  ContributorRegistry,
  FlowsRepo,
  IdentityRepo,
  SearchRepo,
} from '../ports.js';

export interface Entity360Deps {
  readonly identityRepo: IdentityRepo;
  readonly flowsRepo: FlowsRepo;
  readonly searchRepo: SearchRepo;
  readonly registry: ContributorRegistry;
}

export interface Entity360 {
  readonly cui: Cui;
  readonly organization: Organization | null;
  readonly identifiers: readonly OrgIdentifier[];
  readonly territory: Territory | null;
  readonly flowsIn: FlowSummary;
  readonly flowsOut: FlowSummary;
  readonly documentCount: number;
  readonly presence: readonly SourcePresence[];
}

/**
 * The CHEAP entity core — only the indexed identity lookup (org + identifiers).
 * The expensive parts each have their own measured cost and become GraphQL
 * field resolvers so a query pays only for what it selects:
 *   - `flowsIn`/`flowsOut` → flows.money_flows (the 19GB graph, §14.6)
 *   - `documentCount`      → `any(cuis)` over 6.1M search docs (~7s, no index)
 *   - `territory`          → public_entities → territories join
 *   - `presence`           → per-contributor fan-out
 * A query like `entity(cui){ pnrr }` therefore never touches flows or the doc
 * scan. The full eager assembly lives in `makeEntity360` (snapshot/REST use).
 */
export interface EntityCore {
  readonly cui: Cui;
  readonly organization: Organization | null;
  readonly identifiers: readonly OrgIdentifier[];
}

export const makeEntityCore = async (
  deps: Entity360Deps,
  rawCui: string
): Promise<Result<EntityCore, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));

  const orgRes = await deps.identityRepo.findByCui(cui);
  if (orgRes.isErr()) return err(orgRes.error);

  let identifiers: readonly OrgIdentifier[] = [];
  if (orgRes.value !== null) {
    const idRes = await deps.identityRepo.getIdentifiers(orgRes.value.orgId);
    if (idRes.isErr()) return err(idRes.error);
    identifiers = idRes.value;
  }

  return ok({ cui, organization: orgRes.value, identifiers });
};

/** Resolve the present source contributors for a CUI (field-level). */
export const resolveEntityPresence = async (
  registry: ContributorRegistry,
  cui: Cui
): Promise<readonly SourcePresence[]> => {
  const results = await Promise.all(registry.list().map((c) => c.presenceFor(cui)));
  const presences: SourcePresence[] = [];
  for (const res of results) {
    if (res.isOk() && res.value !== null) presences.push(res.value);
  }
  return presences;
};

export const makeEntity360 = async (
  deps: Entity360Deps,
  rawCui: string
): Promise<Result<Entity360, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));

  const { identityRepo, flowsRepo, searchRepo, registry } = deps;

  const [orgRes, territoryRes, flowsInRes, flowsOutRes, docCountRes, presence] = await Promise.all([
    identityRepo.findByCui(cui),
    identityRepo.territoryForCui(cui),
    flowsRepo.getFlowSummary(cui, 'in'),
    flowsRepo.getFlowSummary(cui, 'out'),
    searchRepo.countByCui(cui),
    Promise.all(
      registry.list().map((c) => c.presenceFor(cui))
    ),
  ]);

  if (orgRes.isErr()) return err(orgRes.error);
  if (territoryRes.isErr()) return err(territoryRes.error);
  if (flowsInRes.isErr()) return err(flowsInRes.error);
  if (flowsOutRes.isErr()) return err(flowsOutRes.error);
  // documentCount is informational and runs a known-slow `any(cuis)` scan over
  // 6.1M docs (no index yet) — degrade to 0 on failure/timeout rather than
  // failing the whole snapshot.
  const documentCount = docCountRes.isOk() ? docCountRes.value : 0;

  // Identifiers only if we resolved an org.
  let identifiers: readonly OrgIdentifier[] = [];
  if (orgRes.value !== null) {
    const idRes = await identityRepo.getIdentifiers(orgRes.value.orgId);
    if (idRes.isErr()) return err(idRes.error);
    identifiers = idRes.value;
  }

  // Drop contributor errors but keep the rest (entity-360 degrades gracefully).
  const presences: SourcePresence[] = [];
  for (const res of presence) {
    if (res.isOk() && res.value !== null) presences.push(res.value);
  }

  return ok({
    cui,
    organization: orgRes.value,
    identifiers,
    territory: territoryRes.value,
    flowsIn: flowsInRes.value,
    flowsOut: flowsOutRes.value,
    documentCount,
    presence: presences,
  });
};

/**
 * Resolve a single source's profile slice for a CUI. The GraphQL `Entity.<source>`
 * resolvers call THIS (via the contributor), not their own repo, so REST and
 * GraphQL stay equivalent (§14.7).
 */
export const makeEntityProfileSlice = async (
  registry: ContributorRegistry,
  source: string,
  rawCui: string
): Promise<Result<EntityProfileSlice | null, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
  const contributor = registry.get(source);
  if (contributor?.profileSlice === undefined) return ok(null);
  return contributor.profileSlice(cui);
};
