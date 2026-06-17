/**
 * Legal module — the **shared skeleton repo port** (plan §3.1, §9). **05 OWNS
 * this**; the `mo/` area (06) builds its repos on top of `LegalRepoBase` via
 * ordinary intra-module constructor injection (NOT a cross-module import — both
 * areas live inside the single `legal` module, foundation §10).
 *
 * `LegalRepoBase` owns:
 *  - **act identity resolution** — the join target for MO's `act_id` FKs
 *    (`mo_act_publications.act_id`, `mo_lifecycle_edges.target_act_id`).
 *  - the **shared status-event read path** (`getStatusEvents`), which both
 *    portal and MO write rows into and the server reads via `event_source`.
 *
 * Every method returns `Result<T, ApiError>` (neverthrow). Reads only; no writes.
 */

import type { LegalAct, LegalCitationKey, LegalEventSource, LegalStatusEvent } from './types.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/**
 * The canonical way to address an act across surfaces. Either an explicit
 * `actId`, or a free-text `citation` resolved via `act_citation_keys`/aliases
 * (e.g. "legea 227/2015" | "codul fiscal"). MO resolves its publications to acts
 * through this same contract.
 *
 * NB: distinct from the kernel's cross-module `LegalActRef` (shared/core/ports —
 * the loader's minimal `{actId,title,actType,resolutionStatus}` shape). This one
 * is the module-internal addressing input; the kernel one is the loader output.
 */
export interface LegalActRef {
  readonly actId?: string;
  readonly citation?: string;
}

export interface LegalRepoBase {
  /**
   * Identity resolution — the contract MO (06), the loader, and ranked discovery
   * call. Resolves an `actId` directly, or a `citation` via `act_natural_key` /
   * `act_citation_keys` / `act_aliases`. Returns the SINGLE best match, or null
   * when unresolved. Ambiguous aliases (e.g. "codul fiscal" → 2 acts) resolve to
   * the highest-`in_degree` act DETERMINISTICALLY — this is the right behavior for
   * the loader and ranked discovery. The user-facing `legalAct(citation:)` path
   * uses `resolveActCandidates` instead so it can SURFACE ambiguity (Codex finding).
   */
  resolveActRef(ref: LegalActRef): Promise<Result<LegalAct | null, ApiError>>;

  /**
   * Like `resolveActRef` but returns ALL candidate acts (in_degree desc) for a
   * citation, so the caller can detect/surface ambiguity ("codul fiscal" → 2).
   * A numeric `actId` ref returns at most one. Bounded.
   */
  resolveActCandidates(ref: LegalActRef): Promise<Result<readonly LegalAct[], ApiError>>;

  /** Single act by id (the §3.2 detail path + a building block for cards). */
  findActById(actId: string): Promise<Result<LegalAct | null, ApiError>>;

  /** Batch act fetch — the DataLoader fan-out (incoming/target/source acts). */
  findActsByIds(actIds: readonly string[]): Promise<Result<readonly LegalAct[], ApiError>>;

  /** All acts sharing a citation key (joint-ministry orders → many acts). */
  findActsByCitationKey(k: LegalCitationKey): Promise<Result<readonly LegalAct[], ApiError>>;

  /**
   * pg_trgm/ILIKE fallback on `display_citation` (the always-available identity
   * search when Meili is down). Bounded by `limit`.
   */
  searchActsByName(q: string, limit: number): Promise<Result<readonly LegalAct[], ApiError>>;

  /**
   * Shared status-event read. Portal writes `event_source='portal'` rows; MO
   * writes `'monitorul-oficial'` rows. Pass `eventSource` to scope, omit for both.
   */
  getStatusEvents(
    actId: string,
    eventSource?: LegalEventSource
  ): Promise<Result<readonly LegalStatusEvent[], ApiError>>;
}
