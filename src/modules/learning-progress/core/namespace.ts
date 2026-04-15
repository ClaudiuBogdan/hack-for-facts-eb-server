import { err, ok, type Result } from 'neverthrow';

import { createInvalidEventError, type LearningProgressError } from './errors.js';
import { isInternalRecordKey } from './internal-records.js';

interface NamespaceParams {
  readonly eventId?: string;
}

const RECORD_KEY_PREFIX_MIN_LENGTH = 16;

export function validateRecordKeyPrefix(
  recordKeyPrefix: string,
  params: NamespaceParams = {}
): Result<string, LearningProgressError> {
  if (recordKeyPrefix === '') {
    return err(createInvalidEventError('recordKeyPrefix must not be empty.', params.eventId));
  }

  if (recordKeyPrefix.length < RECORD_KEY_PREFIX_MIN_LENGTH) {
    return err(
      createInvalidEventError(
        `recordKeyPrefix must be at least ${String(RECORD_KEY_PREFIX_MIN_LENGTH)} characters long.`,
        params.eventId
      )
    );
  }

  if (isInternalRecordKey(recordKeyPrefix)) {
    return err(
      createInvalidEventError('recordKeyPrefix cannot target internal records.', params.eventId)
    );
  }

  return ok(recordKeyPrefix);
}
