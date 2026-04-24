import { sql, type Transaction } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { acquireAdvancedMapDatasetTransactionLocks } from '@/infra/database/user/advisory-locks.js';

import {
  createForbiddenError,
  createDatasetInUseError,
  createProviderError,
  type AdvancedMapDatasetError,
} from '../../core/errors.js';
import {
  type AdvancedMapDatasetConnection,
  type AdvancedMapDatasetDetail,
  type AdvancedMapDatasetReference,
  type AdvancedMapDatasetRow,
  type AdvancedMapDatasetSummary,
} from '../../core/types.js';
import { validateDatasetRows, validateUnit } from '../../core/usecases/helpers.js';

import type {
  AccessibleAdvancedMapDatasetLookupInput,
  AdvancedMapDatasetRepository,
  CreateAdvancedMapDatasetParams,
  ReplaceAdvancedMapDatasetRowsParams,
  UpdateAdvancedMapDatasetMetadataParams,
} from '../../core/ports.js';
import type { UserDatabase, UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

export interface AdvancedMapDatasetsRepoOptions {
  db: UserDbClient;
  logger: Logger;
}

const PUBLIC_DATASET_WRITE_FORBIDDEN_MESSAGE =
  'You do not have permission to manage public advanced map datasets';

interface DatasetRow {
  id: string;
  public_id: string;
  user_id: string;
  title: string;
  description: string | null;
  markdown_text: string | null;
  unit: string | null;
  visibility: 'private' | 'unlisted' | 'public';
  row_count: number;
  reference_count: number;
  replaced_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface DatasetValueRow {
  dataset_id: string;
  siruta_code: string;
  value_number: string | null;
  value_json: Record<string, unknown> | null;
}

interface DatasetCountRow {
  count: string | number | bigint;
}

type UserDbConnection = UserDbClient | Transaction<UserDatabase>;

function toDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string') {
    return new Date(value);
  }

  return new Date(String(value));
}

