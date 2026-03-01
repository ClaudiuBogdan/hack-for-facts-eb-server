/**
 * Advanced Map Analytics Repository - Kysely implementation
 */

import { sql } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
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
import type { UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

export interface AdvancedMapAnalyticsRepoOptions {
  db: UserDbClient;
  logger: Logger;
}

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
      const updated = await this.db
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
        return ok(null);
      }

      return ok(mapMapRow(updated as unknown as MapRow));
    } catch (error) {
      this.log.error(
        { err: error, mapId: input.mapId, userId: input.userId },
        'Failed to update map'
      );
      return err(createProviderError('Failed to update map', error));
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

        const now = new Date();
        const snapshotJson = JSON.stringify(input.snapshotDocument);

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

        const snapshotDetail = mapSnapshotDetailRow(insertedSnapshot as unknown as SnapshotRow);
        if (snapshotDetail === null) {
          throw new Error('Snapshot payload validation failed after insert');
        }

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

      const snapshotDetail = mapSnapshotDetailRow(row as unknown as SnapshotRow);
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
}

export const makeAdvancedMapAnalyticsRepo = (
  options: AdvancedMapAnalyticsRepoOptions
): AdvancedMapAnalyticsRepository => {
  return new KyselyAdvancedMapAnalyticsRepo(options);
};
