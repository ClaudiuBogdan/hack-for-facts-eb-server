import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  offsetFor,
  serviceUnavailable,
  timeoutError,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { inValues } from '../../core/filters.js';

import type { ElectionsRepository } from '../../core/ports.js';
import type {
  ElectionCompetitorRecord,
  ElectionContestRaceRecord,
  ElectionContestRecord,
  ElectionCoverageRecord,
  ElectionEventRecord,
  ElectionOccurrenceRecord,
  ElectionPlaceRecord,
  ElectionRecordPage,
  ElectionResultRecord,
  ElectionScopeFiguresRecord,
  ElectionTallyRecord,
  ElectionTurnoutRecord,
} from '../../core/types.js';

/**
 * SQL over the scrapper's serving model. A request first resolves the active
 * publication of its event (`elections.serving_active`, through the
 * `active_*` views), then reads that publication's rows by `publication_id`,
 * which leads every generation table's unique index. Columns are named: no
 * attrs, decision ids, source pointers or candidate rows are read.
 */

type Db = Kysely<ProdDatabase>;

const disabled = (): ApiError => serviceUnavailable('Elections are not enabled on this server.');

const readError = (error: unknown): ApiError => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  // Undefined table/column: the serving schema predates this reader.
  if (code === '42P01' || code === '42703')
    return serviceUnavailable('Elections read schema is not deployed.');
  if (code === '57014') return timeoutError('Elections read timed out.');
  return databaseError('Elections read failed', error);
};

/** One read-only, repeatable-read transaction per request: every read shares a snapshot. */
const readOnly = async <T>(
  db: Db,
  read: (trx: Db) => Promise<Result<T, ApiError>>
): Promise<Result<T, ApiError>> => {
  try {
    return await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        await sql`set transaction read only`.execute(trx);
        await sql`set local statement_timeout = 5000`.execute(trx);
        return read(trx);
      });
  } catch (error) {
    return err(readError(error));
  }
};

export const exactCount = (total: string | undefined): Result<number, ApiError> => {
  const value = total === undefined ? Number.NaN : Number(total);
  return /^[0-9]+$/u.test(total ?? '') && Number.isSafeInteger(value)
    ? ok(value)
    : err(databaseError('Elections count is not an exact integer.'));
};

const page = (request: { page: number; pageSize: number }) =>
  sql`limit ${request.pageSize} offset ${offsetFor(request)}`;

/**
 * Territory names of one place key: the UAT's own row, or any row of the
 * county; nothing for diaspora, national or a code the reference lacks.
 */
const placeJoin = (key: RawBuilder<unknown>) => sql`
  left join lateral (
    select
      coalesce(u.name, k.county_name) as place_name,
      coalesce(u.county_code, k.county_code) as place_county_code,
      coalesce(u.county_name, k.county_name) as place_county_name
    from (select 1) as one
    left join lateral (
      select t.name, t.county_code, t.county_name from core.territories t
      where ${key} like 'uat:%' and t.siruta_code = substr(${key}, 5)
      order by t.id limit 1
    ) as u on true
    left join lateral (
      select t.county_code, t.county_name from core.territories t
      where ${key} like 'county:%' and t.county_code = substr(${key}, 8)
      order by t.id limit 1
    ) as k on true
  ) as p on true`;

interface PlaceColumns {
  place_name: string | null;
  place_county_code: string | null;
  place_county_name: string | null;
}

const toPlaceRecord = (placeKey: string, row: PlaceColumns): ElectionPlaceRecord => ({
  placeKey,
  name: row.place_name,
  countyCode: row.place_county_code,
  countyName: row.place_county_name,
});

// ── Occurrence and contest anchors ──

interface Anchor {
  publication_id: string;
  event_key: string;
}

/** The active publication holding an occurrence; null when none does. */
const occurrenceAnchor = async (
  trx: Db,
  occurrenceKey: string
): Promise<Result<Anchor | null, ApiError>> => {
  const rows = (
    await sql<Anchor>`
      select o.publication_id::text as publication_id, o.event_key
      from elections.active_serving_occurrences o
      where o.occurrence_key = ${occurrenceKey}
      limit 2
    `.execute(trx)
  ).rows;
  if (rows.length > 1) return err(databaseError('Elections occurrence is active twice.'));
  return ok(rows[0] ?? null);
};

