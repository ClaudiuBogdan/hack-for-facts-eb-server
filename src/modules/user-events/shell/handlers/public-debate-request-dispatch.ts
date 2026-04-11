import { err, ok, type Result } from 'neverthrow';

import {
  DEBATE_REQUEST_INTERACTION_ID,
  parseDebateRequestPayloadValue,
} from '@/common/public-debate-request.js';
import {
  EMAIL_REGEX,
  PUBLIC_DEBATE_REQUEST_TYPE,
  createConflictError as createCorrespondenceConflictError,
  createDatabaseError as createCorrespondenceDatabaseError,
  createValidationError as createCorrespondenceValidationError,
  normalizeEmailAddress,
  requestPublicDebatePlatformSend,
  type CorrespondenceEmailSender,
  type CorrespondenceTemplateRenderer,
  type InstitutionCorrespondenceError,
  type InstitutionCorrespondenceRepository,
  type PublicDebateEntitySubscriptionService,
  type PublicDebateEntityUpdatePublisher,
  type SendPlatformRequestInput,
  type SendPlatformRequestOutput,
  type ThreadRecord,
} from '@/modules/institution-correspondence/index.js';
import {
  createConflictError as createLearningProgressConflictError,
  createNotFoundError,
  type InteractiveStateRecord,
  type LearningProgressError,
  type LearningProgressRecordRow,
  type LearningProgressRepository,
  type ReviewDecision,
} from '@/modules/learning-progress/index.js';

import type { EntityProfileRepository, EntityRepository } from '@/modules/entity/index.js';

export interface PublicDebateRequestDispatchDeps {
  entityRepo: EntityRepository;
  entityProfileRepo: EntityProfileRepository;
  repo: InstitutionCorrespondenceRepository;
  emailSender: CorrespondenceEmailSender;
  templateRenderer: CorrespondenceTemplateRenderer;
  auditCcRecipients: string[];
  platformBaseUrl: string;
  captureAddress: string;
  subscriptionService?: PublicDebateEntitySubscriptionService;
  updatePublisher?: PublicDebateEntityUpdatePublisher;
}

export interface PublicDebateRequestReviewSideEffectDeps extends PublicDebateRequestDispatchDeps {
  learningProgressRepo: LearningProgressRepository;
}

export interface PreparedPublicDebateReviewSideEffectPlan {
  afterCommit(): Promise<void>;
}

export interface PreparedPublicDebateRequestDispatch {
  kind: 'execute';
  sendInput: SendPlatformRequestInput;
  existingThread?: ThreadRecord;
}

export type PublicDebateRequestDispatchPreparation =
  | { kind: 'not_applicable' }
  | {
      kind: 'blocked_invalid_institution_email';
      feedbackText: string;
      submittedInstitutionEmail: string;
    }
  | {
      kind: 'blocked_email_mismatch';
      submittedInstitutionEmail: string;
      officialEmail: string | null;
    }
  | PreparedPublicDebateRequestDispatch;

const INVALID_INSTITUTION_EMAIL_MESSAGE =
  'The submitted city hall email is not a valid email address.';
const EMAIL_MISMATCH_MESSAGE =
  'The submitted city hall email does not match the current official email on record.';

function isPublicDebateRequestRecord(record: InteractiveStateRecord): boolean {
  return (
    record.interactionId === DEBATE_REQUEST_INTERACTION_ID &&
    record.scope.type === 'entity' &&
    record.value?.kind === 'json'
  );
}

async function loadOfficialEmailMatch(
  deps: Pick<PublicDebateRequestDispatchDeps, 'entityProfileRepo'>,
  input: {
    entityCui: string;
    institutionEmail: string;
  }
): Promise<
  Result<
    {
      exactMatch: boolean;
      officialEmail: string | null;
    },
    InstitutionCorrespondenceError
  >
> {
  const profileResult = await deps.entityProfileRepo.getByEntityCui(input.entityCui);
  if (profileResult.isErr()) {
    return err(
      createCorrespondenceDatabaseError(
        'Failed to load entity profile while validating institution email',
        profileResult.error
      )
    );
  }

  const officialEmail = profileResult.value?.official_email?.trim() ?? null;
  if (officialEmail === null || officialEmail === '') {
    return ok({
      exactMatch: false,
      officialEmail: null,
    });
  }

  return ok({
    exactMatch:
      normalizeEmailAddress(officialEmail) === normalizeEmailAddress(input.institutionEmail),
    officialEmail,
  });
}

