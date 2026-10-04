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

import { invalidInput, isAccessRefusal, type ApiError } from '../errors.js';
import {
  MAX_SERVED_CUI_DIGITS,
  isWithheldOrganizationIdentifier,
  normalizeCui,
  type Cui,
  type EntityProfileSlice,
  type FlowSummary,
  type OrgIdentifier,
  type Organization,
  type SourcePresence,
  type Territory,
} from '../types.js';

import type {
  ContributorRegistry,
  FlowsRepo,
  IdentityRepo,
  SearchRepo,
  ServedFactsCheck,
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
 * The CHEAP entity core — only the indexed organization lookup.
 * The expensive parts each have their own measured cost and become GraphQL
 * field resolvers so a query pays only for what it selects:
 *   - `identifiers`       → organization identifiers (only when selected)
 *   - `flowsIn`/`flowsOut` → flows.money_flows (the 19GB graph, §14.6)
 *   - `documentCount`      → `any(cuis)` over 6.1M search docs (~7s, no index)
 *   - `territory`          → public_entities → territories join
 *   - `presence`           → per-contributor fan-out
 * A query like `entity(cui){ pnrr }` therefore never touches flows or the doc
 * scan. The full eager assembly lives in `makeEntity360` (snapshot/REST use).
 */
/**
 * The categorical refusal for a single-identity probe (P0 containment).
 *
 * `entity(cui)` is a probe: it answers "what do you know about this identifier"
 * across every source, so a `null`-but-successful answer would still confirm
 * non-existence while a populated one confirms existence. Refusing identically
 * in both cases is the point — the same wording the companies surface uses, so
 * the two can't drift into disagreeing about the same identifier.
 */
const withheldIdentifier = (): ApiError =>
  invalidInput(
    `identifiers longer than ${String(MAX_SERVED_CUI_DIGITS)} digits are not served`,
    'cui'
  );

export interface EntityCore {
  readonly cui: Cui;
  readonly organization: Organization | null;
}

export const makeEntityCore = async (
  deps: Entity360Deps,
  rawCui: string
): Promise<Result<EntityCore, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
  if (isWithheldOrganizationIdentifier(cui)) return err(withheldIdentifier());

  const orgRes = await deps.identityRepo.findByCui(cui);
  if (orgRes.isErr()) return err(orgRes.error);

  return ok({ cui, organization: orgRes.value });
};

/** The contributor fan-out of one CUI: what the sources served, and how to confirm it. */
export interface EntityPresenceFanOut {
  readonly presences: readonly SourcePresence[];
  /** Final access decisions for served presences (only sources that define one). */
  readonly checks: readonly ServedFactsCheck[];
}

/**
 * Resolve the present source contributors for a CUI. An advisory contributor
 * error degrades its source to absent; a guard refusal (`accessRefused`) is
 * returned, so it reaches the owning entity instead of becoming a missing badge.
 */
export const resolveEntityPresence = async (
  registry: ContributorRegistry,
  cui: Cui
): Promise<Result<EntityPresenceFanOut, ApiError>> => {
  const contributors = registry.list();
  const results = await Promise.all(contributors.map((c) => c.presenceFor(cui)));
  for (const res of results) {
    if (res.isErr() && isAccessRefusal(res.error)) return err(res.error);
  }
  const presences: SourcePresence[] = [];
  const checks: ServedFactsCheck[] = [];
  results.forEach((res, index) => {
    if (res.isErr() || res.value === null) return;
    const presence = res.value;
    presences.push(presence);
    const contributor = contributors[index];
    if (contributor?.confirmServed !== undefined) {
      const confirmServed = contributor.confirmServed.bind(contributor);
      checks.push(() => confirmServed(cui, presence));
    }
  });
  return ok({ presences, checks });
};

/** Run final decisions together; the first failure (a refusal or an untakeable decision) wins. */
export const confirmServedFacts = async (
  checks: readonly ServedFactsCheck[]
): Promise<Result<void, ApiError>> => {
  const results = await Promise.all(checks.map((check) => check()));
  for (const res of results) if (res.isErr()) return err(res.error);
  return ok(undefined);
};

export const makeEntity360 = async (
  deps: Entity360Deps,
  rawCui: string
): Promise<Result<Entity360, ApiError>> => {
  const cui = normalizeCui(rawCui);
  if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
  // Refuse BEFORE the fan-out: the eager assembly also reads flows, documents
  // and per-source presence, so serving it would disclose a natural person's
  // money and source footprint even with the organization row nulled.
  if (isWithheldOrganizationIdentifier(cui)) return err(withheldIdentifier());

  const { identityRepo, flowsRepo, searchRepo, registry } = deps;

  const [orgRes, territoryRes, flowsInRes, flowsOutRes, docCountRes, presenceRes] =
    await Promise.all([
      identityRepo.findByCui(cui),
      identityRepo.territoryForCui(cui),
      flowsRepo.getFlowSummary(cui, 'in'),
      flowsRepo.getFlowSummary(cui, 'out'),
      searchRepo.countByCui(cui),
      resolveEntityPresence(registry, cui),
    ]);

  // A source's guard refusal of this entity withholds the whole snapshot:
  // never the earlier organization and facts next to a missing badge.
  if (presenceRes.isErr()) return err(presenceRes.error);
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

  // Advisory contributor errors were dropped (entity-360 degrades gracefully).
  // The final access decision of every guarded fact served comes AFTER the
  // whole fan-out settled: a parent restricted or a source scope moved while
  // any leg was pending withholds the snapshot.
  const confirmed = await confirmServedFacts(presenceRes.value.checks);
  if (confirmed.isErr()) return err(confirmed.error);

  return ok({
    cui,
    organization: orgRes.value,
    identifiers,
    territory: territoryRes.value,
    flowsIn: flowsInRes.value,
    flowsOut: flowsOutRes.value,
    documentCount,
    presence: presenceRes.value.presences,
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