interface ContestRow extends PlaceColumns {
  publication_id: string;
  contest_key: string;
  occurrence_key: string;
  event_key: string;
  office: string;
  status: string;
  replaced_by: string | null;
  jurisdiction_key: string;
}

const CONTEST_SELECT = sql`
  select c.publication_id::text as publication_id, c.contest_key, c.occurrence_key, o.event_key,
    c.office, c.status, c.replaced_by, c.jurisdiction_key,
    p.place_name, p.place_county_code, p.place_county_name
  from elections.active_serving_contests c
  join elections.serving_occurrences o
    on o.publication_id = c.publication_id and o.occurrence_key = c.occurrence_key
  ${placeJoin(sql.ref('c.jurisdiction_key'))}`;

const toContestRecord = (row: ContestRow): ElectionContestRecord => ({
  contestKey: row.contest_key,
  occurrenceKey: row.occurrence_key,
  eventKey: row.event_key,
  office: row.office,
  status: row.status,
  replacedBy: row.replaced_by,
  jurisdiction: toPlaceRecord(row.jurisdiction_key, row),
});

// ── Figures ──

interface TallyRow {
  contest_key: string | null;
  scope_key: string;
  competitor_key: string;
  competitor_kind: string | null;
  actor_key: string | null;
  display_label: string | null;
  reported_labels: string[] | null;
  reported_label: string;
  measure: string;
  allocation_phase: string;
  value: string;
  construction: string;
  source_level: string;
  finality: string;
  counted_population: string;
  geographic_completeness: string;
  includes_diaspora: boolean | null;
  status: string;
  issues: string[];
}

/** The competitor is joined, never filtered: a tally without its competitor fails the response. */
const TALLY_SELECT = sql`
  select t.contest_key, t.scope_key, t.competitor_key, k.competitor_kind, k.actor_key,
    k.display_label, k.reported_labels, t.reported_label, t.measure, t.allocation_phase,
    t.value::text as value, t.construction, t.source_level, t.finality, t.counted_population,
    t.geographic_completeness, t.includes_diaspora, t.status, t.issues
  from elections.result_tallies t
  left join elections.serving_competitors k
    on k.publication_id = t.publication_id and k.competitor_key = t.competitor_key`;

const toTallyRecord = (row: TallyRow): Result<ElectionTallyRecord, ApiError> =>
  row.competitor_kind === null || row.display_label === null || row.reported_labels === null
    ? err(databaseError('Elections tally names an unknown competitor; response refused.'))
    : ok({
        competitor: {
          competitorKey: row.competitor_key,
          kind: row.competitor_kind,
          actorKey: row.actor_key,
          label: row.display_label,
          reportedLabels: row.reported_labels,
        },
        reportedLabel: row.reported_label,
        measure: row.measure,
        allocationPhase: row.allocation_phase,
        value: row.value,
        construction: row.construction,
        sourceLevel: row.source_level,
        finality: row.finality,
        countedPopulation: row.counted_population,
        geographicCompleteness: row.geographic_completeness,
        includesDiaspora: row.includes_diaspora,
        status: row.status,
        issues: row.issues,
      });

interface TurnoutRow {
  contest_key: string | null;
  scope_key: string;
  measure: string;
  value: string;
  construction: string;
  source_level: string;
  finality: string;
  geographic_completeness: string;
  includes_diaspora: boolean | null;
  status: string;
  issues: string[];
}

const TURNOUT_SELECT = sql`
  select f.contest_key, f.scope_key, f.measure, f.value::text as value, f.construction,
    f.source_level, f.finality, f.geographic_completeness, f.includes_diaspora, f.status, f.issues
  from elections.turnout_figures f`;

const toTurnoutRecord = (row: TurnoutRow): ElectionTurnoutRecord => ({
  measure: row.measure,
  value: row.value,
  construction: row.construction,
  sourceLevel: row.source_level,
  finality: row.finality,
  geographicCompleteness: row.geographic_completeness,
  includesDiaspora: row.includes_diaspora,
  status: row.status,
  issues: row.issues,
});