async function loadEntityName(
  deps: Pick<PublicDebateRequestDispatchDeps, 'entityRepo'>,
  entityCui: string
): Promise<Result<string | null, InstitutionCorrespondenceError>> {
  const entityResult = await deps.entityRepo.getById(entityCui);
  if (entityResult.isErr()) {
    return err(
      createCorrespondenceDatabaseError(
        'Failed to load entity while preparing public debate request',
        entityResult.error
      )
    );
  }

  return ok(entityResult.value?.name ?? null);
}

export const buildPublicDebateRequestEmailMismatchError = (): InstitutionCorrespondenceError => {
  return createCorrespondenceConflictError(EMAIL_MISMATCH_MESSAGE);
};

export async function preparePublicDebateRequestDispatch(
  deps: PublicDebateRequestDispatchDeps,
  recordRow: LearningProgressRecordRow,
  options?: {
    allowApprovedReview?: boolean;
  }
): Promise<Result<PublicDebateRequestDispatchPreparation, InstitutionCorrespondenceError>> {
  const record = recordRow.record;
  const isApprovedReviewRetry =
    options?.allowApprovedReview === true &&
    record.phase === 'resolved' &&
    record.review?.status === 'approved';

  if (
    !isPublicDebateRequestRecord(record) ||
    (record.phase !== 'pending' && !isApprovedReviewRetry)
  ) {
    return ok({ kind: 'not_applicable' });
  }

  if (record.scope.type !== 'entity' || record.value?.kind !== 'json') {
    return ok({ kind: 'not_applicable' });
  }

  const payload = parseDebateRequestPayloadValue(record.value.json.value);
  if (payload?.submissionPath !== 'request_platform') {
    return ok({ kind: 'not_applicable' });
  }

  const entityCui = record.scope.entityCui;
  const institutionEmail = payload.primariaEmail.trim();
  const baseSendInput: SendPlatformRequestInput = {
    ownerUserId: recordRow.userId,
    entityCui,
    institutionEmail,
    requesterOrganizationName: payload.organizationName,
    budgetPublicationDate: null,
    consentCapturedAt: payload.submittedAt,
  };

  const existingThreadResult = await deps.repo.findPlatformSendThreadByEntity({
    entityCui,
    campaign: PUBLIC_DEBATE_REQUEST_TYPE,
  });

  if (existingThreadResult.isErr()) {
    return err(existingThreadResult.error);
  }

  if (existingThreadResult.value !== null) {
    return ok({
      kind: 'execute',
      sendInput: baseSendInput,
      existingThread: existingThreadResult.value,
    });
  }

  if (!EMAIL_REGEX.test(institutionEmail)) {
    return ok({
      kind: 'blocked_invalid_institution_email',
      feedbackText: INVALID_INSTITUTION_EMAIL_MESSAGE,
      submittedInstitutionEmail: institutionEmail,
    });
  }

  if (!isApprovedReviewRetry) {
    const officialEmailMatchResult = await loadOfficialEmailMatch(deps, {
      entityCui,
      institutionEmail,
    });

    if (officialEmailMatchResult.isErr()) {
      return err(officialEmailMatchResult.error);
    }

    if (!officialEmailMatchResult.value.exactMatch) {
      return ok({
        kind: 'blocked_email_mismatch',
        submittedInstitutionEmail: institutionEmail,
        officialEmail: officialEmailMatchResult.value.officialEmail,
      });
    }
  }

  const entityNameResult = await loadEntityName(deps, entityCui);
  if (entityNameResult.isErr()) {
    return err(entityNameResult.error);
  }

  return ok({
    kind: 'execute',
    sendInput: {
      ...baseSendInput,
      entityName: entityNameResult.value,
    },
  });
}

function isApprovedReviewRecord(recordRow: LearningProgressRecordRow): boolean {
  return recordRow.record.phase === 'resolved' && recordRow.record.review?.status === 'approved';
}

