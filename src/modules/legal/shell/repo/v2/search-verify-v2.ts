/**
 * Verifies the legal-v2 units index's hits against legal_v2 before any of
 * their text is served (search-design §5.3: the index's `uses` name the form,
 * the unit, the provision and the range of every use of a wording).
 *
 * A use is verified when, in ONE statement:
 *  - its form is a public form of the hit's public act, and servable — the
 *    render's rule as `readFormsForActs` computes `readable` (published public
 *    composition of one public whole unit, public chunks, bound source, and a
 *    consolidation's Portal label or date);
 *  - its unit is that form's current component, public;
 *  - its provision (when the use names one) is public;
 *  - the unit's chunks over the use's range are public.
 * Text units are sealed and their ids never reused, so a verified unit id
 * still holds the wording the index copied; a replaced unit fails the check.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok } from 'neverthrow';

import { databaseError, type ProdDatabase } from '@/modules/shared/index.js';

import { readFormsForActs } from './v2-reads.js';
import { formDocumentId, versionKindOf } from '../../../core/v2/forms.js';

import type { LegalV2HitVerifier, V2HitUse, VerifiedUse } from '../../../core/v2/search.js';

type Db = Kysely<ProdDatabase>;

/** Uses read per verification (the hit window × uses per hit); not measured. */
const MAX_USES = 2_000;

export const makeLegalV2HitVerifier = (db: Db): LegalV2HitVerifier => ({
  verifyUses: async (candidates) => {
    const flat: { key: number; actId: string; use: V2HitUse; idx: number }[] = [];
    for (const c of candidates) {
      for (const use of c.uses) {
        if (flat.length >= MAX_USES) break;
        flat.push({ key: c.key, actId: c.actId, use, idx: flat.length });
      }
    }
    if (flat.length === 0) return ok(new Map());
    const actIds = [...new Set(flat.map((f) => f.actId))];
    const formsRes = await readFormsForActs(db, actIds);
    if (formsRes.isErr()) return err(formsRes.error);
    const readableForm = new Map(
      formsRes.value.filter((r) => r.readable).map((r) => [`${r.act_id}:${r.form_id}`, r])
    );
    const candidatesForSql = flat.filter((f) => readableForm.has(`${f.actId}:${f.use.formId}`));
    if (candidatesForSql.length === 0) return ok(new Map());
    let verifiedIdx: Set<number>;
    try {
      const values = sql.join(
        candidatesForSql.map(
          (f) =>
            sql`(${f.idx}::int, ${f.use.formId}::bigint, ${f.use.unitId}::bigint,
                 ${f.use.provisionSeq}::int, ${f.use.charStart}::int, ${f.use.charEnd}::int)`
        ),
        sql`, `
      );
      const result = await sql<{ idx: number }>`
        with u(idx, form_id, unit_id, provision_seq, char_start, char_end) as (values ${values})
        select u.idx
          from u
          join legal_v2.form_components c
            on c.form_id = u.form_id and c.unit_id = u.unit_id and c.privacy_class = 'public'
          join legal_v2.text_units t on t.unit_id = u.unit_id and t.privacy_class = 'public'
         where (u.provision_seq is null or exists (
                  select 1 from legal_v2.unit_provisions p
                   where p.unit_id = u.unit_id and p.provision_seq = u.provision_seq
                     and p.privacy_class = 'public'))
           and exists (
                  select 1 from legal_v2.unit_render r
                   where r.unit_id = u.unit_id and r.privacy_class = 'public'
                     and (u.char_start is null
                          or (r.char_start <= u.char_start and u.char_start < greatest(r.char_end, r.char_start + 1))))
           and not exists (
                  select 1 from legal_v2.unit_render r
                   where r.unit_id = u.unit_id and r.privacy_class <> 'public')
      `.execute(db);
      verifiedIdx = new Set(result.rows.map((r) => r.idx));
    } catch (error) {
      return err(databaseError('legal_v2 hit verification failed', error));
    }
    const out = new Map<number, VerifiedUse>();
    for (const f of candidatesForSql) {
      if (out.has(f.key) || !verifiedIdx.has(f.idx)) continue;
      const form = readableForm.get(`${f.actId}:${f.use.formId}`);
      if (form === undefined) continue;
      out.set(f.key, {
        use: f.use,
        servedForm: {
          versionKind: versionKindOf(form.form_kind),
          versionDate: form.portal_order_date,
          sourceUrl: form.source_url,
          // The amendment count is the act's, carried on the act hit.
          amendedAfterPublication: null,
          latestConsolidationDate: null,
          latestConsolidationLoaded: false,
          documentId: formDocumentId(form.form_id),
          caveat:
            form.caveat ?? (form.form_kind === 'consolidation' ? 'unofficial_consolidation' : null),
          portalLabelRaw: form.portal_label_raw,
          portalLabelDate: form.portal_label_date,
        },
      });
    }
    return ok(out);
  },
});