const groupBy = <R, K>(rows: readonly R[], key: (row: R) => K): Map<K, R[]> => {
  const groups = new Map<K, R[]>();
  for (const row of rows) {
    const group = groups.get(key(row));
    if (group === undefined) groups.set(key(row), [row]);
    else group.push(row);
  }
  return groups;
};

const allTallies = (rows: readonly TallyRow[]): Result<ElectionTallyRecord[], ApiError> => {
  const tallies: ElectionTallyRecord[] = [];
  for (const row of rows) {
    const tally = toTallyRecord(row);
    if (tally.isErr()) return err(tally.error);
    tallies.push(tally.value);
  }
  return ok(tallies);
};

/** `contest_key = $c`, or `contest_key is null` for the office aggregate (both index-friendly). */
const contestIs = (column: RawBuilder<unknown>, contestKey: string | null) =>
  contestKey === null ? sql`${column} is null` : sql`${column} = ${contestKey}`;

/**
 * Votes and valid votes of contests at their own jurisdictions, keyed by
 * contest: the race inputs of a contest page.
 */
const raceInputs = async (
  trx: Db,
  publicationId: string,
  contests: readonly ContestRow[]
): Promise<Result<ElectionContestRaceRecord[], ApiError>> => {
  if (contests.length === 0) return ok([]);
  const occurrences = contests.map((row) => row.occurrence_key);
  const offices = contests.map((row) => row.office);
  const keys = contests.map((row) => row.contest_key);
  const scopes = contests.map((row) => row.jurisdiction_key);
  const target = sql`unnest(${occurrences}::text[], ${offices}::text[], ${keys}::text[], ${scopes}::text[])
    as x(occurrence_key, office, contest_key, scope_key)`;
  const votes = (
    await sql<TallyRow>`
      ${TALLY_SELECT}
      join ${target}
        on t.occurrence_key = x.occurrence_key and t.office = x.office
        and t.contest_key = x.contest_key and t.scope_key = x.scope_key
      where t.publication_id = ${publicationId}::bigint and t.measure = 'votes'
    `.execute(trx)
  ).rows;
  const valid = (
    await sql<TurnoutRow>`
      ${TURNOUT_SELECT}
      join ${target}
        on f.occurrence_key = x.occurrence_key and f.office = x.office
        and f.contest_key = x.contest_key and f.scope_key = x.scope_key
      where f.publication_id = ${publicationId}::bigint and f.measure = 'valid'
    `.execute(trx)
  ).rows;
  const votesBy = groupBy(votes, (row) => row.contest_key);
  const validBy = groupBy(valid, (row) => row.contest_key);
  const out: ElectionContestRaceRecord[] = [];
  for (const contest of contests) {
    const tallies = allTallies(votesBy.get(contest.contest_key) ?? []);
    if (tallies.isErr()) return err(tallies.error);
    const validRows = validBy.get(contest.contest_key) ?? [];
    if (validRows.length > 1) return err(databaseError('Elections figure is duplicated.'));
    const validRow = validRows[0];
    out.push({
      ...toContestRecord(contest),
      votes: tallies.value,
      valid: validRow === undefined ? null : toTurnoutRecord(validRow),
    });
  }
  return ok(out);
};

/** Places of a page of scope keys, in the given order. */
const placesOf = async (
  trx: Db,
  keys: readonly string[]
): Promise<Map<string, ElectionPlaceRecord>> => {
  if (keys.length === 0) return new Map();
  const rows = (
    await sql<PlaceColumns & { place_key: string }>`
      select s.place_key, p.place_name, p.place_county_code, p.place_county_name
      from unnest(${[...keys]}::text[]) as s(place_key)
      ${placeJoin(sql.ref('s.place_key'))}
    `.execute(trx)
  ).rows;
  return new Map(rows.map((row) => [row.place_key, toPlaceRecord(row.place_key, row)]));
};

interface FigureScope {
  publicationId: string;
  occurrenceKey: string;
  office: string;
  contestKey: string | null;
}

/** Tallies and turnout of the given scopes, grouped by scope key. */
const figuresOf = async (
  trx: Db,
  scope: FigureScope,
  scopeKeys: readonly string[]
): Promise<
  Result<
    Map<string, { tallies: ElectionTallyRecord[]; turnout: ElectionTurnoutRecord[] }>,
    ApiError
  >
