/**
 * Verifies the legal-v2 units index's hits against legal_v2 before any of
 * their text is served (search-design §5.3: the index's `uses` name the form,
 * the unit, the provision and the range of every use of a wording).
 *
 * ONE statement per verification (one snapshot) checks each use:
 *  - its form is a public form of the hit's public act and servable — the
 *    render's rule (`FORM_READABLE_SQL`: published public composition of one
 *    public whole unit, public chunks, bound source, a consolidation's label);
 *  - its unit is that form's current public component;
 *  - its provision is public and holds the use's WHOLE range [start, end);
 *  - the unit's chunks are all public and reach the range's end;
 * and answers the occurrence's own facts: the provision's parser address and
 * label, whether its content key is the indexed wording's, and the source URL
 * of the supplying unit's own bound capture. Text units are sealed and their
 * ids never reused, so a replaced unit fails the check.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok } from 'neverthrow';

import { databaseError, type ProdDatabase } from '@/modules/shared/index.js';

import { FORM_READABLE_SQL } from './v2-reads.js';
import { formDocumentId, versionKindOf } from '../../../core/v2/forms.js';

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
  source_url: string | null;
}

export const makeLegalV2HitVerifier = (db: Db): LegalV2HitVerifier => ({
  verifyUses: async (candidates) => {
    const flat: { key: number; actId: string; use: V2HitUse; idx: number }[] = [];
    for (const c of candidates) {
      for (const use of c.uses) {
        if (flat.length >= MAX_USES) break;
        // Only an occurrence with a provision and a whole range can supply
        // the displayed fields.
        if (use.provisionSeq === null || use.charStart === null || use.charEnd === null) continue;
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
        with u(idx, act_id, form_id, unit_id, provision_seq, char_start, char_end, content_key)
          as (values ${values})
        select u.idx, f.form_id::text as form_id, f.form_kind, f.caveat, f.portal_label_raw,
               f.portal_label_date::text as portal_label_date,
               f.portal_order_date::text as portal_order_date,
               p.address, p.label_raw,
               (u.content_key is not null and p.content_key = u.content_key) as same_wording,
               src.requested_url as source_url
          from u
          join legal_v2.forms f
            on f.form_id = u.form_id and f.act_id = u.act_id and f.privacy_class = 'public'
          join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
          join legal_v2.form_components c
            on c.form_id = f.form_id and c.unit_id = u.unit_id and c.privacy_class = 'public'
          join legal_v2.text_units t on t.unit_id = u.unit_id and t.privacy_class = 'public'
          join legal_v2.unit_provisions p
            on p.unit_id = u.unit_id and p.provision_seq = u.provision_seq
           and p.privacy_class = 'public'
          join lateral (
            select s.requested_url from legal_v2.form_sources s
             where s.capture_ref_id = t.capture_ref_id and s.form_id = f.form_id
               and s.subject_kind = 'capture' and s.status = 'bound' and s.privacy_class = 'public'
             order by s.binding_id
             limit 1) src on true
         where ${FORM_READABLE_SQL}
           and u.char_start < u.char_end
           and p.char_start <= u.char_start and u.char_end <= p.char_end
           and coalesce((select max(ur.char_end) from legal_v2.unit_render ur
                          where ur.unit_id = u.unit_id and ur.privacy_class = 'public'), -1)
               >= u.char_end
           and not exists (select 1 from legal_v2.unit_render ur
                            where ur.unit_id = u.unit_id and ur.privacy_class <> 'public')
      `.execute(db);
      rows = result.rows;
    } catch (error) {
      return err(databaseError('legal_v2 hit verification failed', error));
    }
    const byIdx = new Map(rows.map((r) => [r.idx, r]));
    const out = new Map<number, VerifiedUse>();
    for (const f of flat) {
      const row = byIdx.get(f.idx);
      if (out.has(f.key) || row === undefined) continue;
      out.set(f.key, {
        use: f.use,
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
