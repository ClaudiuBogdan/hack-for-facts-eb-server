import type { AdminEventError } from './errors.js';
import type { TSchema } from '@sinclair/typebox';
import type { Result } from 'neverthrow';

export type AdminEventType = string;

export interface AdminEventJobEnvelope {
  eventType: AdminEventType;
  schemaVersion: number;
  payload: Record<string, unknown>;
}

export type AdminEventQueueJobState = 'waiting' | 'prioritized';

export interface AdminEventPendingJob {
  jobId: string;
  state: AdminEventQueueJobState;
  timestamp: number;
  envelope: AdminEventJobEnvelope;
}

export interface AdminEventBaseExportBundle<TPayload extends Record<string, unknown>, TContext> {
  jobId: string;
  eventType: AdminEventType;
  schemaVersion: number;
  payload: TPayload;
  context: TContext;
  freshness: Record<string, unknown>;
  instructions?: readonly string[];
}

export interface AdminEventExportBundle<
  TPayload extends Record<string, unknown>,
  TContext,
> extends AdminEventBaseExportBundle<TPayload, TContext> {
  exportMetadata: {
    exportId: string;
    exportedAt: string;
    workspace: string;
    environment?: string;
  };
  outcomeSchema: Record<string, unknown>;
}

export interface AdminEventExportJobRecord {
  jobId: string;
  eventType: AdminEventType;
  bundleDir: string;
}

export interface AdminEventExportManifest {
  exportId: string;
  exportedAt: string;
  workspace: string;
  jobs: readonly AdminEventExportJobRecord[];
  skippedJobs: readonly {
    jobId: string;
    eventType: AdminEventType;
    reason: string;
  }[];
}

export type AdminEventStateClassification =
  | 'actionable'
  | 'already_applied'
  | 'stale'
  | 'not_actionable';

export interface AdminEventApplyResult {
  status: 'applied' | 'already_applied' | 'stale' | 'not_actionable';
  jobId: string;
  eventType: AdminEventType;
  queueJobRemoved: boolean;
  queueCleanupPending: boolean;
  message: string;
}

export interface AdminEventDefinition<
  TPayload extends Record<string, unknown>,
  TContext,
  TOutcome extends Record<string, unknown>,
> {
  eventType: AdminEventType;
  schemaVersion: number;
  payloadSchema: TSchema;
  outcomeSchema: TSchema;
  getJobId(payload: TPayload): string;
  scanPending(): Promise<Result<readonly TPayload[], AdminEventError>>;
  loadContext(payload: TPayload): Promise<Result<TContext | null, AdminEventError>>;
  buildExportBundle(input: {
    jobId: string;
    payload: TPayload;
    context: TContext;
  }): AdminEventBaseExportBundle<TPayload, TContext>;
  classifyState(input: {
    payload: TPayload;
    context: TContext | null;
    outcome?: TOutcome;
    exportBundle?: AdminEventExportBundle<TPayload, TContext>;
  }): AdminEventStateClassification;
  applyOutcome(input: {
    payload: TPayload;
    context: TContext;
    outcome: TOutcome;
  }): Promise<Result<void, AdminEventError>>;
}

export type AnyAdminEventDefinition = AdminEventDefinition<
  Record<string, unknown>,
  unknown,
  Record<string, unknown>
>;
