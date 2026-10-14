import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  offsetFor,
  serviceUnavailable,
  timeoutError,
  toConditionBuilders,
  type ApiError,
  type CollectionFilterSpec,
  type FilterInput,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import {
  COUNT_CELL_PATTERN,
  COUNTY_SOURCE,
  COUNTY_SOURCE_COMPETITOR_METRICS,
  COUNTY_SOURCE_STATEMENT_CODES,
} from '../../core/county-source.js';
import { electionCatalogFilterSpec, electionContestsFilterSpec } from '../../core/filters.js';

import type { ElectionsRepository } from '../../core/ports.js';
import type {
  CountySourceCompetitorRecord,
  CountySourceContestRecord,
  CountySourceIntegrityRecord,
  CountySourceReportRecord,
  ElectionContestRecord,
  ElectionEditionRecord,
  ElectionRecordPage,
} from '../../core/types.js';

/** A selected `elections.elections` row with its public event link. */
export interface EditionSqlRow {
  election_key: string;
  privacy_class: string;
  election_name: string;
  election_family: string;
  election_year: number | null;
  election_round: string | null;
  election_date: string | null;
  authority: string;
  event_key: string | null;
  event_privacy_class: string | null;
}

/** A selected `elections.contests` row with its edition key and public event link. */
export interface ContestSqlRow {
  contest_key: string;
  privacy_class: string;
  election_key: string;
  election_privacy_class: string;
  office: string;
  chamber: string | null;
  round_label: string | null;
  scope_type: string;
  scope_key: string;
  scope_label: string | null;
  constituency_code: string | null;
  constituency_name: string | null;
  event_key: string | null;
  event_privacy_class: string | null;
}

export const mapEditionRow = (row: EditionSqlRow): ElectionEditionRecord => ({
  electionKey: row.election_key,
  privacyClass: row.privacy_class,
  name: row.election_name,
  family: row.election_family,
  year: row.election_year,
  round: row.election_round,
  date: row.election_date,
  authority: row.authority,
  eventKey: row.event_key,
  eventPrivacyClass: row.event_privacy_class,
});

export const mapContestRow = (row: ContestSqlRow): ElectionContestRecord => ({
  contestKey: row.contest_key,
  privacyClass: row.privacy_class,
  electionKey: row.election_key,
  electionPrivacyClass: row.election_privacy_class,
  office: row.office,
  chamber: row.chamber,
  roundLabel: row.round_label,
  scopeType: row.scope_type,
  scopeKey: row.scope_key,
  scopeLabel: row.scope_label,
  constituencyCode: row.constituency_code,
  constituencyName: row.constituency_name,
  eventKey: row.event_key,
  eventPrivacyClass: row.event_privacy_class,
});

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

