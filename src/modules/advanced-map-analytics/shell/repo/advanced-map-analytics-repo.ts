/**
 * Advanced Map Analytics Repository - Kysely implementation
 */

import { sql, type Transaction } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { acquireAdvancedMapDatasetTransactionLocks } from '@/infra/database/user/advisory-locks.js';

import {
  createForbiddenError,
  createInvalidInputError,
  createNotFoundError,
  createProviderError,
  createSnapshotLimitReachedError,
  type AdvancedMapAnalyticsError,
} from '../../core/errors.js';

import type {
  AdvancedMapAnalyticsRepository,
  AppendSnapshotParams,
  CreateMapParams,
  UpdateMapParams,
} from '../../core/ports.js';
import type {
  AdvancedMapAnalyticsMap,
  AdvancedMapAnalyticsPublicView,
  AdvancedMapAnalyticsSnapshotDetail,
  AdvancedMapAnalyticsSnapshotDocument,
  AdvancedMapAnalyticsSnapshotSummary,
} from '../../core/types.js';
import type { UserDatabase, UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

export interface AdvancedMapAnalyticsRepoOptions {
  db: UserDbClient;
  logger: Logger;
}

type UserDbConnection = UserDbClient | Transaction<UserDatabase>;
const PUBLIC_MAP_WRITE_FORBIDDEN_MESSAGE =
  'You do not have permission to manage public advanced maps';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSnapshotDocument(value: unknown): value is AdvancedMapAnalyticsSnapshotDocument {
  if (!isRecord(value)) {
    return false;
  }

  const title = value['title'];
  const description = value['description'];
  const state = value['state'];
  const savedAt = value['savedAt'];

  if (typeof title !== 'string' || typeof savedAt !== 'string') {
    return false;
  }

  if (description !== null && typeof description !== 'string') {
    return false;
  }

  return isRecord(state);
}

function toSnapshotDocument(value: unknown): AdvancedMapAnalyticsSnapshotDocument | null {
  return isSnapshotDocument(value) ? value : null;
}

interface UploadedDatasetSnapshotReferences {
  datasetIds: string[];
  datasetPublicIds: string[];
}

function extractUploadedDatasetReferencesFromSnapshot(
  snapshot: unknown
): UploadedDatasetSnapshotReferences {
  const document = toSnapshotDocument(snapshot);
  if (document === null) {
    return {
      datasetIds: [],
      datasetPublicIds: [],
    };
  }

  const rawSeries = document.state['series'];
  if (!Array.isArray(rawSeries)) {
    return {
      datasetIds: [],
      datasetPublicIds: [],
    };
  }

  const datasetIds = new Set<string>();
  const datasetPublicIds = new Set<string>();

  for (const series of rawSeries) {
    if (!isRecord(series) || series['type'] !== 'uploaded-map-dataset') {
      continue;
    }

    const datasetId = series['datasetId'];
    if (typeof datasetId === 'string') {
      const trimmed = datasetId.trim();
      if (trimmed !== '') {
        datasetIds.add(trimmed);
      }
    }

    const datasetPublicId = series['datasetPublicId'];
    if (typeof datasetPublicId === 'string') {
      const trimmedPublicId = datasetPublicId.trim();
      if (trimmedPublicId !== '') {
        datasetPublicIds.add(trimmedPublicId);
      }
    }
  }

  return {
    datasetIds: Array.from(datasetIds),
    datasetPublicIds: Array.from(datasetPublicIds),
  };
}

async function applyDatasetReferenceDelta(
  db: UserDbConnection,
  removedDatasetIds: string[],
  addedDatasetIds: string[]
): Promise<void> {
  const decrementIds = removedDatasetIds.filter(
    (datasetId) => !addedDatasetIds.includes(datasetId)
  );
  const incrementIds = addedDatasetIds.filter(
    (datasetId) => !removedDatasetIds.includes(datasetId)
  );

  if (decrementIds.length > 0) {
    await db
      .updateTable('advancedmapdatasets')
      .set({
        reference_count: sql<number>`GREATEST(reference_count - 1, 0)`,
      })
      .where('id', 'in', decrementIds)
      .execute();
  }

  if (incrementIds.length > 0) {
    await db
      .updateTable('advancedmapdatasets')
      .set({
        reference_count: sql<number>`reference_count + 1`,
      })
      .where('id', 'in', incrementIds)
      .execute();
  }
}

function normalizeDatasetIds(datasetIds: readonly string[]): string[] {
  return Array.from(
    new Set(datasetIds.map((datasetId) => datasetId.trim()).filter((datasetId) => datasetId !== ''))
  ).sort((left, right) => left.localeCompare(right));
}

function normalizeDatasetPublicIds(datasetPublicIds: readonly string[]): string[] {
  return Array.from(
    new Set(
      datasetPublicIds
        .map((datasetPublicId) => datasetPublicId.trim())
        .filter((datasetPublicId) => datasetPublicId !== '')
    )
  ).sort((left, right) => left.localeCompare(right));
}

interface DatasetAccessRow {
  id: string;
  public_id: string;
  user_id: string;
  visibility: 'private' | 'unlisted' | 'public';
}

async function resolveUploadedDatasetReferenceIdsForLocking(
  db: UserDbConnection,
  references: UploadedDatasetSnapshotReferences
): Promise<string[]> {
  const datasetIds = normalizeDatasetIds(references.datasetIds);
  const datasetPublicIds = normalizeDatasetPublicIds(references.datasetPublicIds);

  if (datasetPublicIds.length === 0) {
    return datasetIds;
  }

  const rows = await db
    .selectFrom('advancedmapdatasets')
    .select(['id'])
    .where('deleted_at', 'is', null)
    .where('public_id', 'in', datasetPublicIds)
    .execute();

  return normalizeDatasetIds([...datasetIds, ...rows.map((row) => row.id)]);
}

async function validateUploadedDatasetAccessForMapWrite(
  db: UserDbConnection,
  input: {
    userId: string;
    references: UploadedDatasetSnapshotReferences;
    requireShareable: boolean;
  }
): Promise<Result<string[], AdvancedMapAnalyticsError>> {
  // This recheck runs inside the same transaction-scoped dataset lock boundary
  // that save/publish operations use. See:
  // docs/specs/specs-202604091600-advanced-map-dataset-consistency-boundary.md
  const datasetIds = normalizeDatasetIds(input.references.datasetIds);
  const datasetPublicIds = normalizeDatasetPublicIds(input.references.datasetPublicIds);
  if (datasetIds.length === 0 && datasetPublicIds.length === 0) {
    return ok([]);
  }

  const rows = await db
    .selectFrom('advancedmapdatasets')
    .select(['id', 'public_id', 'user_id', 'visibility'])
    .where('deleted_at', 'is', null)
    .where((eb) =>
      eb.or([
        ...(datasetIds.length > 0 ? [eb('id', 'in', datasetIds)] : []),
        ...(datasetPublicIds.length > 0 ? [eb('public_id', 'in', datasetPublicIds)] : []),
      ])
    )
    .forUpdate()
    .execute();

  const rowById = new Map<string, DatasetAccessRow>();
  const rowByPublicId = new Map<string, DatasetAccessRow>();
  for (const row of rows) {
    const datasetRow = row;
    rowById.set(datasetRow.id, datasetRow);
    rowByPublicId.set(datasetRow.public_id, datasetRow);
  }

  const resolvedDatasetIds: string[] = [];
  for (const datasetId of datasetIds) {
    const row = rowById.get(datasetId);
    if (row === undefined) {
      return err(createInvalidInputError('Uploaded map dataset not found or not accessible'));
    }

    const isAccessible =
      row.user_id === input.userId || row.visibility === 'public' || row.visibility === 'unlisted';
    if (!isAccessible) {
      return err(createInvalidInputError('Uploaded map dataset not found or not accessible'));
    }

    if (input.requireShareable && row.visibility === 'private') {
      return err(
        createInvalidInputError(
          'Public maps can reference only unlisted or public uploaded datasets'
        )
      );
    }

    resolvedDatasetIds.push(row.id);
  }

  for (const datasetPublicId of datasetPublicIds) {
    const row = rowByPublicId.get(datasetPublicId);
    if (row === undefined) {
      return err(createInvalidInputError('Uploaded map dataset not found or not accessible'));
    }

    const isAccessible =
      row.user_id === input.userId || row.visibility === 'public' || row.visibility === 'unlisted';
    if (!isAccessible) {
      return err(createInvalidInputError('Uploaded map dataset not found or not accessible'));
    }

    if (input.requireShareable && row.visibility === 'private') {
      return err(
        createInvalidInputError(
          'Public maps can reference only unlisted or public uploaded datasets'
        )
      );
    }

    resolvedDatasetIds.push(row.id);
  }

  return ok(normalizeDatasetIds(resolvedDatasetIds));
}

function toDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string') {
    return new Date(value);
  }

  return new Date(String(value));
}