> => {
  const out = new Map<
    string,
    { tallies: ElectionTallyRecord[]; turnout: ElectionTurnoutRecord[] }
  >();
  if (scopeKeys.length === 0) return ok(out);
  const keys = [...scopeKeys];
  const tallyRows = (
    await sql<TallyRow>`
      ${TALLY_SELECT}
      where t.publication_id = ${scope.publicationId}::bigint
        and t.occurrence_key = ${scope.occurrenceKey} and t.office = ${scope.office}
        and ${contestIs(sql.ref('t.contest_key'), scope.contestKey)}
        and t.scope_key = any(${keys}::text[])
    `.execute(trx)
  ).rows;
  const turnoutRows = (
    await sql<TurnoutRow>`
      ${TURNOUT_SELECT}
      where f.publication_id = ${scope.publicationId}::bigint
        and f.occurrence_key = ${scope.occurrenceKey} and f.office = ${scope.office}
        and ${contestIs(sql.ref('f.contest_key'), scope.contestKey)}
        and f.scope_key = any(${keys}::text[])
    `.execute(trx)
  ).rows;
  for (const key of keys) out.set(key, { tallies: [], turnout: [] });
  for (const row of tallyRows) {
    const tally = toTallyRecord(row);
    if (tally.isErr()) return err(tally.error);
    out.get(row.scope_key)?.tallies.push(tally.value);
  }
  for (const row of turnoutRows) out.get(row.scope_key)?.turnout.push(toTurnoutRecord(row));
  return ok(out);
};

/** The contest of an occurrence and office, when one of the publication's; null otherwise. */
const contestIn = async (trx: Db, scope: FigureScope): Promise<ContestRow | null | undefined> => {
  if (scope.contestKey === null) return undefined;
  const rows = (
    await sql<ContestRow>`
      ${CONTEST_SELECT}
      where c.publication_id = ${scope.publicationId}::bigint and c.contest_key = ${scope.contestKey}
        and c.occurrence_key = ${scope.occurrenceKey} and c.office = ${scope.office}
    `.execute(trx)
  ).rows;
  return rows[0] ?? null;
};

// ── Events ──

interface EventRow {
  event_key: string;
  publication_id: string;
  activated_at: string;
}

const EVENT_SELECT = sql`
  select a.event_key, a.publication_id::text as publication_id,
    to_char(a.activated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as activated_at
  from elections.serving_active a`;

interface OccurrenceRow {
  publication_id: string;
  occurrence_key: string;
  event_key: string;
  ballot_date: string;
  round_label: string;
  occurrence_kind: string;
  status: string;
}

/**
 * The occurrences of the given active publications with their contest counts
 * per office, keyed by publication and occurrence throughout. An occurrence key
 * active in two publications is refused, as the single-occurrence reads refuse it.
 */
