/**
 * The bridge: legal_v2 identity + the old `legal` corpus's facts (pure).
 *
 * legal_v2 serves identity, forms and text. What it does not rebuild yet
 * (status, its evidence, in-degree, links in and out, anchors, timeline, the
 * changes feed, the AI summary with its domains and category, the title) is
 * read from `legal.*` by act_id — the two schemas share act ids — and labelled
 * as such in `bridgedFields`. An act that `legal` does not hold has NO bridged
 * facts: the scalars are null on the GraphQL surface (`bridged: false`), never
 * a guessed default.
 */

import type { LegalAct, LegalActStatus } from '../types.js';
import type { IsoDate } from '@/modules/shared/index.js';

/** Every field the v2 source reads from the old corpus when the act is there. */
export const V2_BRIDGED_ACT_FIELDS: readonly string[] = [
  'status',
  'statusEvidence',
  'inDegree',
  'entryIntoForce',
  'amendedAfterPublication',
  'links',
  'incomingAnchors',
  'timeline',
  'summary',
  'domains',
  'categories',
  'title',
];

/** A legal_v2.acts row (public), as the v2 repo reads it. */
export interface V2ActIdentity {
  readonly actId: string;
  readonly actNaturalKey: string;
  readonly actType: string;
  readonly actNumber: string | null;
  readonly actYear: number | null;
  readonly issuerSlug: string | null;
  readonly displayCitation: string;
  readonly ended: boolean;
}

/** The old corpus's facts for one act (`legal.acts`), when it holds the act. */
export interface V2LegacyFacts {
  readonly status: LegalActStatus;
  readonly statusEvidence: Record<string, unknown>;
  readonly entryIntoForce: IsoDate | null;
  readonly inDegree: number;
}

/**
 * One `LegalAct` from a v2 identity and the bridged facts. Without facts the
 * internal placeholders (`necunoscut`, `{}`, 0) keep the internal consumers
 * total; the GraphQL resolvers read `bridged === false` and answer null.
 */
export const mergeBridgedAct = (
  identity: V2ActIdentity,
  facts: V2LegacyFacts | null,
  canonicalDocumentId: string | null = null
): LegalAct => ({
  actId: identity.actId,
  actNaturalKey: identity.actNaturalKey,
  actType: identity.actType,
  actNumber: identity.actNumber,
  actYear: identity.actYear,
  issuerSlug: identity.issuerSlug,
  canonicalDocumentId,
  displayCitation: identity.displayCitation,
  status: facts?.status ?? 'necunoscut',
  statusEvidence: facts?.statusEvidence ?? {},
  entryIntoForce: facts?.entryIntoForce ?? null,
  inDegree: facts?.inDegree ?? 0,
  bridged: facts !== null,
  bridgedFields: facts === null ? [] : V2_BRIDGED_ACT_FIELDS,
  ended: identity.ended,
});

/** A bridged scalar as GraphQL serves it: null when the act was not bridged. */
export const bridgedOrNull = <T>(act: Pick<LegalAct, 'bridged'>, value: T): T | null =>
  act.bridged === false ? null : value;
