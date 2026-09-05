/** Physical INS fact columns and ordering shared by list and default probes. */
import { sql, type RawBuilder } from 'kysely';

export interface FactRow {
  dataset_code: string;
  dim1_member_id: number | null;
  dim2_member_id: number | null;
  dim3_member_id: number | null;
  dim4_member_id: number | null;
  dim5_member_id: number | null;
  dim6_member_id: number | null;
  dim7_member_id: number | null;
  time_nom_item_id: number;
  unit_nom_item_id: number;
  period_id: number;
  period_start: string;
  period_end: string;
  currency_code: string | null;
  value: string | null;
  value_status: string | null;
  periodicity: string;
  period_label_ro: string;
  series_key?: string;
}

export const factSelect = sql`
  o.dataset_code, o.dim1_member_id, o.dim2_member_id, o.dim3_member_id, o.dim4_member_id,
  o.dim5_member_id, o.dim6_member_id, o.dim7_member_id, o.time_nom_item_id, o.unit_nom_item_id,
  o.period_id, o.period_start, o.period_end, o.currency_code, o.value, o.value_status,
  pe.periodicity, pe.label_ro as period_label_ro`;

export const factOrderColumns = sql`
  o.period_end desc, o.period_start desc, o.dim1_member_id, o.dim2_member_id,
           o.dim3_member_id, o.dim4_member_id, o.dim5_member_id, o.dim6_member_id,
           o.dim7_member_id, o.time_nom_item_id, o.unit_nom_item_id`;

export const factOrder = sql`order by ${factOrderColumns}`;

export const slotColumn = (slot: number): RawBuilder<unknown> =>
  sql.ref(`o.dim${String(slot)}_member_id`);
