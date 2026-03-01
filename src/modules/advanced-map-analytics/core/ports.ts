/**
 * Advanced Map Analytics Module - Core Ports
 */

import type { AdvancedMapAnalyticsError } from './errors.js';
import type {
  AdvancedMapAnalyticsMap,
  AdvancedMapAnalyticsPublicView,
  AdvancedMapAnalyticsSnapshotDetail,
  AdvancedMapAnalyticsSnapshotDocument,
  AdvancedMapAnalyticsSnapshotSummary,
  AdvancedMapAnalyticsVisibility,
} from './types.js';
import type { Result } from 'neverthrow';

export interface CreateMapParams {
  mapId: string;
  userId: string;
  title: string;
  description: string | null;
  visibility: AdvancedMapAnalyticsVisibility;
  publicId: string | null;
}

export interface UpdateMapParams {
  mapId: string;
  userId: string;
  title: string;
  description: string | null;
  visibility: AdvancedMapAnalyticsVisibility;
  publicId: string | null;
}

export interface AppendSnapshotParams {
  mapId: string;
  userId: string;
  snapshotId: string;
  snapshotTitle: string;
  snapshotDescription: string | null;
  snapshotDocument: AdvancedMapAnalyticsSnapshotDocument;
  nextMapTitle: string;
  nextMapDescription: string | null;
  nextVisibility: AdvancedMapAnalyticsVisibility;
  nextPublicId: string | null;
  snapshotCap: number;
}

export interface AdvancedMapAnalyticsRepository {
  createMap(
    input: CreateMapParams
  ): Promise<Result<AdvancedMapAnalyticsMap, AdvancedMapAnalyticsError>>;

  getMapForUser(
    mapId: string,
    userId: string
  ): Promise<Result<AdvancedMapAnalyticsMap | null, AdvancedMapAnalyticsError>>;

  listMapsForUser(
    userId: string
  ): Promise<Result<AdvancedMapAnalyticsMap[], AdvancedMapAnalyticsError>>;

  updateMap(
    input: UpdateMapParams
  ): Promise<Result<AdvancedMapAnalyticsMap | null, AdvancedMapAnalyticsError>>;

  appendSnapshot(
    input: AppendSnapshotParams
  ): Promise<
    Result<
      { map: AdvancedMapAnalyticsMap; snapshot: AdvancedMapAnalyticsSnapshotDetail },
      AdvancedMapAnalyticsError
    >
  >;

  listSnapshotsForMap(
    mapId: string
  ): Promise<Result<AdvancedMapAnalyticsSnapshotSummary[], AdvancedMapAnalyticsError>>;

  getSnapshotById(
    mapId: string,
    snapshotId: string
  ): Promise<Result<AdvancedMapAnalyticsSnapshotDetail | null, AdvancedMapAnalyticsError>>;

  getPublicViewByPublicId(
    publicId: string
  ): Promise<Result<AdvancedMapAnalyticsPublicView | null, AdvancedMapAnalyticsError>>;
}