/** One read-only, repeatable-read transaction per request: count and page share a snapshot. */
const readOnly = async <T>(
  db: Kysely<ProdDatabase>,
  read: (trx: Kysely<ProdDatabase>) => Promise<Result<T, ApiError>>
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

const predicates = (
  spec: CollectionFilterSpec,
  filter: FilterInput
): Result<RawBuilder<SqlBool>[], ApiError> =>
  toConditionBuilders(spec, filter).map((conditions) =>
    conditions.map((condition) => condition as RawBuilder<SqlBool>)
  );

const exactCount = (total: string | undefined): Result<number, ApiError> => {
  const value = total === undefined ? Number.NaN : Number(total);
  return /^[0-9]+$/u.test(total ?? '') && Number.isSafeInteger(value)
    ? ok(value)
    : err(databaseError('Elections count is not an exact integer.'));
};

/** Public editions, each with its event link only when that event is public. */
const editions = (trx: Kysely<ProdDatabase>) =>
  trx
    .selectFrom('elections.elections as e')
    .leftJoin('elections.electoral_events as ev', (join) =>
      join.onRef('ev.event_id', '=', 'e.event_id').on('ev.privacy_class', '=', 'public')
    )
    .where('e.privacy_class', '=', 'public');

const EDITION_COLUMNS = [
  'e.election_key',
  'e.privacy_class',
  'e.election_name',
  'e.election_family',
  'e.election_year',
  'e.election_round',
  sql<string | null>`e.election_date::text`.as('election_date'),
  'e.authority',
  'ev.event_key',
  'ev.privacy_class as event_privacy_class',
] as const;

/** Public contests of public editions, each with its own event link only when public. */
const contests = (trx: Kysely<ProdDatabase>) =>
  trx
    .selectFrom('elections.contests as c')
    .innerJoin('elections.elections as e', 'e.election_id', 'c.election_id')
    .leftJoin('elections.electoral_events as ev', (join) =>
      join.onRef('ev.event_id', '=', 'c.event_id').on('ev.privacy_class', '=', 'public')
    )
    .where('c.privacy_class', '=', 'public')
    .where('e.privacy_class', '=', 'public');

const CONTEST_COLUMNS = [
  'c.contest_key',
  'c.privacy_class',
  'e.election_key',
  'e.privacy_class as election_privacy_class',
  'c.office',
  'c.chamber',
  'c.round_label',
  'c.scope_type',
  'c.scope_key',
  'c.scope_label',
  'c.constituency_code',
  'c.constituency_name',
  'ev.event_key',
  'ev.privacy_class as event_privacy_class',
] as const;

/** A contest of the qualified edition, office and scope (`contest_id` stays in the repository). */
export interface CountySourceContestSqlRow {
  contest_id: string;
  contest_key: string;
  privacy_class: string;
  election_key: string;
  election_privacy_class: string;
  office: string;
  scope_type: string;
  scope_key: string;
  scope_label: string | null;
}

export interface CountySourceStatementSqlRow {
  metric_code: string;
  value: string | null;
}

/**
 * One source label's grouped cells (over every competitor id carrying the
 * label); the cell counts let the usecase refuse duplicates.
 */
export interface CountySourceCompetitorSqlRow {
  source_label: string;
  privacy_class: string;
  voturi_cells: string;
  voturi: string | null;
  mandate_cells: string;
  mandate: string | null;
}

/** The contest's whole-report label counts (exact integers as text). */
export interface CountySourceIntegritySqlRow {
  labels: string;
  complete_labels: string;
  duplicated_labels: string;
  labels_with_null_cell: string;
  labels_with_non_integer_cell: string;
}

export const mapCountySourceIntegrityRow = (
  row: CountySourceIntegritySqlRow
): Result<{ total: number; integrity: CountySourceIntegrityRecord }, ApiError> => {
  const counts = [
    row.labels,
    row.complete_labels,
    row.duplicated_labels,
    row.labels_with_null_cell,
    row.labels_with_non_integer_cell,
  ].map(exactCount);
  const values: number[] = [];
  for (const count of counts) {
    if (count.isErr()) return err(count.error);
    values.push(count.value);
  }
  const [total = 0, completeLabels = 0, duplicatedLabels = 0, withNull = 0, withNonInteger = 0] =
    values;
  return ok({
    total,
    integrity: {
      completeLabels,
      duplicatedLabels,
      labelsWithNullCell: withNull,
      labelsWithNonIntegerCell: withNonInteger,
    },
  });
};

export const mapCountySourceContestRow = (
  row: CountySourceContestSqlRow
): CountySourceContestRecord => ({
  contestKey: row.contest_key,
  privacyClass: row.privacy_class,
  electionKey: row.election_key,
  electionPrivacyClass: row.election_privacy_class,
  office: row.office,
  scopeType: row.scope_type,
  scopeKey: row.scope_key,
  scopeLabel: row.scope_label,
});

const mapCountySourceCompetitorRow = (
  row: CountySourceCompetitorSqlRow
): Result<CountySourceCompetitorRecord, ApiError> =>
  exactCount(row.voturi_cells).andThen((voturiCells) =>
    exactCount(row.mandate_cells).map((mandateCells) => ({
      sourceLabel: row.source_label,
      privacyClass: row.privacy_class,
      voturiCells,
      voturi: row.voturi,
      mandateCells,
      mandate: row.mandate,
    }))
  );

/**
 * The qualified carrier's public cells of one contest: its resource and file,
 * its file hash and package, and its source-column provenance shape (`attrs`
 * predicates, never selected), a public reporting unit of the contest's own
 * county, a public map row of the package accepted for the same code, and no
 * candidate. Driven by the contest-leading `result_rows_contest_metric_idx
 * (contest_id, metric_code)`.
 *
 * Provenance: every cell of the qualified file was loaded with no explicit
 * source column (`attrs.sourceMetricColumn` absent or JSON null on all 20,244
 * rows), so its metric code IS its source code. A row naming an explicit
 * source column claims different provenance and is not this source's cell,
 * even when its canonical metric code matches.
 */
const carrierCells = (trx: Kysely<ProdDatabase>, contest: CountySourceContestSqlRow) =>
  trx
    .selectFrom('elections.result_rows as rr')
    .innerJoin('elections.reporting_units as ru', 'ru.reporting_unit_id', 'rr.reporting_unit_id')
    .innerJoin('elections.source_metric_map as m', (join) =>
      join
        .on('m.source_family', '=', COUNTY_SOURCE.packageName)
        .onRef('m.source_metric_code', '=', 'rr.metric_code')
        .onRef('m.metric_code', '=', 'rr.metric_code')
    )
    .where('rr.contest_id', '=', contest.contest_id)
    .where('rr.source_resource_id', '=', COUNTY_SOURCE.sourceResourceId)
    .where('rr.source_file_id', '=', COUNTY_SOURCE.sourceFileId)
    .where(sql<SqlBool>`rr.attrs ->> 'sourceFileSha256' = ${COUNTY_SOURCE.sourceFileSha256}`)
    .where(sql<SqlBool>`rr.attrs ->> 'packageName' = ${COUNTY_SOURCE.packageName}`)
    .where(sql<SqlBool>`rr.attrs ->> 'sourceMetricColumn' is null`)
    .where('rr.candidate_id', 'is', null)
    .where('rr.privacy_class', '=', 'public')
    .where('ru.privacy_class', '=', 'public')
    .where('ru.scope_type', '=', COUNTY_SOURCE.scopeType)
    .where('ru.scope_key', '=', contest.scope_key)
    .where('m.mapping_status', '=', COUNTY_SOURCE.acceptedMapStatus)
    .where('m.privacy_class', '=', 'public');

/** The carrier's `voturi`/`mandate` cells of public competitors of the package. */
const competitorCells = (trx: Kysely<ProdDatabase>, contest: CountySourceContestSqlRow) =>
  carrierCells(trx, contest)
    .innerJoin(
      'elections.electoral_competitors as ec',
      'ec.electoral_competitor_id',
      'rr.electoral_competitor_id'
    )
    .where('ec.source_family', '=', COUNTY_SOURCE.packageName)
    .where('ec.privacy_class', '=', 'public')
    .where('rr.metric_code', 'in', [...COUNTY_SOURCE_COMPETITOR_METRICS]);

const [VOTURI, MANDATE] = COUNTY_SOURCE_COMPETITOR_METRICS;

/**
 * The carrier's competitor cells grouped by SOURCE LABEL: a source cell is a
 * label + column, so a label carried by two competitor ids is one label with
 * duplicated cells, never two labels. Each group counts its cells per column,
 * its null numbers and its numbers that are not canonical integer text.
 * `privacy_class` is the greatest of the group's rows (the DDL's only other
 * class, 'restricted', sorts after 'public'), so a mixed group surfaces.
 */
const labelCells = (trx: Kysely<ProdDatabase>, contest: CountySourceContestSqlRow) =>
  competitorCells(trx, contest)
    .select([
      'ec.source_label',
      sql<string>`max(ec.privacy_class)`.as('privacy_class'),
      sql<string>`count(*) filter (where rr.metric_code = ${VOTURI})::text`.as('voturi_cells'),
      sql<string | null>`min(rr.numeric_value::text) filter (where rr.metric_code = ${VOTURI})`.as(
        'voturi'
      ),
      sql<string>`count(*) filter (where rr.metric_code = ${MANDATE})::text`.as('mandate_cells'),
      sql<string | null>`min(rr.numeric_value::text) filter (where rr.metric_code = ${MANDATE})`.as(
        'mandate'
      ),
      sql<string>`count(*) filter (where rr.numeric_value is null)::text`.as('null_cells'),
      sql<string>`count(*) filter (where rr.numeric_value::text !~ ${COUNT_CELL_PATTERN})::text`.as(
        'non_integer_cells'
      ),
    ])
    .groupBy('ec.source_label');

/**
 * Dimension reads for the catalog: `elections.elections` (50 rows),
 * `electoral_events` (35) and `contests` driven by `contests_election_scope_idx
 * (election_id, …)` or the unique `contest_key`. The one fact read is the
 * county source report's, bound to the qualified carrier. No `attrs` (outside
 * that carrier predicate), evidence, artifact, finality (`result_status`/
 * `is_final`) or canonical/corrected/classifier column is read.
 */
export const makeElectionsRepo = (
  db: Kysely<ProdDatabase>,
  enabled: boolean
): ElectionsRepository => ({
  listEditions(request) {
    if (!enabled) return Promise.resolve(err(disabled()));
    const where = predicates(electionCatalogFilterSpec, request.filter);
    if (where.isErr()) return Promise.resolve(err(where.error));
    return readOnly(db, async (trx) => {
      let counted = editions(trx).select(sql<string>`count(*)::text`.as('total'));
      let page = editions(trx).select(EDITION_COLUMNS);
      for (const condition of where.value) {
        counted = counted.where(condition);
        page = page.where(condition);
      }
      const total = exactCount((await counted.executeTakeFirst())?.total);
      if (total.isErr()) return err(total.error);
      const rows = await page
        .orderBy(sql`e.election_key collate "C"`)
        .limit(request.pageSize)
        .offset(offsetFor(request))
        .execute();
      return ok<ElectionRecordPage<ElectionEditionRecord>>({
        items: rows.map(mapEditionRow),
        total: total.value,
      });
    });
  },

  editionByKey(electionKey) {
    if (!enabled) return Promise.resolve(err(disabled()));
    return readOnly(db, async (trx) => {
      const row = await editions(trx)
        .select(EDITION_COLUMNS)
        .where('e.election_key', '=', electionKey)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapEditionRow(row));
    });
  },

  listContests(request) {
    if (!enabled) return Promise.resolve(err(disabled()));
    const where = predicates(electionContestsFilterSpec, request.filter);
    if (where.isErr()) return Promise.resolve(err(where.error));
    return readOnly(db, async (trx) => {
      const edition = await trx
        .selectFrom('elections.elections as e')
        .select('e.election_id')
        .where('e.election_key', '=', request.electionKey)
        .where('e.privacy_class', '=', 'public')
        .executeTakeFirst();
      if (edition === undefined) return ok(null);
      let counted = contests(trx)
        .select(sql<string>`count(*)::text`.as('total'))
        .where('c.election_id', '=', edition.election_id);
      let page = contests(trx)
        .select(CONTEST_COLUMNS)
        .where('c.election_id', '=', edition.election_id);
      for (const condition of where.value) {
        counted = counted.where(condition);
        page = page.where(condition);
      }
      const total = exactCount((await counted.executeTakeFirst())?.total);
      if (total.isErr()) return err(total.error);
      const rows = await page
        .orderBy(sql`c.contest_key collate "C"`)
        .limit(request.pageSize)
        .offset(offsetFor(request))
        .execute();
      return ok<ElectionRecordPage<ElectionContestRecord>>({
        items: rows.map(mapContestRow),
        total: total.value,
      });
    });
  },

  contestByKey(contestKey) {
    if (!enabled) return Promise.resolve(err(disabled()));
    return readOnly(db, async (trx) => {
      const row = await contests(trx)
        .select(CONTEST_COLUMNS)
        .where('c.contest_key', '=', contestKey)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapContestRow(row));
    });
  },

  countySourceReport(request) {
    if (!enabled) return Promise.resolve(err(disabled()));
    return readOnly(db, async (trx) => {
      const contest = await trx
        .selectFrom('elections.contests as c')
        .innerJoin('elections.elections as e', 'e.election_id', 'c.election_id')
        .select([
          'c.contest_id',
          'c.contest_key',
          'c.privacy_class',
          'e.election_key',
          'e.privacy_class as election_privacy_class',
          'c.office',
          'c.scope_type',
          'c.scope_key',
          'c.scope_label',
        ])
        .where('c.contest_key', '=', request.contestKey)
        .where('c.privacy_class', '=', 'public')
        .where('e.privacy_class', '=', 'public')
        .where('e.election_key', '=', COUNTY_SOURCE.electionKey)
        .where('c.office', '=', COUNTY_SOURCE.office)
        .where('c.scope_type', '=', COUNTY_SOURCE.scopeType)
        .executeTakeFirst();
      if (contest === undefined) return ok(null);
      const statement = await carrierCells(trx, contest)
        .select(['rr.metric_code', sql<string | null>`rr.numeric_value::text`.as('value')])
        .where('rr.electoral_competitor_id', 'is', null)
        .where('rr.metric_code', 'in', [...COUNTY_SOURCE_STATEMENT_CODES])
        .orderBy('rr.metric_code')
        .orderBy('rr.result_row_id')
        .execute();
      // Whole-report label counts, over every label of the contest, before any page.
      const counted = await trx
        .selectFrom(labelCells(trx, contest).as('l'))
        .select([
          sql<string>`count(*)::text`.as('labels'),
          sql<string>`count(*) filter (where l.voturi_cells::bigint = 1 and l.mandate_cells::bigint = 1)::text`.as(
            'complete_labels'
          ),
          sql<string>`count(*) filter (where l.voturi_cells::bigint > 1 or l.mandate_cells::bigint > 1)::text`.as(
            'duplicated_labels'
          ),
          sql<string>`count(*) filter (where l.null_cells::bigint > 0)::text`.as(
            'labels_with_null_cell'
          ),
          sql<string>`count(*) filter (where l.non_integer_cells::bigint > 0)::text`.as(
            'labels_with_non_integer_cell'
          ),
        ])
        .executeTakeFirst();
      if (counted === undefined) return err(databaseError('Elections count is missing.'));
      const summary = mapCountySourceIntegrityRow(counted);
      if (summary.isErr()) return err(summary.error);
      // Distinct labels never compare equal under "C", so the order is total.
      const rows = await labelCells(trx, contest)
        .orderBy(sql`ec.source_label collate "C"`)
        .limit(request.pageSize)
        .offset(offsetFor(request))
        .execute();
      const items: CountySourceCompetitorRecord[] = [];
      for (const row of rows) {
        const mapped = mapCountySourceCompetitorRow(row);
        if (mapped.isErr()) return err(mapped.error);
        items.push(mapped.value);
      }
      return ok<CountySourceReportRecord>({
        contest: mapCountySourceContestRow(contest),
        statement: statement.map((row) => ({ metricCode: row.metric_code, value: row.value })),
        competitors: { items, total: summary.value.total },
        integrity: summary.value.integrity,
      });
    });
  },
});