export async function executePreparedPublicDebateRequestDispatch(
  deps: PublicDebateRequestDispatchDeps,
  prepared: PreparedPublicDebateRequestDispatch
): Promise<Result<SendPlatformRequestOutput, InstitutionCorrespondenceError>> {
  if (prepared.existingThread !== undefined) {
    if (deps.subscriptionService !== undefined) {
      const subscribeResult = await deps.subscriptionService.ensureSubscribed(
        prepared.sendInput.ownerUserId,
        prepared.sendInput.entityCui
      );

      if (subscribeResult.isErr()) {
        return err(subscribeResult.error);
      }
    }

    return ok({
      created: false,
      thread: prepared.existingThread,
    });
  }

  return requestPublicDebatePlatformSend(
    {
      repo: deps.repo,
      emailSender: deps.emailSender,
      templateRenderer: deps.templateRenderer,
      auditCcRecipients: deps.auditCcRecipients,
      platformBaseUrl: deps.platformBaseUrl,
      captureAddress: deps.captureAddress,
      ...(deps.subscriptionService !== undefined
        ? { subscriptionService: deps.subscriptionService }
        : {}),
      ...(deps.updatePublisher !== undefined ? { updatePublisher: deps.updatePublisher } : {}),
    },
    prepared.sendInput
  );
}

function getTimestampMilliseconds(timestamp: string): number | null {
  const parsedTimestamp = Date.parse(timestamp);
  return Number.isNaN(parsedTimestamp) ? null : parsedTimestamp;
}

function compareTimestampInstants(leftTimestamp: string, rightTimestamp: string): number {
  const leftMilliseconds = getTimestampMilliseconds(leftTimestamp);
  const rightMilliseconds = getTimestampMilliseconds(rightTimestamp);

  if (leftMilliseconds !== null && rightMilliseconds !== null) {
    if (leftMilliseconds < rightMilliseconds) return -1;
    if (leftMilliseconds > rightMilliseconds) return 1;
    return 0;
  }

  return leftTimestamp.localeCompare(rightTimestamp);
}

export async function prepareApprovedPublicDebateReviewSideEffects(
  deps: PublicDebateRequestReviewSideEffectDeps,
  input: { items: readonly ReviewDecision[] }
): Promise<
  Result<
    PreparedPublicDebateReviewSideEffectPlan | null,
    LearningProgressError | InstitutionCorrespondenceError
  >
> {
  // Maintenance note: check /docs/guides/INTERACTIVE-ELEMENT-CHECKS-AND-TRIGGERS.md.
  const preparedDispatches: PreparedPublicDebateRequestDispatch[] = [];

  for (const item of input.items) {
    if (item.status !== 'approved') {
      continue;
    }

    const recordResult = await deps.learningProgressRepo.getRecord(item.userId, item.recordKey);
    if (recordResult.isErr()) {
      return err(recordResult.error);
    }

    const recordRow = recordResult.value;
    if (recordRow === null) {
      return err(createNotFoundError(`Interaction record "${item.recordKey}" was not found.`));
    }

    const pendingRecord = recordRow.record.phase === 'pending';
    const approvedRecord = isApprovedReviewRecord(recordRow);
    if (!pendingRecord && !approvedRecord) {
      return err(
        createLearningProgressConflictError(
          `Interaction record "${item.recordKey}" is no longer reviewable because it is not pending.`
        )
      );
    }

    if (
      pendingRecord &&
      compareTimestampInstants(recordRow.updatedAt, item.expectedUpdatedAt) !== 0
    ) {
      return err(
        createLearningProgressConflictError(
          `Interaction record "${item.recordKey}" changed since it was loaded for review.`
        )
      );
    }

    const preparationResult = await preparePublicDebateRequestDispatch(deps, recordRow, {
      allowApprovedReview: approvedRecord,
    });
    if (preparationResult.isErr()) {
      return err(preparationResult.error);
    }

    switch (preparationResult.value.kind) {
      case 'not_applicable':
        continue;
      case 'blocked_invalid_institution_email':
        return err(createCorrespondenceValidationError(preparationResult.value.feedbackText));
      case 'blocked_email_mismatch':
        return err(buildPublicDebateRequestEmailMismatchError());
      case 'execute':
        preparedDispatches.push(preparationResult.value);
        break;
    }
  }

  if (preparedDispatches.length === 0) {
    return ok(null);
  }

  return ok({
    async afterCommit(): Promise<void> {
      for (const preparedDispatch of preparedDispatches) {
        const dispatchResult = await executePreparedPublicDebateRequestDispatch(
          deps,
          preparedDispatch
        );

        if (dispatchResult.isErr()) {
          throw new Error(dispatchResult.error.message, {
            cause: dispatchResult.error,
          });
        }
      }
    },
  });
}