const occurrencesOf = async (
  trx: Db,
  events: readonly EventRow[]
): Promise<Result<Map<string, ElectionOccurrenceRecord[]>, ApiError>> => {
  if (events.length === 0) return ok(new Map());
  const publications = events.map((row) => row.publication_id);
  const occurrences = (
    await sql<OccurrenceRow>`
      select o.publication_id::text as publication_id, o.occurrence_key, o.event_key,
        o.ballot_date::text as ballot_date, o.round_label, o.occurrence_kind, o.status
      from elections.serving_occurrences o
      where o.publication_id = any(${publications}::bigint[])
      order by o.event_key collate "C", o.ballot_date, o.occurrence_key collate "C"
    `.execute(trx)
  ).rows;
  const duplicated = (
    await sql<{ occurrence_key: string }>`
      select o.occurrence_key from elections.active_serving_occurrences o
      where o.occurrence_key in (
        select occurrence_key from elections.serving_occurrences
        where publication_id = any(${publications}::bigint[])
      )
      group by o.occurrence_key having count(*) > 1
      limit 1
    `.execute(trx)
  ).rows;
  if (duplicated.length > 0) return err(databaseError('Elections occurrence is active twice.'));
  const counts = (
    await sql<{ publication_id: string; occurrence_key: string; office: string; contests: string }>`
      select c.publication_id::text as publication_id, c.occurrence_key, c.office,
        count(*)::text as contests
      from elections.serving_contests c
      where c.publication_id = any(${publications}::bigint[])
      group by c.publication_id, c.occurrence_key, c.office
      order by c.office collate "C"
    `.execute(trx)
  ).rows;
  const officesBy = new Map<string, { office: string; contests: number }[]>();
  for (const row of counts) {
    const contests = exactCount(row.contests);
    if (contests.isErr()) return err(contests.error);
    const key = `${row.publication_id}\u0000${row.occurrence_key}`;
    const list = officesBy.get(key) ?? [];
    list.push({ office: row.office, contests: contests.value });
    officesBy.set(key, list);
  }
  const eventOf = new Map(events.map((row) => [row.publication_id, row.event_key]));
  const out = new Map<string, ElectionOccurrenceRecord[]>();
  for (const row of occurrences) {
    // An occurrence belongs to the event of its publication, never only by its own label.
    if (eventOf.get(row.publication_id) !== row.event_key)
      return err(databaseError('Elections occurrence belongs to another event.'));
    const list = out.get(row.publication_id) ?? [];
    list.push({
      occurrenceKey: row.occurrence_key,
      eventKey: row.event_key,
      ballotDate: row.ballot_date,
      round: row.round_label,
      kind: row.occurrence_kind,
      status: row.status,
      offices: officesBy.get(`${row.publication_id}\u0000${row.occurrence_key}`) ?? [],
    });
    out.set(row.publication_id, list);
  }
  return ok(out);
};

const toEventRecords = async (
  trx: Db,
  rows: readonly EventRow[]
): Promise<Result<ElectionEventRecord[], ApiError>> => {
  const occurrences = await occurrencesOf(trx, rows);
  if (occurrences.isErr()) return err(occurrences.error);
  return ok(
    rows.map((row) => ({
      eventKey: row.event_key,
      publicationId: row.publication_id,
      activatedAt: row.activated_at,
      occurrences: occurrences.value.get(row.publication_id) ?? [],
    }))
  );
};

// ── Repository ──

