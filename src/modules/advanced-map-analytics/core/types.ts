/**
 * Advanced Map Analytics Module - Core Types
 */

export const ADVANCED_MAP_ANALYTICS_SNAPSHOT_CAP = 200;
export const ADVANCED_MAP_ANALYTICS_TITLE_MAX_LENGTH = 200;
export const ADVANCED_MAP_ANALYTICS_DESCRIPTION_MAX_LENGTH = 2000;

export type AdvancedMapAnalyticsVisibility = 'private' | 'public';

export interface AdvancedMapAnalyticsSnapshotDocument {
  title: string;
  description: string | null;
  state: Record<string, unknown>;
  savedAt: string;
}

export interface AdvancedMapAnalyticsMap {
  mapId: string;
  userId: string;
  title: string;
  description: string | null;
  visibility: AdvancedMapAnalyticsVisibility;
  publicId: string | null;
  lastSnapshotId: string | null;
  lastSnapshot: AdvancedMapAnalyticsSnapshotDocument | null;
  snapshotCount: number;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdvancedMapAnalyticsSnapshotSummary {
  snapshotId: string;
  mapId: string;
  createdAt: Date;
  title: string;
  description: string | null;
}

export interface AdvancedMapAnalyticsSnapshotDetail extends AdvancedMapAnalyticsSnapshotSummary {
  snapshot: AdvancedMapAnalyticsSnapshotDocument;
}

export interface AdvancedMapAnalyticsPublicView {
  mapId: string;
  publicId: string;
  title: string;
  description: string | null;
  snapshotId: string;
  snapshot: AdvancedMapAnalyticsSnapshotDocument;
  updatedAt: Date;
}

export interface CreateAdvancedMapAnalyticsMapInput {
  userId: string;
  title?: string;
  description?: string | null;
  visibility?: AdvancedMapAnalyticsVisibility;
}

export interface UpdateAdvancedMapAnalyticsMapInput {
  userId: string;
  mapId: string;
  title?: string;
  description?: string | null;
  visibility?: AdvancedMapAnalyticsVisibility;
}

export interface SaveAdvancedMapAnalyticsSnapshotInput {
  userId: string;
  mapId: string;
  state: Record<string, unknown>;
  title?: string;
  description?: string | null;
  mapPatch?: {
    title?: string;
    description?: string | null;
    visibility?: AdvancedMapAnalyticsVisibility;
  };
}
