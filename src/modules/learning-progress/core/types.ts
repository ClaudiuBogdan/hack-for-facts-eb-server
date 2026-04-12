/**
 * Learning Progress Module - Domain Types
 *
 * The server stores one row per user and per client-controlled record key.
 * It treats all synced state as generic interactive records.
 */

export const MAX_EVENTS_PER_REQUEST = 100;
export const SNAPSHOT_VERSION = 1;

export type LessonId = string;

export type InteractionScope =
  | { readonly type: 'global' }
  | { readonly type: 'entity'; readonly entityCui: string };

export type InteractionValue =
  | { readonly kind: 'choice'; readonly choice: { readonly selectedId: string | null } }
  | { readonly kind: 'text'; readonly text: { readonly value: string } }
  | { readonly kind: 'url'; readonly url: { readonly value: string } }
  | { readonly kind: 'number'; readonly number: { readonly value: number | null } }
  | { readonly kind: 'json'; readonly json: { readonly value: Readonly<Record<string, unknown>> } };

export type InteractionPhase = 'idle' | 'draft' | 'pending' | 'resolved' | 'failed';

export type InteractionOutcome = 'correct' | 'incorrect' | null;

export interface InteractionResult {
  readonly outcome: InteractionOutcome;
  readonly score?: number | null;
  readonly feedbackText?: string | null;
  readonly response?: Readonly<Record<string, unknown>> | null;
  readonly evaluatedAt?: string | null;
}

export type InteractionReviewStatus = 'pending' | 'approved' | 'rejected';
export type ReviewDecisionStatus = Exclude<InteractionReviewStatus, 'pending'>;
export type InteractionReviewSource =
  | 'campaign_admin_api'
  | 'learning_progress_admin_api'
  | 'user_event_worker';

export interface InteractionReview {
  /**
   * Server-owned review metadata for asynchronous validation workflows.
   *
   * Public client sync may submit interaction values, but it may not set or
   * overwrite this field. Review updates are performed through server-side
   * use cases so authoritativeness stays on the backend.
   */
  readonly status: InteractionReviewStatus;
  readonly reviewedAt: string | null;
  readonly feedbackText?: string | null;
  readonly reviewedByUserId?: string;
  readonly reviewSource?: InteractionReviewSource;
}

export type InteractiveDefinitionKind = 'quiz' | 'url' | 'text-input' | 'custom';

export type InteractionCompletionRule =
  | { readonly type: 'outcome'; readonly outcome: Exclude<InteractionOutcome, null> }
  | { readonly type: 'resolved' }
  | { readonly type: 'score-threshold'; readonly minScore: number }
  | { readonly type: 'component-flag'; readonly flag: string };

export interface InteractiveStateRecord {
  /**
   * Canonical interactive lifecycle envelope.
   *
   * See `docs/specs/specs-202603201356-learning-progress-generic-sync.md`
   * for the normative lifecycle state machine and field ownership rules.
   *
   * Summary:
   * - `idle` / `draft`: not yet submitted; `result` and `review` are absent.
   * - `pending`: submitted and waiting for async review; `submittedAt` is set,
   *   `result` remains null, and `review` is still absent.
   * - `resolved`: persisted success value. Shared client lifecycle helpers
   *   should interpret this as `passed`. Immediate-eval interactions use
   *   `result`; async-review interactions use `review.status = approved`.
   * - `failed`: persisted retry-needed failure value. Shared client lifecycle
   *   helpers should interpret this as `failed` for async-review interactions
   *   with `review.status = rejected`.
   */
  readonly key: string;
  readonly interactionId: string;
  readonly lessonId: LessonId;
  readonly kind: InteractiveDefinitionKind;
  readonly scope: InteractionScope;
  readonly completionRule: InteractionCompletionRule;
  readonly phase: InteractionPhase;
  readonly value: InteractionValue | null;
  readonly result: InteractionResult | null;
  /**
   * First-class review state for interactions that are submitted by the user
   * and later validated by the server. Kept separate from `result` so quiz
   * evaluation/scoring semantics stay generic and unaffected.
   */
  readonly review?: InteractionReview | null;
  readonly sourceUrl?: string;
  readonly updatedAt: string;
  readonly submittedAt?: string | null;
}

