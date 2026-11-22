/**
 * The bridge's privacy gate (LEGAL_SOURCE=v2). Everything the v2 source reads
 * from the old `legal` corpus is gated on legal_v2: an act is visible only when
 * its legal_v2 row is public, so a restricted act never appears on EITHER end
 * of a bridged fact (an event's act and its acting act, a reference's citing
 * and cited acts, an anchor's source, a vocabulary count). The predicates go
 * into the WHERE of the bridged statement, before counting or paging.
 *
 * `legal.acts`, `act_documents`, `act_references` and `document_summaries`
 * carry no `privacy_class` of their own; `act_status_events` and
 * `document_link_edges` do, and the legacy repos already filter those rows.
 * A bridged title or summary is additionally withheld when the old document's
 * own render rows are not all public.
 */

import { sql, type RawBuilder, type SqlBool } from 'kysely';

/** True when the act id expression names a public legal_v2 act. */
export type LegalActGate = (actId: RawBuilder<unknown>) => RawBuilder<SqlBool>;

export const v2ActVisible: LegalActGate = (actId) =>
  sql<SqlBool>`exists (select 1 from legal_v2.acts gv
                        where gv.act_id = ${actId} and gv.privacy_class = 'public')`;

/** True when an old document id belongs to a public legal_v2 act. */
export const v2DocumentVisible = (documentId: RawBuilder<unknown>): RawBuilder<SqlBool> =>
  sql<SqlBool>`exists (select 1 from legal.act_documents gd
                        join legal_v2.acts gv on gv.act_id = gd.act_id and gv.privacy_class = 'public'
                        where gd.document_id = ${documentId})`;

/** True when an old document's render rows are all public (or it has none). */
export const legacyDocumentRenderPublic = (documentId: RawBuilder<unknown>): RawBuilder<SqlBool> =>
  sql<SqlBool>`not exists (select 1 from legal.document_render gr
                            where gr.document_id = ${documentId} and gr.privacy_class <> 'public')`;

/** The gates a legacy repo applies when it serves the v2 bridge. */
export interface LegalBridgeGate {
  readonly act: LegalActGate;
  readonly document: (documentId: RawBuilder<unknown>) => RawBuilder<SqlBool>;
}

export const V2_BRIDGE_GATE: LegalBridgeGate = { act: v2ActVisible, document: v2DocumentVisible };

/** `expr is null or visible(expr)`: an optional act reference. */
export const optionalActVisible = (
  gate: LegalActGate,
  actId: RawBuilder<unknown>
): RawBuilder<SqlBool> => sql<SqlBool>`(${actId} is null or ${gate(actId)})`;
