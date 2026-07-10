import { type IdGenerator } from '@/common/ports/id-generator.js';

export interface RecordIdentity {
  ownerId: string;
  category: string;
  logicalKey: string;
}
export type ActorContext =
  | { type: 'owner' }
  | { type: 'system'; source: string }
  | { type: 'admin'; actorId: string; reason: string };
export type RecordStatus = 'active' | 'deleted';
export interface RecordTarget {
  targetType: string;
  targetId: string;
}
export interface CurrentRecord {
  recordId: string;
  identity: RecordIdentity;
  target: RecordTarget | null;
  schemaVersion: number;
  schemaHash: string;
  revision: number;
  status: RecordStatus;
  payload: Record<string, unknown> | null;
  annotations: Record<string, Record<string, unknown>> | null;
  lastEventSeq: string;
  lastEventId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  privacyRedactedAt: Date | null;
}
export interface RecordView {
  recordId: string;
  category: string;
  logicalKey: string;
  target: RecordTarget | null;
  schemaVersion: number;
  revision: number;
  status: RecordStatus;
  payload: Record<string, unknown> | null;
  annotations: Record<string, Record<string, unknown>> | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface MutationResponse {
  record: RecordView;
  eventId: string;
  eventSeq: string;
  recordedAt: string;
  replayed: boolean;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface AfterImage {
  status: RecordStatus;
  payload: Record<string, unknown> | null;
  annotations: Record<string, Record<string, unknown>> | null;
  schemaVersion: number;
  schemaHash: string;
}
export type MutationOperation =
  | 'create'
  | 'replace'
  | 'annotate'
  | 'delete'
  | 'restore'
  | 'migrate';
export type MutationScope = 'payload' | 'annotation';
export interface ReceiptClaim {
  requesterId: string;
  idempotencyKeyHash: string;
  canonicalRequestHash: string;
}
export interface PlannedMutation {
  operation: MutationOperation;
  scope: MutationScope;
  annotationNamespace: string | null;
  identity: RecordIdentity;
  recordId: string;
  eventId: string;
  target: RecordTarget | null;
  expectedRevision: number;
  nextRevision: number;
  afterImage: AfterImage;
  actor: ActorContext;
  clientOccurredAt: Date | null;
  receipt: ReceiptClaim;
  quota: { maxRecordsInCategory: number } | null;
}
interface MutationCommandBase {
  identity: RecordIdentity;
  expectedRevision: number;
  clientOccurredAt: Date | null;
  receipt: ReceiptClaim;
}
export interface ReplaceCommand extends MutationCommandBase {
  schemaVersion: number;
  payload: Record<string, unknown>;
  target: RecordTarget | null;
}
export interface AnnotateCommand extends MutationCommandBase {
  namespace: string;
  annotation: Record<string, unknown>;
}
export type DeleteCommand = MutationCommandBase;
export interface RestoreCommand extends MutationCommandBase {
  schemaVersion: number;
  payload: Record<string, unknown>;
  target: RecordTarget | null;
}
export interface MigrateCommand extends MutationCommandBase {
  schemaVersion: number;
  payload: Record<string, unknown>;
}
export interface PlanContext {
  ids: IdGenerator;
  requesterId: string;
  actor: ActorContext;
}
export type EventOperation = MutationOperation | 'legacy_import';
export type EventProvenance = 'live' | 'legacy';
export type EventIntegrity = 'verified' | 'unverified';
/** Persisted ledger event as reads return it — the after-image plus attribution. */
export interface UserDataEvent {
  eventSeq: string;
  eventId: string;
  recordId: string;
  identity: RecordIdentity;
  target: RecordTarget | null;
  revision: number;
  operation: EventOperation;
  scope: MutationScope;
  annotationNamespace: string | null;
  schemaVersion: number;
  schemaHash: string;
  payload: Record<string, unknown> | null;
  annotations: Record<string, Record<string, unknown>> | null;
  actor: ActorContext;
  provenance: EventProvenance;
  integrity: EventIntegrity;
  recordedAt: Date;
  clientOccurredAt: Date | null;
  privacyRedactedAt: Date | null;
}
export interface AdminRecordFilters {
  status?: RecordStatus;
  target?: RecordTarget;
  createdAtFrom?: Date;
  createdAtTo?: Date;
  query?: Readonly<Record<string, unknown>>;
}
export interface ResolvedRedactors {
  payloadByCategory: Readonly<
    Record<string, (payload: Record<string, unknown>) => Record<string, unknown>>
  >;
  annotationsByCategory: Readonly<
    Record<
      string,
      Readonly<Record<string, (annotation: Record<string, unknown>) => Record<string, unknown>>>
    >
  >;
}