interface MapRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  visibility: 'private' | 'public';
  public_id: string | null;
  last_snapshot: unknown;
  last_snapshot_id: string | null;
  snapshot_count: number;
  public_view_count: number;
  created_at: unknown;
  updated_at: unknown;
}

interface SnapshotRow {
  id: string;
  map_id: string;
  title: string;
  description: string | null;
  snapshot: unknown;
  created_at: unknown;
}

function mapMapRow(row: MapRow): AdvancedMapAnalyticsMap {
  return {
    mapId: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    publicId: row.public_id,
    lastSnapshotId: row.last_snapshot_id,
    lastSnapshot: toSnapshotDocument(row.last_snapshot),
    snapshotCount: row.snapshot_count,
    viewCount: row.public_view_count,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapSnapshotSummaryRow(
  row: Pick<SnapshotRow, 'id' | 'map_id' | 'created_at' | 'title' | 'description'>
): AdvancedMapAnalyticsSnapshotSummary {
  return {
    snapshotId: row.id,
    mapId: row.map_id,
    title: row.title,
    description: row.description,
    createdAt: toDate(row.created_at),
  };
}

function mapSnapshotDetailRow(row: SnapshotRow): AdvancedMapAnalyticsSnapshotDetail | null {
  const snapshot = toSnapshotDocument(row.snapshot);
  if (snapshot === null) {
    return null;
  }

  return {
    snapshotId: row.id,
    mapId: row.map_id,
    title: row.title,
    description: row.description,
    createdAt: toDate(row.created_at),
    snapshot,
  };
}

class KyselyAdvancedMapAnalyticsRepo implements AdvancedMapAnalyticsRepository {
  private readonly db: UserDbClient;
  private readonly log: Logger;

  constructor(options: AdvancedMapAnalyticsRepoOptions) {
    this.db = options.db;
    this.log = options.logger.child({ module: 'advanced-map-analytics-repo' });
  }

  async createMap(
    input: CreateMapParams
  ): Promise<Result<AdvancedMapAnalyticsMap, AdvancedMapAnalyticsError>> {
    try {
      const inserted = await this.db
        .insertInto('advancedmapanalyticsmaps')
        .values({
          id: input.mapId,
          user_id: input.userId,
          title: input.title,
          description: input.description,
          visibility: input.visibility,
          public_id: input.publicId,
          last_snapshot: null,
          last_snapshot_id: null,
          snapshot_count: 0,
          public_view_count: 0,
          updated_at: new Date(),
        } as never)
        .returningAll()
        .executeTakeFirst();

      if (inserted === undefined) {
        return err(createProviderError('Failed to create map'));
      }

      return ok(mapMapRow(inserted as unknown as MapRow));
    } catch (error) {
      this.log.error(
        { err: error, userId: input.userId },
        'Failed to create advanced map analytics map'
      );
      return err(createProviderError('Failed to create map', error));
    }
  }

  async getMapForUser(
    mapId: string,
    userId: string
  ): Promise<Result<AdvancedMapAnalyticsMap | null, AdvancedMapAnalyticsError>> {
    try {
      const row = await this.db
        .selectFrom('advancedmapanalyticsmaps')
        .selectAll()
        .where('id', '=', mapId)
        .where('user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      return ok(mapMapRow(row as unknown as MapRow));
    } catch (error) {
      this.log.error({ err: error, mapId, userId }, 'Failed to get map for user');
      return err(createProviderError('Failed to get map', error));
    }
  }

  async listMapsForUser(
    userId: string
  ): Promise<Result<AdvancedMapAnalyticsMap[], AdvancedMapAnalyticsError>> {
    try {
      const rows = await this.db
        .selectFrom('advancedmapanalyticsmaps')
        .selectAll()
        .where('user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .orderBy('updated_at', 'desc')
        .execute();

      return ok(rows.map((row) => mapMapRow(row as unknown as MapRow)));
    } catch (error) {
      this.log.error({ err: error, userId }, 'Failed to list user maps');
      return err(createProviderError('Failed to list maps', error));
    }
  }

  async updateMap(
    input: UpdateMapParams
  ): Promise<Result<AdvancedMapAnalyticsMap | null, AdvancedMapAnalyticsError>> {
    try {
      const txResult = await this.db.transaction().execute(async (trx) => {
        const mapRow = await trx
          .selectFrom('advancedmapanalyticsmaps')
          .selectAll()
          .where('id', '=', input.mapId)
          .where('user_id', '=', input.userId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();

        if (mapRow === undefined) {
          return ok<AdvancedMapAnalyticsMap | null, AdvancedMapAnalyticsError>(null);
        }

        if (
          !input.allowPublicWrite &&
          (mapRow.visibility === 'public' || input.visibility === 'public')
        ) {
          return err(createForbiddenError(PUBLIC_MAP_WRITE_FORBIDDEN_MESSAGE));
        }

        if (input.visibility === 'public') {
          const referencedDatasetRefs = extractUploadedDatasetReferencesFromSnapshot(
            mapRow.last_snapshot
          );
          const referencedDatasetIds = await resolveUploadedDatasetReferenceIdsForLocking(
            trx,
            referencedDatasetRefs
          );
          await acquireAdvancedMapDatasetTransactionLocks(trx, referencedDatasetIds);

          const datasetValidationResult = await validateUploadedDatasetAccessForMapWrite(trx, {
            userId: input.userId,
            references: referencedDatasetRefs,
            requireShareable: true,
          });
          if (datasetValidationResult.isErr()) {
            return err(datasetValidationResult.error);
          }
        }

        const updated = await trx
          .updateTable('advancedmapanalyticsmaps')
          .set({
            title: input.title,
            description: input.description,
            visibility: input.visibility,
            public_id: input.publicId,
            updated_at: new Date(),
          } as never)
          .where('id', '=', input.mapId)
          .where('user_id', '=', input.userId)
          .where('deleted_at', 'is', null)
          .returningAll()
          .executeTakeFirst();

        if (updated === undefined) {
          return ok<AdvancedMapAnalyticsMap | null, AdvancedMapAnalyticsError>(null);
        }

        return ok(mapMapRow(updated as unknown as MapRow));
      });

      return txResult;
    } catch (error) {
      this.log.error(
        { err: error, mapId: input.mapId, userId: input.userId },
        'Failed to update map'
      );
      return err(createProviderError('Failed to update map', error));
    }
  }

  async softDeleteMap(
    mapId: string,
    userId: string,
    allowPublicWrite: boolean
  ): Promise<Result<boolean, AdvancedMapAnalyticsError>> {
    try {
      const txResult = await this.db.transaction().execute(async (trx) => {
        const mapRow = await trx
          .selectFrom('advancedmapanalyticsmaps')
          .selectAll()
          .where('id', '=', mapId)
          .where('user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();

        if (mapRow === undefined) {
          return ok<boolean, AdvancedMapAnalyticsError>(false);
        }

        if (!allowPublicWrite && mapRow.visibility === 'public') {
          return err(createForbiddenError(PUBLIC_MAP_WRITE_FORBIDDEN_MESSAGE));
        }

        const now = new Date();
        await trx
          .updateTable('advancedmapanalyticsmaps')
          .set({
            deleted_at: now,
            updated_at: now,
          } as never)
          .where('id', '=', mapId)
          .where('user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .execute();

        const removedDatasetRefs = extractUploadedDatasetReferencesFromSnapshot(
          mapRow.last_snapshot
        );
        const removedDatasetIds = await resolveUploadedDatasetReferenceIdsForLocking(
          trx,
          removedDatasetRefs
        );
        await applyDatasetReferenceDelta(trx, removedDatasetIds, []);
        return ok<boolean, AdvancedMapAnalyticsError>(true);
      });

      return txResult;
    } catch (error) {
      this.log.error({ err: error, mapId, userId }, 'Failed to soft delete map');
      return err(createProviderError('Failed to delete map', error));
    }
  }

  async appendSnapshot(
    input: AppendSnapshotParams
  ): Promise<
    Result<
      { map: AdvancedMapAnalyticsMap; snapshot: AdvancedMapAnalyticsSnapshotDetail },
      AdvancedMapAnalyticsError
    >
  > {
    try {
      const txResult = await this.db.transaction().execute(async (trx) => {
        const mapRow = await trx
          .selectFrom('advancedmapanalyticsmaps')
          .selectAll()
          .where('id', '=', input.mapId)
          .where('user_id', '=', input.userId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();

        if (mapRow === undefined) {
          return err(createNotFoundError('Map not found'));
        }

        if (mapRow.snapshot_count >= input.snapshotCap) {
          return err(createSnapshotLimitReachedError(input.snapshotCap));
        }

        if (
          !input.allowPublicWrite &&
          (mapRow.visibility === 'public' || input.nextVisibility === 'public')
        ) {
          return err(createForbiddenError(PUBLIC_MAP_WRITE_FORBIDDEN_MESSAGE));
        }

        const now = new Date();
        const snapshotJson = JSON.stringify(input.snapshotDocument);
        const removedDatasetRefs = extractUploadedDatasetReferencesFromSnapshot(
          mapRow.last_snapshot
        );
        const addedDatasetRefs = extractUploadedDatasetReferencesFromSnapshot(
          input.snapshotDocument
        );
        const removedDatasetIds = await resolveUploadedDatasetReferenceIdsForLocking(
          trx,
          removedDatasetRefs
        );
        const addedDatasetIdsForLocking = await resolveUploadedDatasetReferenceIdsForLocking(
          trx,
          addedDatasetRefs
        );
        const lockedDatasetIds = normalizeDatasetIds([
          ...removedDatasetIds,
          ...addedDatasetIdsForLocking,
        ]);

        await acquireAdvancedMapDatasetTransactionLocks(trx, lockedDatasetIds);

        const datasetValidationResult = await validateUploadedDatasetAccessForMapWrite(trx, {
          userId: input.userId,
          references: addedDatasetRefs,
          requireShareable: input.nextVisibility === 'public',
        });
        if (datasetValidationResult.isErr()) {
          return err(datasetValidationResult.error);
        }
        const addedDatasetIds = datasetValidationResult.value;

        const updatedMap = await trx
          .updateTable('advancedmapanalyticsmaps')
          .set({
            title: input.nextMapTitle,
            description: input.nextMapDescription,
            visibility: input.nextVisibility,
            public_id: input.nextPublicId,
            last_snapshot_id: input.snapshotId,
            last_snapshot: sql`${snapshotJson}::jsonb`,
            snapshot_count: sql<number>`snapshot_count + 1`,
            updated_at: now,
          } as never)
          .where('id', '=', input.mapId)
          .where('user_id', '=', input.userId)
          .where('deleted_at', 'is', null)
          .returningAll()
          .executeTakeFirst();

        if (updatedMap === undefined) {
          return err(createNotFoundError('Map not found'));
        }

        const insertedSnapshot = await trx
          .insertInto('advancedmapanalyticssnapshots')
          .values({
            id: input.snapshotId,
            map_id: input.mapId,
            title: input.snapshotTitle,
            description: input.snapshotDescription,
            snapshot: sql`${snapshotJson}::jsonb`,
          } as never)
          .returningAll()
          .executeTakeFirst();

        if (insertedSnapshot === undefined) {
          throw new Error('Failed to insert snapshot row');
        }

        const snapshotDetail = mapSnapshotDetailRow(insertedSnapshot);
        if (snapshotDetail === null) {
          throw new Error('Snapshot payload validation failed after insert');
        }

        await applyDatasetReferenceDelta(trx, removedDatasetIds, addedDatasetIds);

        return ok({
          map: mapMapRow(updatedMap as unknown as MapRow),
          snapshot: snapshotDetail,
        });
      });

      return txResult;
    } catch (error) {
      this.log.error(
        { err: error, mapId: input.mapId, userId: input.userId },
        'Failed to append snapshot'
      );
      return err(createProviderError('Failed to save snapshot', error));
    }
  }

  async listSnapshotsForMap(
    mapId: string
  ): Promise<Result<AdvancedMapAnalyticsSnapshotSummary[], AdvancedMapAnalyticsError>> {
    try {
      const rows = await this.db
        .selectFrom('advancedmapanalyticssnapshots')
        .select(['id', 'map_id', 'created_at', 'title', 'description'])
        .where('map_id', '=', mapId)
        .orderBy('created_at', 'desc')
        .execute();

      return ok(rows.map((row) => mapSnapshotSummaryRow(row as unknown as SnapshotRow)));
    } catch (error) {
      this.log.error({ err: error, mapId }, 'Failed to list snapshots');
      return err(createProviderError('Failed to list snapshots', error));
    }
  }

  async getSnapshotById(
    mapId: string,
    snapshotId: string
  ): Promise<Result<AdvancedMapAnalyticsSnapshotDetail | null, AdvancedMapAnalyticsError>> {
    try {
      const row = await this.db
        .selectFrom('advancedmapanalyticssnapshots')
        .selectAll()
        .where('map_id', '=', mapId)
        .where('id', '=', snapshotId)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      const snapshotDetail = mapSnapshotDetailRow(row);
      if (snapshotDetail === null) {
        return err(createProviderError('Stored snapshot payload is invalid'));
      }

      return ok(snapshotDetail);
    } catch (error) {
      this.log.error({ err: error, mapId, snapshotId }, 'Failed to get snapshot by id');
      return err(createProviderError('Failed to get snapshot', error));
    }
  }

  async getPublicViewByPublicId(
    publicId: string
  ): Promise<Result<AdvancedMapAnalyticsPublicView | null, AdvancedMapAnalyticsError>> {
    try {
      const row = await this.db
        .selectFrom('advancedmapanalyticsmaps')
        .selectAll()
        .where('public_id', '=', publicId)
        .where('visibility', '=', 'public')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      if (row.last_snapshot_id === null || row.public_id === null) {
        return ok(null);
      }

      const snapshot = toSnapshotDocument(row.last_snapshot);
      if (snapshot === null) {
        return ok(null);
      }

      return ok({
        mapId: row.id,
        publicId: row.public_id,
        title: row.title,
        description: row.description,
        snapshotId: row.last_snapshot_id,
        snapshot,
        updatedAt: toDate(row.updated_at),
      });
    } catch (error) {
      this.log.error({ err: error, publicId }, 'Failed to get public map view');
      return err(createProviderError('Failed to get public map', error));
    }
  }

  async incrementPublicViewCount(mapId: string): Promise<Result<void, AdvancedMapAnalyticsError>> {
    try {
      await this.db
        .updateTable('advancedmapanalyticsmaps')
        .set({
          public_view_count: sql<number>`public_view_count + 1`,
        } as never)
        .where('id', '=', mapId)
        .where('visibility', '=', 'public')
        .where('deleted_at', 'is', null)
        .execute();

      return ok(undefined);
    } catch (error) {
      this.log.error({ err: error, mapId }, 'Failed to increment public view count');
      return err(createProviderError('Failed to increment public view count', error));
    }
  }
}

export const makeAdvancedMapAnalyticsRepo = (
  options: AdvancedMapAnalyticsRepoOptions
): AdvancedMapAnalyticsRepository => {
  return new KyselyAdvancedMapAnalyticsRepo(options);
};