export type InteractiveAuditEvent =
  | {
      readonly id: string;
      readonly recordKey: string;
      readonly lessonId: LessonId;
      readonly interactionId: string;
      readonly type: 'submitted';
      readonly at: string;
      readonly actor: 'user';
      readonly value: InteractionValue;
    }
  | {
      readonly id: string;
      readonly recordKey: string;
      readonly lessonId: LessonId;
      readonly interactionId: string;
      readonly type: 'evaluated';
      readonly at: string;
      readonly actor: 'system' | 'admin';
      readonly actorUserId?: string;
      readonly actorPermission?: string;
      readonly actorSource?: InteractionReviewSource;
      readonly phase: 'resolved' | 'failed';
      readonly result: InteractionResult;
    };

export type StoredInteractiveAuditEvent = InteractiveAuditEvent & {
  readonly seq: string;
  readonly sourceClientEventId: string;
  readonly sourceClientId: string;
};

export interface LearningProgressSnapshot {
  readonly version: typeof SNAPSHOT_VERSION;
  readonly recordsByKey: Readonly<Record<string, InteractiveStateRecord>>;
  readonly lastUpdated: string | null;
}

export type LearningProgressEventType = 'interactive.updated' | 'progress.reset';

export interface LearningProgressEventBase {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly clientId: string;
  readonly type: LearningProgressEventType;
}

export type LearningInteractiveUpdatedEvent = LearningProgressEventBase & {
  readonly type: 'interactive.updated';
  readonly payload: {
    readonly record: InteractiveStateRecord;
    readonly auditEvents?: readonly InteractiveAuditEvent[];
  };
};

export type LearningProgressResetEvent = LearningProgressEventBase & {
  readonly type: 'progress.reset';
};

export type LearningProgressEvent = LearningInteractiveUpdatedEvent | LearningProgressResetEvent;

export interface GetProgressResponse {
  readonly snapshot: LearningProgressSnapshot;
  readonly events: readonly LearningInteractiveUpdatedEvent[];
  readonly cursor: string;
}

export interface SyncEventsRequest {
  readonly clientUpdatedAt: string;
  readonly events: readonly LearningProgressEvent[];
}

