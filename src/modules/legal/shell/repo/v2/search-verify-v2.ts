/**
 * Verifies the legal-v2 units index's hits against legal_v2 before any of
 * their text is served (search-design §5.3: the index's `uses` name the form,
 * the unit, the provision and the range of every use of a wording).
 *
 * ONE statement per verification (one snapshot) checks each use:
 *  - its form is a public form of the hit's public act and servable — the
 *    render's rule (`FORM_READABLE_SQL`: current public composition, public chunks
 *    in each unit, slot-bound sources, a consolidation's label date);
 *  - its unit is that form's current public component;
 *  - its provision is public and holds the use's WHOLE range [start, end);
 *  - the unit's public chunks cover the whole range, which is then offset into the form;
 * and answers the occurrence's own facts: the provision's parser address and
 * label, whether its content key is the indexed wording's, and the form's own
 * source (the gate's: a whole unit's capture, or a pair's header). The section's
 * path is the provision's outline path (the namespaced block id), read from the
 * outline reader that the outline itself uses. Text units are sealed and their
 * ids never reused, so a replaced unit fails the check.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import { BOUND_COMPONENT_SOURCE_SQL, FORM_READABLE_SQL } from './v2-reads.js';
import { COMPONENT_BOUNDARY } from '../../../core/v2/composition.js';
import { formDocumentId, versionKindOf } from '../../../core/v2/forms.js';
import { v2ProvisionKey } from '../../../core/v2/outline.js';

import type { V2OutlineReader, V2ProvisionPaths } from './outline-v2.js';
import type { LegalV2HitVerifier, V2HitUse, VerifiedUse } from '../../../core/v2/search.js';

type Db = Kysely<ProdDatabase>;

/** Uses read per verification (the hit window × uses per hit); not measured. */
const MAX_USES = 2_000;

interface VerifiedRow {
  idx: number;
  form_id: string;
  form_kind: string;
  caveat: string | null;
  portal_label_raw: string | null;
  portal_label_date: string | null;
  portal_order_date: string | null;
  address: string | null;
  label_raw: string | null;
  same_wording: boolean;
  composed: boolean;
  ordinal: number;
  provision_seq: number;
  char_start: number;
  char_end: number;
  source_url: string | null;
  composition_digest: string | null;
}