export const makeElectionsRepo = (db: Db, enabled = false): ElectionsRepository => ({
  listEvents: async (request) => {
    if (!enabled) return err(disabled());
    return readOnly(db, async (trx) => {
      const total = (
        await sql<{
          total: string;
        }>`select count(*)::text as total from elections.serving_active`.execute(trx)
      ).rows[0]?.total;
      const count = exactCount(total);
      if (count.isErr()) return err(count.error);
      const rows = (
        await sql<EventRow>`${EVENT_SELECT} order by a.event_key collate "C" ${page(request)}`.execute(
          trx
        )
      ).rows;
      const items = await toEventRecords(trx, rows);
      if (items.isErr()) return err(items.error);
      return ok({ items: items.value, total: count.value });
    });
  },

  eventByKey: async (eventKey) => {
    if (!enabled) return err(disabled());
    return readOnly(db, async (trx) => {
      const rows = (
        await sql<EventRow>`${EVENT_SELECT} where a.event_key = ${eventKey}`.execute(trx)
      ).rows;
      const row = rows[0];
      if (row === undefined) return ok(null);
      const events = await toEventRecords(trx, [row]);
      if (events.isErr()) return err(events.error);
      const event = events.value[0];
      if (event === undefined) return err(databaseError('Elections event vanished mid-read.'));
      return ok(event);
    });
  },

  listContests: async (request) => {
    if (!enabled) return err(disabled());
    return readOnly(db, async (trx) => {
      const anchor = await occurrenceAnchor(trx, request.occurrenceKey);
      if (anchor.isErr()) return err(anchor.error);
      if (anchor.value === null) return ok(null);
      const publicationId = anchor.value.publication_id;
      const offices = inValues(request.filter, 'offices');
      const statuses = inValues(request.filter, 'statuses');
      const types = inValues(request.filter, 'jurisdictionTypes');
      const counties = inValues(request.filter, 'countyCodes');
      const where = sql`
        where c.publication_id = ${publicationId}::bigint and c.occurrence_key = ${request.occurrenceKey}
        ${offices === undefined ? sql`` : sql`and c.office = any(${[...offices]}::text[])`}
        ${statuses === undefined ? sql`` : sql`and c.status = any(${[...statuses]}::text[])`}
        ${types === undefined ? sql`` : sql`and split_part(c.jurisdiction_key, ':', 1) = any(${[...types]}::text[])`}
        ${counties === undefined ? sql`` : sql`and p.place_county_code = any(${[...counties]}::text[])`}`;
      const total = (
        await sql<{ total: string }>`
          select count(*)::text as total from (${CONTEST_SELECT} ${where}) as matched
        `.execute(trx)
      ).rows[0]?.total;
      const count = exactCount(total);
      if (count.isErr()) return err(count.error);
      const rows = (
        await sql<ContestRow>`
          ${CONTEST_SELECT} ${where} order by c.contest_key collate "C" ${page(request)}
        `.execute(trx)
      ).rows;
      const items = await raceInputs(trx, publicationId, rows);
      if (items.isErr()) return err(items.error);
      return ok({ items: items.value, total: count.value });
    });
  },

  contestByKey: async (contestKey) => {
    if (!enabled) return err(disabled());
    return readOnly(db, async (trx) => {
      const rows = (
        await sql<ContestRow>`${CONTEST_SELECT} where c.contest_key = ${contestKey} limit 2`.execute(
          trx
        )
      ).rows;
      if (rows.length > 1) return err(databaseError('Elections contest is active twice.'));
      const row = rows[0];
      if (row === undefined) return ok(null);
      const items = await raceInputs(trx, row.publication_id, [row]);
      if (items.isErr()) return err(items.error);
      return ok(items.value[0] ?? null);
    });
  },

  result: async (request) => {
    if (!enabled) return err(disabled());
    return readOnly(db, async (trx) => {
      const anchor = await occurrenceAnchor(trx, request.occurrenceKey);
      if (anchor.isErr()) return err(anchor.error);
      if (anchor.value === null) return ok(null);
      const scope: FigureScope = {
        publicationId: anchor.value.publication_id,
        occurrenceKey: request.occurrenceKey,
        office: request.office,
        contestKey: request.contestKey,
      };
      const contest = await contestIn(trx, scope);
      if (contest === null) return ok(null);
      const figures = await figuresOf(trx, scope, [request.scopeKey]);
      if (figures.isErr()) return err(figures.error);
      const found = figures.value.get(request.scopeKey) ?? { tallies: [], turnout: [] };
      const coverageRows = (
        await sql<{
          measure: string;
          allocation_phase: string;
          scope_key: string | null;
          state: string;
          issues: string[];
        }>`
          select v.measure, v.allocation_phase, v.scope_key, v.state, v.issues
          from elections.figure_coverage v
          where v.publication_id = ${scope.publicationId}::bigint
            and v.occurrence_key = ${request.occurrenceKey} and v.office = ${request.office}
            and v.scope_type = split_part(${request.scopeKey}, ':', 1)
            and (v.scope_key = ${request.scopeKey} or v.scope_key is null)
          order by v.measure collate "C", v.allocation_phase collate "C", v.scope_key nulls first
        `.execute(trx)
      ).rows;
      const isJurisdiction = contest?.jurisdiction_key === request.scopeKey;
      const placeSpecific = coverageRows.some((row) => row.scope_key !== null);
      if (
        found.tallies.length === 0 &&
        found.turnout.length === 0 &&
        !placeSpecific &&
        !isJurisdiction
      )
        return ok(null);
      const places = await placesOf(trx, [request.scopeKey]);
      const place = places.get(request.scopeKey);
      if (place === undefined) return err(databaseError('Elections place vanished mid-read.'));
      const coverage: ElectionCoverageRecord[] = coverageRows.map((row) => ({
        measure: row.measure,
        allocationPhase: row.allocation_phase,
        scopeKey: row.scope_key,
        state: row.state,
        issues: row.issues,
      }));
      const record: ElectionResultRecord = {
        occurrenceKey: request.occurrenceKey,
        eventKey: anchor.value.event_key,
        office: request.office,
        contest: contest === undefined ? null : toContestRecord(contest),
        place,
        tallies: found.tallies,
        turnout: found.turnout,
        coverage,
      };
      return ok(record);
    });
  },

  listResultScopes: async (request) => {
    if (!enabled) return err(disabled());
    return readOnly(db, async (trx) => {
      const anchor = await occurrenceAnchor(trx, request.occurrenceKey);
      if (anchor.isErr()) return err(anchor.error);
      if (anchor.value === null) return ok(null);
      const scope: FigureScope = {
        publicationId: anchor.value.publication_id,
        occurrenceKey: request.occurrenceKey,
        office: request.office,
        contestKey: request.contestKey,
      };
      const contest = await contestIn(trx, scope);
      if (contest === null) return ok(null);
      const own = contest === undefined ? null : contest.jurisdiction_key;
      const scopes = sql`
        select t.scope_key from elections.result_tallies t
        where t.publication_id = ${scope.publicationId}::bigint
          and t.occurrence_key = ${scope.occurrenceKey} and t.office = ${scope.office}
          and ${contestIs(sql.ref('t.contest_key'), scope.contestKey)}
          and t.scope_type = ${request.scopeType}
        union
        select f.scope_key from elections.turnout_figures f
        where f.publication_id = ${scope.publicationId}::bigint
          and f.occurrence_key = ${scope.occurrenceKey} and f.office = ${scope.office}
          and ${contestIs(sql.ref('f.contest_key'), scope.contestKey)}
          and f.scope_type = ${request.scopeType}`;
      const children = sql`
        select s.scope_key from (${scopes}) as s
        ${own === null ? sql`` : sql`where s.scope_key <> ${own}`}`;
      const total = (
        await sql<{
          total: string;
        }>`select count(*)::text as total from (${children}) as c`.execute(trx)
      ).rows[0]?.total;
      const count = exactCount(total);
      if (count.isErr()) return err(count.error);
      const keys = (
        await sql<{ scope_key: string }>`
          ${children} order by s.scope_key collate "C" ${page(request)}
        `.execute(trx)
      ).rows.map((row) => row.scope_key);
      const figures = await figuresOf(trx, scope, keys);
      if (figures.isErr()) return err(figures.error);
      const places = await placesOf(trx, keys);
      const items: ElectionScopeFiguresRecord[] = [];
      for (const key of keys) {
        const place = places.get(key);
        const found = figures.value.get(key);
        if (place === undefined || found === undefined)
          return err(databaseError('Elections scope vanished mid-read.'));
        items.push({ place, tallies: found.tallies, turnout: found.turnout });
      }
      return ok({ items, total: count.value });
    });
  },

  listCompetitors: async (request) => {
    if (!enabled) return err(disabled());
    return readOnly(db, async (trx) => {
      const publication = (
        await sql<{ publication_id: string }>`
          select a.publication_id::text as publication_id from elections.serving_active a
          where a.event_key = ${request.eventKey}
        `.execute(trx)
      ).rows[0]?.publication_id;
      if (publication === undefined) return ok(null);
      const kinds = inValues(request.filter, 'kinds');
      const where = sql`
        where k.publication_id = ${publication}::bigint
        ${kinds === undefined ? sql`` : sql`and k.competitor_kind = any(${[...kinds]}::text[])`}`;
      const total = (
        await sql<{ total: string }>`
          select count(*)::text as total from elections.serving_competitors k ${where}
        `.execute(trx)
      ).rows[0]?.total;
      const count = exactCount(total);
      if (count.isErr()) return err(count.error);
      const rows = (
        await sql<{
          competitor_key: string;
          competitor_kind: string;
          actor_key: string | null;
          display_label: string;
          reported_labels: string[];
        }>`
          select k.competitor_key, k.competitor_kind, k.actor_key, k.display_label, k.reported_labels
          from elections.serving_competitors k ${where}
          order by k.competitor_key collate "C" ${page(request)}
        `.execute(trx)
      ).rows;
      const items: ElectionCompetitorRecord[] = rows.map((row) => ({
        competitorKey: row.competitor_key,
        kind: row.competitor_kind,
        actorKey: row.actor_key,
        label: row.display_label,
        reportedLabels: row.reported_labels,
      }));
      const result: ElectionRecordPage<ElectionCompetitorRecord> = { items, total: count.value };
      return ok(result);
    });
  },
});