function toSummary(row: DatasetRow): AdvancedMapDatasetSummary {
  return {
    id: row.id,
    publicId: row.public_id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    markdown: row.markdown_text,
    unit: row.unit,
    visibility: row.visibility,
    rowCount: row.row_count,
    replacedAt: row.replaced_at === null ? null : toDate(row.replaced_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function serializeDatasetRow(datasetId: string, row: AdvancedMapDatasetRow) {
  return {
    dataset_id: datasetId,
    siruta_code: row.sirutaCode,
    value_number: row.valueNumber,
    value_json: row.valueJson,
  };
}

function toDatasetRow(row: DatasetValueRow): AdvancedMapDatasetRow {
  return {
    sirutaCode: row.siruta_code,
    valueNumber: row.value_number,
    valueJson: row.value_json as AdvancedMapDatasetRow['valueJson'],
  };
}

function toConnection(
  rows: DatasetRow[],
  totalCount: number,
  offset: number
): AdvancedMapDatasetConnection {
  return {
    nodes: rows.map(toSummary),
    pageInfo: {
      totalCount,
      hasNextPage: offset + rows.length < totalCount,
      hasPreviousPage: offset > 0,
    },
  };
}

interface UploadedDatasetSnapshotReference {
  datasetId: string;
  datasetPublicId?: string;
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : undefined;
}

function jsonSeriesContainsUploadedDataset(
  columnSql: ReturnType<typeof sql.ref>,
  reference: UploadedDatasetSnapshotReference
) {
  const datasetId = reference.datasetId.trim();
  const datasetPublicId = trimToUndefined(reference.datasetPublicId);

  const byDatasetId = sql<boolean>`
    (${columnSql} -> 'state' -> 'series') @> ${JSON.stringify([
      {
        type: 'uploaded-map-dataset',
        datasetId,
      },
    ])}::jsonb
  `;

  if (datasetPublicId === undefined) {
    return byDatasetId;
  }

  const byDatasetPublicId = sql<boolean>`
    (${columnSql} -> 'state' -> 'series') @> ${JSON.stringify([
      {
        type: 'uploaded-map-dataset',
        datasetPublicId,
      },
    ])}::jsonb
  `;

  return sql<boolean>`(${byDatasetId} OR ${byDatasetPublicId})`;
}

function jsonbContainsUploadedDataset(reference: UploadedDatasetSnapshotReference) {
  return jsonSeriesContainsUploadedDataset(sql.ref('last_snapshot'), reference);
}

function snapshotJsonContainsUploadedDataset(reference: UploadedDatasetSnapshotReference) {
  return jsonSeriesContainsUploadedDataset(sql.ref('snapshot'), reference);
}

async function insertDatasetRows(
  db: UserDbConnection,
  datasetId: string,
  rows: readonly AdvancedMapDatasetRow[]
): Promise<void> {
  const chunkSize = 1000;

  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    await db
      .insertInto('advancedmapdatasetrows')
      .values(chunk.map((row) => serializeDatasetRow(datasetId, row)) as never)
      .execute();
  }
}

async function loadDatasetRows(
  db: UserDbConnection,
  datasetId: string
): Promise<AdvancedMapDatasetRow[]> {
  const rows = await db
    .selectFrom('advancedmapdatasetrows')
    .select(['dataset_id', 'siruta_code', 'value_number', 'value_json'])
    .where('dataset_id', '=', datasetId)
    .orderBy('siruta_code', 'asc')
    .execute();

  const normalizedRows = rows.map((row) => toDatasetRow(row));
  const validationResult = validateDatasetRows(normalizedRows);
  if (validationResult.isErr()) {
    throw new Error(validationResult.error.message);
  }

  return validationResult.value;
}

async function listSnapshotBackedReferences(
  db: UserDbConnection,
  reference: UploadedDatasetSnapshotReference,
  options?: { publicOnly?: boolean }
): Promise<AdvancedMapDatasetReference[]> {
  // JSONB scans remain the reference source of truth for now. Transaction-scoped
  // dataset advisory locks make the delete/private/public invariants atomic
  // across dataset and map writes. See:
  // docs/specs/specs-202604091600-advanced-map-dataset-consistency-boundary.md
  const snapshotRows = await db
    .selectFrom('advancedmapanalyticssnapshots as s')
    .innerJoin('advancedmapanalyticsmaps as m', 'm.id', 's.map_id')
    .select(['m.id as map_id', 'm.title as map_title', 's.id as snapshot_id'])
    .where('m.deleted_at', 'is', null)
    .$if(options?.publicOnly === true, (query) => query.where('m.visibility', '=', 'public'))
    .where(snapshotJsonContainsUploadedDataset(reference))
    .orderBy('s.created_at', 'desc')
    .execute();

  const legacyRows = await db
    .selectFrom('advancedmapanalyticsmaps')
    .select(['id', 'title', 'last_snapshot_id'])
    .where('deleted_at', 'is', null)
    .$if(options?.publicOnly === true, (query) => query.where('visibility', '=', 'public'))
    .where('last_snapshot_id', 'is', null)
    .where(jsonbContainsUploadedDataset(reference))
    .orderBy('updated_at', 'desc')
    .execute();

  const references = new Map<string, AdvancedMapDatasetReference>();

  for (const row of snapshotRows) {
    const mapId = row.map_id;
    const snapshotId = row.snapshot_id;
    const key = `${mapId}:${snapshotId}`;
    references.set(key, {
      mapId,
      title: row.map_title,
      snapshotId,
    });
  }

  for (const row of legacyRows) {
    const key = `${row.id}:${row.last_snapshot_id ?? 'null'}`;
    references.set(key, {
      mapId: row.id,
      title: row.title,
      snapshotId: row.last_snapshot_id,
    });
  }

  return Array.from(references.values());
}

function buildAccessibleDatasetQuery(
  db: UserDbConnection,
  input: AccessibleAdvancedMapDatasetLookupInput
) {
  let query = db.selectFrom('advancedmapdatasets').selectAll().where('deleted_at', 'is', null);

  if (typeof input.datasetId === 'string' && input.datasetId.trim() !== '') {
    if (input.requestUserId === undefined || input.requestUserId.trim() === '') {
      return query.where(sql<boolean>`FALSE`);
    }

    return query
      .where('id', '=', input.datasetId.trim())
      .where('user_id', '=', input.requestUserId.trim());
  } else if (typeof input.datasetPublicId === 'string' && input.datasetPublicId.trim() !== '') {
    query = query.where('public_id', '=', input.datasetPublicId.trim());
  }

  if (input.requestUserId !== undefined && input.requestUserId.trim() !== '') {
    const requestUserId = input.requestUserId.trim();
    query = query.where((eb) =>
      eb.or([eb('user_id', '=', requestUserId), eb('visibility', 'in', ['public', 'unlisted'])])
    );
  } else {
    query = query.where('visibility', 'in', ['public', 'unlisted']);
  }

  return query;
}

class KyselyAdvancedMapDatasetsRepo implements AdvancedMapDatasetRepository {
  private readonly db: UserDbClient;
  private readonly log: Logger;

  constructor(options: AdvancedMapDatasetsRepoOptions) {
    this.db = options.db;
    this.log = options.logger.child({ module: 'advanced-map-datasets-repo' });
  }

  private async toDetail(db: UserDbConnection, row: DatasetRow): Promise<AdvancedMapDatasetDetail> {
    return {
      ...toSummary(row),
      rows: await loadDatasetRows(db, row.id),
    };
  }

  async createDataset(
    input: CreateAdvancedMapDatasetParams
  ): Promise<Result<AdvancedMapDatasetDetail, AdvancedMapDatasetError>> {
    const unitResult = validateUnit(input.unit);
    if (unitResult.isErr()) {
      return err(unitResult.error);
    }

    const rowsResult = validateDatasetRows(input.rows);
    if (rowsResult.isErr()) {
      return err(rowsResult.error);
    }

    try {
      const result = await this.db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto('advancedmapdatasets')
          .values({
            id: input.id,
            public_id: input.publicId,
            user_id: input.userId,
            title: input.title,
            description: input.description,
            markdown_text: input.markdown,
            unit: unitResult.value,
            visibility: input.visibility,
            row_count: rowsResult.value.length,
            reference_count: 0,
            replaced_at: null,
            updated_at: new Date(),
          } as never)
          .returningAll()
          .executeTakeFirst();

        if (inserted === undefined) {
          throw new Error('Failed to insert dataset row');
        }

        await insertDatasetRows(trx, input.id, rowsResult.value);

        return {
          ...toSummary(inserted),
          rows: [...rowsResult.value],
        } satisfies AdvancedMapDatasetDetail;
      });

      return ok(result);
    } catch (error) {
      this.log.error({ err: error, userId: input.userId }, 'Failed to create dataset');
      return err(createProviderError('Failed to create dataset', error));
    }
  }

  async getShareableDatasetHeadById(
    datasetId: string
  ): Promise<Result<AdvancedMapDatasetSummary | null, AdvancedMapDatasetError>> {
    try {
      const row = await this.db
        .selectFrom('advancedmapdatasets')
        .selectAll()
        .where('id', '=', datasetId)
        .where('visibility', 'in', ['public', 'unlisted'])
        .where('deleted_at', 'is', null)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      return ok(toSummary(row as unknown as DatasetRow));
    } catch (error) {
      this.log.error({ err: error, datasetId }, 'Failed to load shareable dataset head');
      return err(createProviderError('Failed to load dataset', error));
    }
  }

  async getDatasetForUser(
    datasetId: string,
    userId: string
  ): Promise<Result<AdvancedMapDatasetDetail | null, AdvancedMapDatasetError>> {
    try {
      const row = await this.db
        .selectFrom('advancedmapdatasets')
        .selectAll()
        .where('id', '=', datasetId)
        .where('user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      return ok(await this.toDetail(this.db, row as unknown as DatasetRow));
    } catch (error) {
      this.log.error({ err: error, datasetId, userId }, 'Failed to load dataset for user');
      return err(createProviderError('Failed to load dataset', error));
    }
  }

  async listDatasetsForUser(
    userId: string,
    limit: number,
    offset: number
  ): Promise<Result<AdvancedMapDatasetConnection, AdvancedMapDatasetError>> {
    try {
      const [rows, countRow] = await Promise.all([
        this.db
          .selectFrom('advancedmapdatasets')
          .selectAll()
          .where('user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .orderBy('updated_at', 'desc')
          .limit(limit)
          .offset(offset)
          .execute(),
        this.db
          .selectFrom('advancedmapdatasets')
          .select(sql<string>`count(*)`.as('count'))
          .where('user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      ]);

      const totalCount = Number((countRow as DatasetCountRow | undefined)?.count ?? 0);
      return ok(toConnection(rows as unknown as DatasetRow[], totalCount, offset));
    } catch (error) {
      this.log.error({ err: error, userId }, 'Failed to list user datasets');
      return err(createProviderError('Failed to list datasets', error));
    }
  }

  async updateDatasetMetadata(
    input: UpdateAdvancedMapDatasetMetadataParams
  ): Promise<Result<AdvancedMapDatasetDetail | null, AdvancedMapDatasetError>> {
    try {
      const txResult = await this.db.transaction().execute(async (trx) => {
        await acquireAdvancedMapDatasetTransactionLocks(trx, [input.datasetId]);

        const current = await trx
          .selectFrom('advancedmapdatasets')
          .selectAll()
          .where('id', '=', input.datasetId)
          .where('user_id', '=', input.userId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();

        if (current === undefined) {
          return ok<AdvancedMapDatasetDetail | null, AdvancedMapDatasetError>(null);
        }

        const currentRow = current as unknown as DatasetRow;
        if (
          !input.allowPublicWrite &&
          (currentRow.visibility === 'public' || input.visibility === 'public')
        ) {
          return err(createForbiddenError(PUBLIC_DATASET_WRITE_FORBIDDEN_MESSAGE));
        }

        const unitResult = validateUnit(input.unit);
        if (unitResult.isErr()) {
          return err(unitResult.error);
        }

        if (currentRow.visibility !== 'private' && input.visibility === 'private') {
          const references = await listSnapshotBackedReferences(
            trx,
            {
              datasetId: currentRow.id,
              datasetPublicId: currentRow.public_id,
            },
            {
              publicOnly: true,
            }
          );
          if (references.length > 0) {
            return err(
              createDatasetInUseError(
                references,
                'Dataset is referenced by public maps and cannot be made private'
              )
            );
          }
        }

        const updated = await trx
          .updateTable('advancedmapdatasets')
          .set({
            title: input.title,
            description: input.description,
            markdown_text: input.markdown,
            unit: unitResult.value,
            visibility: input.visibility,
            updated_at: new Date(),
          } as never)
          .where('id', '=', input.datasetId)
          .where('user_id', '=', input.userId)
          .where('deleted_at', 'is', null)
          .returningAll()
          .executeTakeFirst();

        if (updated === undefined) {
          return ok<AdvancedMapDatasetDetail | null, AdvancedMapDatasetError>(null);
        }

        return ok(await this.toDetail(trx, updated as unknown as DatasetRow));
      });

      return txResult;
    } catch (error) {
      this.log.error(
        { err: error, datasetId: input.datasetId, userId: input.userId },
        'Failed to update dataset metadata'
      );
      return err(createProviderError('Failed to update dataset', error));
    }
  }

  async replaceDatasetRows(
    input: ReplaceAdvancedMapDatasetRowsParams
  ): Promise<Result<AdvancedMapDatasetDetail | null, AdvancedMapDatasetError>> {
    try {
      const txResult = await this.db.transaction().execute(async (trx) => {
        await acquireAdvancedMapDatasetTransactionLocks(trx, [input.datasetId]);

        const current = await trx
          .selectFrom('advancedmapdatasets')
          .selectAll()
          .where('id', '=', input.datasetId)
          .where('user_id', '=', input.userId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();

        if (current === undefined) {
          return ok<AdvancedMapDatasetDetail | null, AdvancedMapDatasetError>(null);
        }

        const currentRow = current as unknown as DatasetRow;
        if (!input.allowPublicWrite && currentRow.visibility === 'public') {
          return err(createForbiddenError(PUBLIC_DATASET_WRITE_FORBIDDEN_MESSAGE));
        }

        const rowsResult = validateDatasetRows(input.rows);
        if (rowsResult.isErr()) {
          return err(rowsResult.error);
        }

        const updated = await trx
          .updateTable('advancedmapdatasets')
          .set({
            row_count: rowsResult.value.length,
            replaced_at: new Date(),
            updated_at: new Date(),
          } as never)
          .where('id', '=', input.datasetId)
          .where('user_id', '=', input.userId)
          .where('deleted_at', 'is', null)
          .returningAll()
          .executeTakeFirst();

        if (updated === undefined) {
          return ok<AdvancedMapDatasetDetail | null, AdvancedMapDatasetError>(null);
        }

        await trx
          .deleteFrom('advancedmapdatasetrows')
          .where('dataset_id', '=', input.datasetId)
          .execute();
        await insertDatasetRows(trx, input.datasetId, rowsResult.value);

        return ok({
          ...toSummary(updated as unknown as DatasetRow),
          rows: [...rowsResult.value],
        } satisfies AdvancedMapDatasetDetail);
      });

      return txResult;
    } catch (error) {
      this.log.error(
        { err: error, datasetId: input.datasetId, userId: input.userId },
        'Failed to replace dataset rows'
      );
      return err(createProviderError('Failed to replace dataset rows', error));
    }
  }

  async softDeleteDataset(
    datasetId: string,
    userId: string,
    allowPublicWrite: boolean
  ): Promise<Result<boolean, AdvancedMapDatasetError>> {
    try {
      const txResult = await this.db.transaction().execute(async (trx) => {
        await acquireAdvancedMapDatasetTransactionLocks(trx, [datasetId]);

        const current = await trx
          .selectFrom('advancedmapdatasets')
          .selectAll()
          .where('id', '=', datasetId)
          .where('user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();

        if (current === undefined) {
          return ok<boolean, AdvancedMapDatasetError>(false);
        }

        const currentRow = current as unknown as DatasetRow;
        if (!allowPublicWrite && currentRow.visibility === 'public') {
          return err(createForbiddenError(PUBLIC_DATASET_WRITE_FORBIDDEN_MESSAGE));
        }

        const references = await listSnapshotBackedReferences(trx, {
          datasetId: currentRow.id,
          datasetPublicId: currentRow.public_id,
        });
        if (references.length > 0) {
          return err(createDatasetInUseError(references));
        }

        const result = await trx
          .updateTable('advancedmapdatasets')
          .set({
            deleted_at: new Date(),
            updated_at: new Date(),
          } as never)
          .where('id', '=', datasetId)
          .where('user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();

        return ok(Number(result.numUpdatedRows) > 0);
      });

      return txResult;
    } catch (error) {
      this.log.error({ err: error, datasetId, userId }, 'Failed to delete dataset');
      return err(createProviderError('Failed to delete dataset', error));
    }
  }

  async listPublicDatasets(
    limit: number,
    offset: number
  ): Promise<Result<AdvancedMapDatasetConnection, AdvancedMapDatasetError>> {
    try {
      const [rows, countRow] = await Promise.all([
        this.db
          .selectFrom('advancedmapdatasets')
          .selectAll()
          .where('visibility', '=', 'public')
          .where('deleted_at', 'is', null)
          .orderBy('updated_at', 'desc')
          .limit(limit)
          .offset(offset)
          .execute(),
        this.db
          .selectFrom('advancedmapdatasets')
          .select(sql<string>`count(*)`.as('count'))
          .where('visibility', '=', 'public')
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      ]);

      const totalCount = Number((countRow as DatasetCountRow | undefined)?.count ?? 0);
      return ok(toConnection(rows as unknown as DatasetRow[], totalCount, offset));
    } catch (error) {
      this.log.error({ err: error }, 'Failed to list public datasets');
      return err(createProviderError('Failed to list public datasets', error));
    }
  }

  async getPublicDatasetByPublicId(
    publicId: string
  ): Promise<Result<AdvancedMapDatasetDetail | null, AdvancedMapDatasetError>> {
    try {
      const row = await this.db
        .selectFrom('advancedmapdatasets')
        .selectAll()
        .where('public_id', '=', publicId)
        .where('visibility', 'in', ['public', 'unlisted'])
        .where('deleted_at', 'is', null)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      return ok(await this.toDetail(this.db, row as unknown as DatasetRow));
    } catch (error) {
      this.log.error({ err: error, publicId }, 'Failed to load public dataset');
      return err(createProviderError('Failed to load dataset', error));
    }
  }

  async getAccessibleDatasetHead(
    input: AccessibleAdvancedMapDatasetLookupInput
  ): Promise<Result<AdvancedMapDatasetSummary | null, AdvancedMapDatasetError>> {
    try {
      if (
        (input.datasetId === undefined || input.datasetId.trim() === '') &&
        (input.datasetPublicId === undefined || input.datasetPublicId.trim() === '')
      ) {
        return ok(null);
      }

      const row = await buildAccessibleDatasetQuery(this.db, input).executeTakeFirst();
      if (row === undefined) {
        return ok(null);
      }

      return ok(toSummary(row as unknown as DatasetRow));
    } catch (error) {
      this.log.error(
        { err: error, datasetId: input.datasetId, datasetPublicId: input.datasetPublicId },
        'Failed to load accessible dataset head'
      );
      return err(createProviderError('Failed to load dataset', error));
    }
  }

  async getAccessibleDataset(
    input: AccessibleAdvancedMapDatasetLookupInput
  ): Promise<Result<AdvancedMapDatasetDetail | null, AdvancedMapDatasetError>> {
    try {
      if (
        (input.datasetId === undefined || input.datasetId.trim() === '') &&
        (input.datasetPublicId === undefined || input.datasetPublicId.trim() === '')
      ) {
        return ok(null);
      }

      const dataset = await this.db.transaction().execute(async (trx) => {
        const row = await buildAccessibleDatasetQuery(trx, input).forShare().executeTakeFirst();
        if (row === undefined) {
          return null;
        }

        return this.toDetail(trx, row);
      });

      return ok(dataset);
    } catch (error) {
      this.log.error(
        { err: error, datasetId: input.datasetId, datasetPublicId: input.datasetPublicId },
        'Failed to load accessible dataset'
      );
      return err(createProviderError('Failed to load dataset', error));
    }
  }

  async listDatasetRows(
    datasetId: string
  ): Promise<Result<AdvancedMapDatasetRow[], AdvancedMapDatasetError>> {
    try {
      const dataset = await this.db
        .selectFrom('advancedmapdatasets')
        .select(['id'])
        .where('id', '=', datasetId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();

      if (dataset === undefined) {
        return ok([]);
      }

      return ok(await loadDatasetRows(this.db, datasetId));
    } catch (error) {
      this.log.error({ err: error, datasetId }, 'Failed to list dataset rows');
      return err(createProviderError('Failed to load dataset rows', error));
    }
  }

  async listReferencingMaps(
    datasetId: string
  ): Promise<Result<AdvancedMapDatasetReference[], AdvancedMapDatasetError>> {
    try {
      const datasetRow = await this.db
        .selectFrom('advancedmapdatasets')
        .select(['id', 'public_id'])
        .where('id', '=', datasetId)
        .executeTakeFirst();

      if (datasetRow === undefined) {
        return ok([]);
      }

      return ok(
        await listSnapshotBackedReferences(this.db, {
          datasetId: datasetRow.id,
          datasetPublicId: datasetRow.public_id,
        })
      );
    } catch (error) {
      this.log.error({ err: error, datasetId }, 'Failed to list referencing maps');
      return err(createProviderError('Failed to list referencing maps', error));
    }
  }

  async listPublicReferencingMaps(
    datasetId: string
  ): Promise<Result<AdvancedMapDatasetReference[], AdvancedMapDatasetError>> {
    try {
      const datasetRow = await this.db
        .selectFrom('advancedmapdatasets')
        .select(['id', 'public_id'])
        .where('id', '=', datasetId)
        .executeTakeFirst();

      if (datasetRow === undefined) {
        return ok([]);
      }

      return ok(
        await listSnapshotBackedReferences(
          this.db,
          {
            datasetId: datasetRow.id,
            datasetPublicId: datasetRow.public_id,
          },
          { publicOnly: true }
        )
      );
    } catch (error) {
      this.log.error({ err: error, datasetId }, 'Failed to list public referencing maps');
      return err(createProviderError('Failed to list public referencing maps', error));
    }
  }
}

export const makeAdvancedMapDatasetsRepo = (
  options: AdvancedMapDatasetsRepoOptions
): AdvancedMapDatasetRepository => {
  return new KyselyAdvancedMapDatasetsRepo(options);
};