export const makeLegalV2HitVerifier = (
  db: Db,
  provisionPaths?: V2OutlineReader['provisionPaths']
): LegalV2HitVerifier => ({
  verifyUses: async (candidates) => {
    const flat: { key: number; actId: string; use: V2HitUse; idx: number }[] = [];
    for (const c of candidates) {
      for (const use of c.uses) {
        if (flat.length >= MAX_USES) break;
        // Only an occurrence with a provision and a whole range can supply
        // the displayed fields.
        if (
          use.provisionSeq === null ||
          use.charStart === null ||
          use.charEnd === null ||
          use.charStart < 0 ||
          use.charEnd <= use.charStart
        )
          continue;
        flat.push({ key: c.key, actId: c.actId, use, idx: flat.length });
      }
    }
    if (flat.length === 0) return ok(new Map());
    let rows: VerifiedRow[];
    try {
      const values = sql.join(
        flat.map(
          (f) =>
            sql`(${f.idx}::int, ${f.actId}::bigint, ${f.use.formId}::bigint, ${f.use.unitId}::bigint,
                 ${f.use.provisionSeq}::int, ${f.use.charStart}::int, ${f.use.charEnd}::int,
                 ${f.use.contentKey}::text)`
        ),
        sql`, `
      );
      const result = await sql<VerifiedRow>`
        with hit(idx, act_id, form_id, unit_id, provision_seq, char_start, char_end, content_key)
          as (values ${values})
        select hit.idx, f.form_id::text as form_id, f.form_kind, f.caveat, f.portal_label_raw,
               f.portal_label_date::text as portal_label_date,
               f.portal_order_date::text as portal_order_date,
               p.address, p.label_raw, c.slot <> 'whole' as composed, c.ordinal::int as ordinal,
               p.provision_seq::int as provision_seq,
               hit.char_start + preceding.length as char_start, hit.char_end + preceding.length as char_end,
               (hit.content_key is not null and p.content_key = hit.content_key) as same_wording,
               gate.source_url, gate.composition_digest
          from hit
          join legal_v2.forms f
            on f.form_id = hit.form_id and f.act_id = hit.act_id and f.privacy_class = 'public'
          join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
          cross join lateral (${FORM_READABLE_SQL}) gate
          join legal_v2.form_components c
            on c.form_id = f.form_id and c.unit_id = hit.unit_id and c.privacy_class = 'public'
          join legal_v2.text_units u on u.unit_id = c.unit_id and u.privacy_class = 'public'
          join legal_v2.form_sources s on ${BOUND_COMPONENT_SOURCE_SQL}
          join legal_v2.unit_provisions p
            on p.unit_id = hit.unit_id and p.provision_seq = hit.provision_seq
           and p.privacy_class = 'public'
          cross join lateral (
            select coalesce(sum((select max(ur.char_end) from legal_v2.unit_render ur
                                  where ur.unit_id = prev.unit_id and ur.privacy_class = 'public')
                                + ${COMPONENT_BOUNDARY.length}::int), 0)::int as length
              from legal_v2.form_components prev
             where prev.form_id = c.form_id and prev.ordinal < c.ordinal and prev.privacy_class = 'public'
          ) preceding
         where gate.readable and p.char_start <= hit.char_start and hit.char_end <= p.char_end
           and (select range_agg(int4range(ur.char_start, ur.char_end)) @> int4range(hit.char_start, hit.char_end)
                  from legal_v2.unit_render ur
                 where ur.unit_id = hit.unit_id and ur.privacy_class = 'public'
                   and ur.char_start < hit.char_end and hit.char_start < ur.char_end)
      `.execute(db);
      rows = result.rows;
    } catch (error) {
      return err(databaseError('legal_v2 hit verification failed', error));
    }
    const byIdx = new Map(rows.map((r) => [r.idx, r]));
    // The outline path of a verified provision, read only for the uses that may be returned:
    // per section the first use whose form the outline still reads, under the SAME composition
    // the verification read. A form unreadable at the second read, a changed composition or a
    // provision the outline does not name drops that use (and the next use of the section is
    // tried); nothing is returned with an unconfirmed path.
    const pathsByForm = new Map<string, V2ProvisionPaths | null>();
    const pathOf = async (row: VerifiedRow): Promise<Result<string | null, ApiError>> => {
      if (provisionPaths === undefined) return ok(row.address);
      if (!pathsByForm.has(row.form_id)) {
        const res = await provisionPaths(formDocumentId(row.form_id));
        if (res.isErr()) return err(res.error);
        pathsByForm.set(row.form_id, res.value);
      }
      const read = pathsByForm.get(row.form_id);
      if (read === null || read === undefined) return ok(null);
      if (read.compositionDigest !== row.composition_digest) return ok(null);
      return ok(read.paths.get(v2ProvisionKey(row.ordinal, row.provision_seq)) ?? null);
    };
    const out = new Map<number, VerifiedUse>();
    for (const f of flat) {
      const row = byIdx.get(f.idx);
      if (out.has(f.key) || row === undefined) continue;
      const path = await pathOf(row);
      if (path.isErr()) return err(path.error);
      if (provisionPaths !== undefined && path.value === null) continue;
      out.set(f.key, {
        use: f.use,
        path: path.value,
        composed: row.composed,
        charStart: row.char_start,
        charEnd: row.char_end,
        address: row.address,
        label: row.label_raw,
        sameWording: row.same_wording,
        servedForm: {
          versionKind: versionKindOf(row.form_kind),
          versionDate: row.portal_order_date,
          sourceUrl: row.source_url,
          // The act's amendment facts are merged in by the usecase.
          amendedAfterPublication: null,
          latestConsolidationDate: null,
          latestConsolidationLoaded: false,
          documentId: formDocumentId(row.form_id),
          caveat:
            row.caveat ?? (row.form_kind === 'consolidation' ? 'unofficial_consolidation' : null),
          portalLabelRaw: row.portal_label_raw,
          portalLabelDate: row.portal_label_date,
        },
      });
    }
    return ok(out);
  },
});
