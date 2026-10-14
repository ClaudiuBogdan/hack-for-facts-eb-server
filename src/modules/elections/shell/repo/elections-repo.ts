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

import { electionCatalogFilterSpec, electionContestsFilterSpec } from '../../core/filters.js';

import type { ElectionsRepository } from '../../core/ports.js';
import type {
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

/**
 * Dimension reads only: `elections.elections` (50 rows), `electoral_events`
 * (35) and `contests` driven by `contests_election_scope_idx (election_id, …)`
 * or the unique `contest_key`. No fact table, `attrs`, evidence, artifact,
 * finality (`result_status`/`is_final`) or canonical/corrected column.
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
});
