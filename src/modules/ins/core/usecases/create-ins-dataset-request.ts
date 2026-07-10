/**
 * Record a request for an INS dataset to be loaded.
 */

import { err, type Result } from 'neverthrow';

import {
  MAX_DATASET_REQUEST_NOTE_LENGTH,
  isValidContactEmail,
  isValidDatasetRequestInput,
  type InsDatasetRequest,
  type InsDatasetRequestInput,
} from '../dataset-requests.js';
import { createValidationError, type InsError } from '../errors.js';

import type { InsDatasetRequestRepository } from '../ports.js';

export interface CreateInsDatasetRequestDeps {
  datasetRequestRepo: InsDatasetRequestRepository;
}

export interface CreateInsDatasetRequestInput {
  datasetCode: string;
  siruta?: string;
  contactEmail?: string;
  note?: string;
  clerkUserId?: string;
}

/** Drops a value that is absent or whitespace-only. */
const cleaned = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export const createInsDatasetRequest = async (
  deps: CreateInsDatasetRequestDeps,
  input: CreateInsDatasetRequestInput
): Promise<Result<InsDatasetRequest, InsError>> => {
  const datasetCode = cleaned(input.datasetCode);
  if (datasetCode === undefined) {
    return err(createValidationError('datasetCode', 'datasetCode is required'));
  }

  const note = cleaned(input.note);
  if (note !== undefined && note.length > MAX_DATASET_REQUEST_NOTE_LENGTH) {
    return err(
      createValidationError(
        'note',
        `note must be at most ${String(MAX_DATASET_REQUEST_NOTE_LENGTH)} characters`
      )
    );
  }

  const contactEmail = cleaned(input.contactEmail);
  if (contactEmail !== undefined && !isValidContactEmail(contactEmail)) {
    return err(createValidationError('contactEmail', 'contactEmail is not a valid email address'));
  }

  const siruta = cleaned(input.siruta);
  const clerkUserId = cleaned(input.clerkUserId);

  const record: InsDatasetRequestInput = {
    dataset_code: datasetCode.toUpperCase(),
    ...(siruta !== undefined ? { siruta } : {}),
    ...(contactEmail !== undefined ? { contact_email: contactEmail } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(clerkUserId !== undefined ? { clerk_user_id: clerkUserId } : {}),
  };

  if (!isValidDatasetRequestInput(record)) {
    return err(createValidationError('body', 'Dataset request payload failed validation'));
  }

  return deps.datasetRequestRepo.create(record);
};
