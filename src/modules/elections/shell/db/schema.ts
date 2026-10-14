/**
 * Only the Elections tables the module reads enter the server DB type, and
 * only their named columns (scraper prod migrations 20260617T200000,
 * 20260627T140000, 20260627T141000): the three catalog dimensions, plus the
 * four the county source report reads. `attrs`, `raw_value`, evidence,
 * territory evidence, grain and classifier fields, artifact pointers and the
 * other fact tables are deliberately absent, so a repository cannot select
 * them; the report's carrier predicate names `attrs` in raw SQL only. bigint
 * ids are int8 → string, `numeric` is read as text.
 */
export interface ElectionsElectionRow {
  election_id: string;
  election_key: string;
  election_family: string;
  election_name: string;
  election_date: string | null;
  election_year: number | null;
  election_round: string | null;
  authority: string;
  event_id: string | null;
  privacy_class: string;
}

export interface ElectionsContestRow {
  contest_id: string;
  contest_key: string;
  election_id: string;
  office: string;
  chamber: string | null;
  round_label: string | null;
  scope_type: string;
  scope_key: string;
  scope_label: string | null;
  constituency_code: string | null;
  constituency_name: string | null;
  event_id: string | null;
  privacy_class: string;
}

export interface ElectionsElectoralEventRow {
  event_id: string;
  event_key: string;
  privacy_class: string;
}

export interface ElectionsResultRowRow {
  result_row_id: string;
  contest_id: string;
  reporting_unit_id: string;
  metric_code: string;
  electoral_competitor_id: string | null;
  candidate_id: string | null;
  numeric_value: string | null;
  source_resource_id: string;
  source_file_id: string | null;
  privacy_class: string;
}

export interface ElectionsReportingUnitRow {
  reporting_unit_id: string;
  scope_type: string;
  scope_key: string;
  privacy_class: string;
}

export interface ElectionsElectoralCompetitorRow {
  electoral_competitor_id: string;
  source_family: string;
  source_label: string;
  privacy_class: string;
}

export interface ElectionsSourceMetricMapRow {
  source_family: string;
  source_metric_code: string;
  metric_code: string;
  mapping_status: string;
  privacy_class: string;
}

declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'elections.elections': ElectionsElectionRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'elections.contests': ElectionsContestRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'elections.electoral_events': ElectionsElectoralEventRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'elections.result_rows': ElectionsResultRowRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'elections.reporting_units': ElectionsReportingUnitRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'elections.electoral_competitors': ElectionsElectoralCompetitorRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'elections.source_metric_map': ElectionsSourceMetricMapRow;
  }
}