export interface LearningProgressRecordRow {
  readonly userId: string;
  readonly recordKey: string;
  readonly record: InteractiveStateRecord;
  readonly auditEvents: readonly StoredInteractiveAuditEvent[];
  readonly updatedSeq: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewDecision {
  readonly userId: string;
  readonly recordKey: string;
  readonly expectedUpdatedAt: string;
  readonly status: ReviewDecisionStatus;
  readonly feedbackText?: string;
  readonly approvalRiskAcknowledged?: boolean;
}

export interface ApprovedReviewSideEffectPlan {
  afterCommit(): Promise<void>;
}

export interface ReviewActorMetadata {
  readonly actor: 'system' | 'admin';
  readonly actorUserId?: string;
  readonly actorPermission?: string;
  readonly actorSource?: InteractionReviewSource;
}

export interface GetRecordsOptions {
  readonly recordKeyPrefix?: string;
}

export type CampaignAdminCampaignKey = 'funky';

export type CampaignAdminSubmissionPath =
  | 'request_platform'
  | 'send_yourself'
  | 'send_email'
  | 'download_text';

export type CampaignAdminInstitutionThreadPhase =
  | 'sending'
  | 'awaiting_reply'
  | 'reply_received_unreviewed'
  | 'manual_follow_up_needed'
  | 'resolved_positive'
  | 'resolved_negative'
  | 'closed_no_response'
  | 'failed';

export interface CampaignAdminListCursor {
  readonly updatedAt: string;
  readonly userId: string;
  readonly recordKey: string;
}

export interface CampaignAdminInstitutionThreadSummary {
  readonly threadId: string;
  readonly threadPhase: CampaignAdminInstitutionThreadPhase;
  readonly lastEmailAt: string | null;
  readonly lastReplyAt: string | null;
  readonly nextActionAt: string | null;
}

export interface CampaignAdminInteractionFilter {
  readonly interactionId: string;
  readonly submissionPath?: CampaignAdminSubmissionPath;
}

export interface CampaignAdminInteractionRow {
  readonly userId: string;
  readonly recordKey: string;
  readonly campaignKey: CampaignAdminCampaignKey;
  readonly record: InteractiveStateRecord;
  readonly auditEvents: readonly StoredInteractiveAuditEvent[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly threadSummary: CampaignAdminInstitutionThreadSummary | null;
}

export interface CampaignAdminReviewStatusCounts {
  readonly pending: number;
  readonly approved: number;
  readonly rejected: number;
  readonly notReviewed: number;
}

export interface CampaignAdminPhaseCounts {
  readonly idle: number;
  readonly draft: number;
  readonly pending: number;
  readonly resolved: number;
  readonly failed: number;
}

export interface CampaignAdminThreadPhaseCounts {
  readonly sending: number;
  readonly awaiting_reply: number;
  readonly reply_received_unreviewed: number;
  readonly manual_follow_up_needed: number;
  readonly resolved_positive: number;
  readonly resolved_negative: number;
  readonly closed_no_response: number;
  readonly failed: number;
  readonly none: number;
}

export interface CampaignAdminStats {
  readonly total: number;
  readonly riskFlagged: number;
  readonly withInstitutionThread: number;
  readonly reviewStatusCounts: CampaignAdminReviewStatusCounts;
  readonly phaseCounts: CampaignAdminPhaseCounts;
  readonly threadPhaseCounts: CampaignAdminThreadPhaseCounts;
}

export interface CampaignAdminStatsBase {
  readonly total: number;
  readonly withInstitutionThread: number;
  readonly reviewStatusCounts: CampaignAdminReviewStatusCounts;
  readonly phaseCounts: CampaignAdminPhaseCounts;
  readonly threadPhaseCounts: CampaignAdminThreadPhaseCounts;
}

export interface CampaignAdminRiskFlagCandidate {
  readonly interactionId: string;
  readonly entityCui: string | null;
  readonly institutionEmail: string | null;
  readonly threadPhase: CampaignAdminInstitutionThreadPhase | null;
  readonly count: number;
}

export interface ListCampaignAdminInteractionRowsInput {
  readonly campaignKey: CampaignAdminCampaignKey;
  readonly interactions: readonly CampaignAdminInteractionFilter[];
  readonly phase?: InteractionPhase;
  readonly reviewStatus?: InteractionReviewStatus;
  readonly submissionPath?: CampaignAdminSubmissionPath;
  readonly lessonId?: string;
  readonly entityCui?: string;
  readonly scopeType?: InteractionScope['type'];
  readonly payloadKind?: InteractionValue['kind'];
  readonly userId?: string;
  readonly recordKey?: string;
  readonly recordKeyPrefix?: string;
  readonly submittedAtFrom?: string;
  readonly submittedAtTo?: string;
  readonly updatedAtFrom?: string;
  readonly updatedAtTo?: string;
  readonly hasInstitutionThread?: boolean;
  readonly threadPhase?: CampaignAdminInstitutionThreadPhase;
  readonly limit: number;
  readonly cursor?: CampaignAdminListCursor;
}

export interface ListCampaignAdminInteractionRowsOutput {
  readonly rows: readonly CampaignAdminInteractionRow[];
  readonly hasMore: boolean;
  readonly nextCursor: CampaignAdminListCursor | null;
}

export interface GetCampaignAdminStatsInput {
  readonly campaignKey: CampaignAdminCampaignKey;
  readonly interactions: readonly CampaignAdminInteractionFilter[];
  readonly reviewableInteractions: readonly CampaignAdminInteractionFilter[];
  readonly threadSummaryInteractions: readonly CampaignAdminInteractionFilter[];
}

export interface GetCampaignAdminStatsOutput {
  readonly stats: CampaignAdminStatsBase;
  readonly riskFlagCandidates: readonly CampaignAdminRiskFlagCandidate[];
}

export type CampaignAdminReviewableInteraction = CampaignAdminInteractionFilter;

export interface UpsertInteractiveRecordInput {
  readonly userId: string;
  readonly eventId: string;
  readonly clientId: string;
  readonly occurredAt: string;
  readonly record: InteractiveStateRecord;
  readonly auditEvents: readonly InteractiveAuditEvent[];
}

export interface UpsertInteractiveRecordResult {
  readonly applied: boolean;
  readonly row: LearningProgressRecordRow;
}

export const isInteractiveUpdatedEvent = (
  event: LearningProgressEvent
): event is LearningInteractiveUpdatedEvent => {
  return event.type === 'interactive.updated';
};

export const isProgressResetEvent = (
  event: LearningProgressEvent
): event is LearningProgressResetEvent => {
  return event.type === 'progress.reset';
};
