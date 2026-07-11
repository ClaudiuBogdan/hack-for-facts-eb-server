import { type Result } from 'neverthrow';

import { type Clock } from '@/common/ports/clock.js';
import { type IdGenerator } from '@/common/ports/id-generator.js';

import { type UserDataError } from './errors.js';
import { type SyncCursor } from './sync-cursor.js';
import {
  type AdminRecordFilters,
  type CurrentRecord,
  type Page,
  type PlannedMutation,
  type ReceiptClaim,
  type RecordIdentity,
  type RecordTarget,
  type ReconciliationReport,
  type ResolvedRedactors,
  type UserDataEvent,
} from './types.js';

export type { Clock, IdGenerator };
export type MutationOutcome =
  | { kind: 'committed'; result: MutationResultData }
  | { kind: 'replayed'; result: MutationResultData }
  | { kind: 'revisionConflict'; current: CurrentRecord }
  | { kind: 'idempotencyConflict' }
  | { kind: 'quotaExceeded'; limit: number };
export interface MutationResultData {
  record: CurrentRecord;
  eventId: string;
  eventSeq: string;
  recordedAt: Date;
}
export interface UserDataMutationPort {
  getForMutation(identity: RecordIdentity): Promise<Result<CurrentRecord | null, UserDataError>>;
  commit(plan: PlannedMutation): Promise<Result<MutationOutcome, UserDataError>>;
  probeReceipt(
    claim: ReceiptClaim
  ): Promise<Result<'absent' | 'match' | 'mismatch', UserDataError>>;
  deleteExpiredReceipts(now: Date): Promise<Result<number, UserDataError>>;
}
export interface SyncPage {
  items: CurrentRecord[];
  ownerHighWater: string;
}
export interface UserDataReadPort {
  findByKey(
    ownerId: string,
    category: string,
    logicalKey: string
  ): Promise<Result<CurrentRecord | null, UserDataError>>;
  findById(ownerId: string, recordId: string): Promise<Result<CurrentRecord | null, UserDataError>>;
  listByCategory(
    ownerId: string,
    category: string,
    page: { limit: number; cursor: string | null }
  ): Promise<Result<Page<CurrentRecord>, UserDataError>>;
  findByTarget(
    ownerId: string,
    category: string,
    target: RecordTarget
  ): Promise<Result<CurrentRecord[], UserDataError>>;
  syncSince(
    ownerId: string,
    cursor: SyncCursor,
    limit: number
  ): Promise<Result<SyncPage, UserDataError>>;
  historyByRecord(
    ownerId: string,
    recordId: string,
    page: { limit: number; beforeRevision: number | null }
  ): Promise<Result<Page<UserDataEvent>, UserDataError>>;
}
export interface UserDataAdminReadPort {
  adminListByCategory(
    category: string,
    filters: AdminRecordFilters,
    page: { limit: number; cursor: string | null }
  ): Promise<Result<Page<CurrentRecord>, UserDataError>>;
  adminHistoryByCategory(
    category: string,
    recordId: string,
    page: { limit: number; beforeRevision: number | null }
  ): Promise<Result<Page<UserDataEvent>, UserDataError>>;
}
export interface UserDataErasurePort {
  eraseOwner(input: {
    ownerId: string;
    anonymizedOwnerId: string;
    redactors: ResolvedRedactors;
    now: Date;
  }): Promise<Result<{ records: number; events: number; receipts: number }, UserDataError>>;
}
export interface UserDataReconciliationPort {
  findViolations(input: { limit: number }): Promise<Result<ReconciliationReport, UserDataError>>;
}
export interface MutationRateLimiterPort {
  consume(
    ownerId: string,
    category: string,
    limitPerMinute: number
  ): Promise<
    Result<{ allowed: true } | { allowed: false; retryAfterSeconds: number }, UserDataError>
  >;
}
