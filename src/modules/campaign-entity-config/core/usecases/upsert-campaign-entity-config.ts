import { err, ok, type Result } from 'neverthrow';

import {
  buildCampaignEntityConfigRecordKey,
  buildCampaignEntityConfigUserId,
  createCampaignEntityConfigEventId,
  createCampaignEntityConfigRecord,
  getCampaignEntityConfigClientId,
  getNextCampaignEntityConfigRecordUpdatedAt,
  normalizeCampaignEntityConfigValues,
  parseCampaignEntityConfigRecord,
} from '../config-record.js';
import {
  createConflictError,
  createValidationError,
  type CampaignEntityConfigError,
} from '../errors.js';
import {
  ensureEntityExists,
  mapLearningProgressError,
  normalizeEntityCui,
  type CampaignEntityConfigDeps,
} from './shared.js';

import type { CampaignEntityConfigDto, UpsertCampaignEntityConfigInput } from '../types.js';

function getTimestampMilliseconds(timestamp: string): number | null {
  const milliseconds = Date.parse(timestamp);
  return Number.isNaN(milliseconds) ? null : milliseconds;
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

export type UpsertCampaignEntityConfigDeps = CampaignEntityConfigDeps;

export const upsertCampaignEntityConfig = async (
  deps: UpsertCampaignEntityConfigDeps,
  input: UpsertCampaignEntityConfigInput
): Promise<Result<CampaignEntityConfigDto, CampaignEntityConfigError>> => {
  const entityCuiResult = normalizeEntityCui(input.entityCui);
  if (entityCuiResult.isErr()) {
    return err(entityCuiResult.error);
  }

  const entityCui = entityCuiResult.value;
  const actorUserId = input.actorUserId.trim();
  if (actorUserId === '') {
    return err(createValidationError('Actor user id is required.'));
  }

  const valuesResult = normalizeCampaignEntityConfigValues(input.values);
  if (valuesResult.isErr()) {
    return err(valuesResult.error);
  }

  const transactionResult = await deps.learningProgressRepo.withTransaction<
    CampaignEntityConfigDto,
    CampaignEntityConfigError
  >(async (transactionalRepo) => {
    const entityExistsResult = await ensureEntityExists(
      {
        entityRepo: deps.entityRepo,
      },
      entityCui
    );
    if (entityExistsResult.isErr()) {
      return err(entityExistsResult.error);
    }

    const lockResult = await transactionalRepo.acquireCampaignEntityConfigTransactionLock({
      campaignKey: input.campaignKey,
      entityCui,
    });
    if (lockResult.isErr()) {
      return err(mapLearningProgressError(lockResult.error));
    }

    const currentRowResult = await transactionalRepo.getRecordForUpdate(
      buildCampaignEntityConfigUserId(input.campaignKey),
      buildCampaignEntityConfigRecordKey(entityCui)
    );
    if (currentRowResult.isErr()) {
      return err(mapLearningProgressError(currentRowResult.error));
    }

    const currentRow = currentRowResult.value;
    if (currentRow !== null) {
      const parsedCurrentRowResult = parseCampaignEntityConfigRecord({
        campaignKey: input.campaignKey,
        row: currentRow,
        expectedEntityCui: entityCui,
      });
      if (parsedCurrentRowResult.isErr()) {
        return err(parsedCurrentRowResult.error);
      }

      if (input.expectedUpdatedAt === null) {
        return err(
          createConflictError(
            `Campaign entity config "${entityCui}" already exists. Refetch before retrying.`
          )
        );
      }

      if (compareTimestampInstants(currentRow.updatedAt, input.expectedUpdatedAt) !== 0) {
        return err(
          createConflictError(
            `Campaign entity config "${entityCui}" has changed. Refetch before retrying.`
          )
        );
      }

      const upsertResult = await transactionalRepo.upsertInteractiveRecord({
        userId: buildCampaignEntityConfigUserId(input.campaignKey),
        eventId: createCampaignEntityConfigEventId(),
        clientId: getCampaignEntityConfigClientId(),
        occurredAt: new Date().toISOString(),
        record: createCampaignEntityConfigRecord({
          campaignKey: input.campaignKey,
          entityCui,
          values: valuesResult.value,
          actorUserId,
          recordUpdatedAt: getNextCampaignEntityConfigRecordUpdatedAt(
            parsedCurrentRowResult.value.row.record.updatedAt
          ),
        }),
        auditEvents: [],
      });
      if (upsertResult.isErr()) {
        return err(mapLearningProgressError(upsertResult.error));
      }

      const parsedUpdatedRowResult = parseCampaignEntityConfigRecord({
        campaignKey: input.campaignKey,
        row: upsertResult.value.row,
        expectedEntityCui: entityCui,
      });
      if (parsedUpdatedRowResult.isErr()) {
        return err(parsedUpdatedRowResult.error);
      }

      return ok(parsedUpdatedRowResult.value.dto);
    }

    if (input.expectedUpdatedAt !== null) {
      return err(createConflictError(`Campaign entity config "${entityCui}" does not exist yet.`));
    }

    const upsertResult = await transactionalRepo.upsertInteractiveRecord({
      userId: buildCampaignEntityConfigUserId(input.campaignKey),
      eventId: createCampaignEntityConfigEventId(),
      clientId: getCampaignEntityConfigClientId(),
      occurredAt: new Date().toISOString(),
      record: createCampaignEntityConfigRecord({
        campaignKey: input.campaignKey,
        entityCui,
        values: valuesResult.value,
        actorUserId,
        recordUpdatedAt: getNextCampaignEntityConfigRecordUpdatedAt(),
      }),
      auditEvents: [],
    });
    if (upsertResult.isErr()) {
      return err(mapLearningProgressError(upsertResult.error));
    }

    const parsedInsertedRowResult = parseCampaignEntityConfigRecord({
      campaignKey: input.campaignKey,
      row: upsertResult.value.row,
      expectedEntityCui: entityCui,
    });
    if (parsedInsertedRowResult.isErr()) {
      return err(parsedInsertedRowResult.error);
    }

    return ok(parsedInsertedRowResult.value.dto);
  });

  if (transactionResult.isErr()) {
    const transactionError = transactionResult.error;
    return err(
      transactionError.type === 'DatabaseError' ||
        transactionError.type === 'ValidationError' ||
        transactionError.type === 'NotFoundError' ||
        transactionError.type === 'ConflictError'
        ? transactionError
        : mapLearningProgressError(transactionError)
    );
  }

  return ok(transactionResult.value);
};
