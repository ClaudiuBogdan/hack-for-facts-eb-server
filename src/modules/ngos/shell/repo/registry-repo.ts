import { sql, type Kysely, type SqlBool } from 'kysely';
import { err, ok } from 'neverthrow';

import {
  buildNextCursor,
  databaseError,
  decodeCursor,
  fhashFor,
  filterHash,
  invalidInput,
  toConditionBuilders,
  type FilterInput,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { ngoRegistryFilterSpec } from '../../core/filters.js';

import type { NgoRegistryRepository } from '../../core/ports.js';
import type { NgoRegistryRecord, NgoRegistrySnapshot } from '../../core/types.js';
import type { NgoPublicRecordRow, NgoPublicSnapshotRow } from '../db/schema.js';

export const registryFilterHash = (snapshotId: string, filter: FilterInput): string =>
  filterHash(`${snapshotId}:${fhashFor(ngoRegistryFilterSpec, filter)}`);

const snapshot = (row: NgoPublicSnapshotRow): NgoRegistrySnapshot => ({
  id: row.source_snapshot_id,
  sourceDeclaredDate: row.source_declared_snapshot_date,
  importedAt: new Date(row.loaded_at).toISOString(),
  capturedAt: new Date(row.captured_at).toISOString(),
  refreshOverdue: row.refresh_overdue,
  acceptedAt: row.accepted_at === null ? null : new Date(row.accepted_at).toISOString(),
  recordCount: row.row_count,
  isCurrent: row.is_current,
  sourceUrl: row.source_url,
  coverageBasis: row.coverage_basis,
  nationalCompleteness: row.national_completeness,
});

const record = (row: NgoPublicRecordRow): NgoRegistryRecord => ({
  id: row.legal_record_id,
  sourceRowNumber: row.source_row_number,
  registryNumber: row.registry_number,
  specialRegistryNumber: row.special_registry_number,
  sourceRegistrationDate: row.source_registration_date,
  category: row.entity_kind,
  legalForm: row.legal_form,
  name: row.organization_name,
  nameWithheld: row.name_withheld,
  court: row.court_name,
  sourceRegistryStatus: row.source_registry_status,
  county: row.county,
  locality: row.locality,
  sourceCui: row.source_cui,
  linkedOrganizationCui: row.linked_organization_cui,
  isBranch: row.is_branch,
  sourceReportsPublicUtility: row.source_reports_public_utility,
  snapshot: snapshot({ ...row, row_count: row.snapshot_row_count }),
});

const unavailable = () =>
  invalidInput(
    'NGO registry is not published yet. No live registry data is available.',
    'ngoRegistry'
  );
const readError = (error: unknown) => {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01')
    return unavailable();
  return databaseError('NGO registry read failed', error);
};

export const makeNgoRegistryRepo = (
  db: Kysely<ProdDatabase>,
  enabled: boolean
): NgoRegistryRepository => {
  const records = () =>
    db
      .selectFrom('ngo.rnong_public_records as r')
      .select([
        'r.legal_record_id',
        'r.source_snapshot_id',
        'r.source_row_number',
        'r.registry_number',
        'r.special_registry_number',
        'r.entity_kind',
        'r.legal_form',
        'r.organization_name',
        'r.name_withheld',
        'r.normalized_name',
        'r.court_name',
        'r.source_registry_status',
        'r.county',
        'r.locality',
        'r.source_cui',
        'r.linked_organization_cui',
        'r.is_branch',
        'r.source_reports_public_utility',
        'r.snapshot_row_count',
        'r.is_current',
        'r.source_url',
        'r.coverage_basis',
        'r.national_completeness',
        'r.privacy_class',
        'r.refresh_overdue',
        sql<string>`r.captured_at::text`.as('captured_at'),
        sql<string | null>`r.source_registration_date::text`.as('source_registration_date'),
        sql<string | null>`r.source_declared_snapshot_date::text`.as(
          'source_declared_snapshot_date'
        ),
        sql<string>`r.loaded_at::text`.as('loaded_at'),
        sql<string | null>`r.accepted_at::text`.as('accepted_at'),
      ])
      .where('r.privacy_class', '=', 'public');
  const coverage: NgoRegistryRepository['coverage'] = async () => {
    if (!enabled) return err(unavailable());
    try {
      const row = await db
        .selectFrom('ngo.rnong_public_snapshots as s')
        .select([
          's.source_snapshot_id',
          's.row_count',
          's.is_current',
          's.source_url',
          's.coverage_basis',
          's.national_completeness',
          's.privacy_class',
          's.refresh_overdue',
          sql<string>`s.captured_at::text`.as('captured_at'),
          sql<string | null>`s.source_declared_snapshot_date::text`.as(
            'source_declared_snapshot_date'
          ),
          sql<string>`s.loaded_at::text`.as('loaded_at'),
          sql<string | null>`s.accepted_at::text`.as('accepted_at'),
        ])
        .where('s.is_current', '=', true)
        .where('s.privacy_class', '=', 'public')
        .executeTakeFirst();
      if (row === undefined) return err(unavailable());
      const nonempty = await db
        .selectFrom('ngo.rnong_public_records')
        .select('legal_record_id')
        .where('source_snapshot_id', '=', row.source_snapshot_id)
        .where('privacy_class', '=', 'public')
        .limit(1)
        .executeTakeFirst();
      if (row.row_count <= 0 || nonempty === undefined)
        return err(databaseError('Published NGO snapshot has no records.'));
      return ok(snapshot(row));
    } catch (error) {
      return err(readError(error));
    }
  };
  return {
    coverage,
    async list(request) {
      const current = await coverage();
      if (current.isErr()) return err(current.error);
      const conditions = toConditionBuilders(ngoRegistryFilterSpec, request.filter);
      if (conditions.isErr()) return err(conditions.error);
      const fhash = registryFilterHash(current.value.id, request.filter);
      let afterRow = 0;
      if (request.after !== undefined) {
        const decoded = decodeCursor(request.after, { sort: 'sourceRowNumber', dir: 'asc', fhash });
        if (decoded.isErr()) return err(decoded.error);
        afterRow = Number(decoded.value.keys[0]);
        if (decoded.value.keys.length !== 1 || !Number.isSafeInteger(afterRow) || afterRow < 1)
          return err(invalidInput('invalid registry cursor; restart pagination', 'after'));
      }
      try {
        let query = records()
          .where('r.source_snapshot_id', '=', current.value.id)
          .where('r.source_row_number', '>', afterRow);
        for (const condition of conditions.value)
          query = query.where(condition as import('kysely').RawBuilder<SqlBool>);
        const rows = await query
          .orderBy('r.source_row_number', 'asc')
          .limit(request.first + 1)
          .execute();
        const items = rows.slice(0, request.first).map(record);
        const last = items.at(-1);
        const next =
          rows.length > request.first && last !== undefined
            ? buildNextCursor({
                sort: 'sourceRowNumber',
                dir: 'asc',
                fhash,
                lastKeys: [last.sourceRowNumber],
              })
            : null;
        return ok({ items, next, snapshot: current.value });
      } catch (error) {
        return err(readError(error));
      }
    },
    async detail(id) {
      if (!enabled) return err(unavailable());
      try {
        const row = await records().where('r.legal_record_id', '=', id).executeTakeFirst();
        return ok(row === undefined ? null : record(row));
      } catch (error) {
        return err(readError(error));
      }
    },
  };
};
