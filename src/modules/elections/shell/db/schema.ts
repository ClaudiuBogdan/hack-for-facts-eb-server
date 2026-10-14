/**
 * Only the three Elections dimension tables the catalog reads enter the server
 * DB type, and only their named public columns (scraper prod migrations
 * 20260617T200000, 20260627T140000, 20260627T141000). `attrs`, evidence,
 * territory evidence, artifact pointers and every fact table are deliberately
 * absent so a repository cannot select them. bigint ids are int8 → string.
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

declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'elections.elections': ElectionsElectionRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'elections.contests': ElectionsContestRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'elections.electoral_events': ElectionsElectoralEventRow;
  }
}
