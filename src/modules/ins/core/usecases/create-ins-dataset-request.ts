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

import type { InsDatasetCatalogReader, InsDatasetRequestRepository } from '../ports.js';

export interface CreateInsDatasetRequestDeps {
  datasetRequestRepo: InsDatasetRequestRepository;
  datasetCatalog: InsDatasetCatalogReader;
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

  const siruta = cleaned(input.siruta);
  const clerkUserId = cleaned(input.clerkUserId);

  // Identity-bearing fields are only persisted for an authenticated submission.
  // Clerk `user.deleted` carries a user id and nothing else, so a row with no
  // clerk_user_id can never be matched and its PII would be unreachable forever.
  // Anonymous requests are still accepted — dataset_code/siruta/created_at carry
  // the aggregate "N people asked for this" signal, which is the product value.
  const isAuthenticated = clerkUserId !== undefined;

  const note = isAuthenticated ? cleaned(input.note) : undefined;
  if (note !== undefined && note.length > MAX_DATASET_REQUEST_NOTE_LENGTH) {
    return err(
      createValidationError(
        'note',
        `note must be at most ${String(MAX_DATASET_REQUEST_NOTE_LENGTH)} characters`
      )
    );
  }

  const contactEmail = isAuthenticated ? cleaned(input.contactEmail) : undefined;
  if (contactEmail !== undefined && !isValidContactEmail(contactEmail)) {
    return err(createValidationError('contactEmail', 'contactEmail is not a valid email address'));
  }

  const normalizedCode = datasetCode.toUpperCase();

  const record: InsDatasetRequestInput = {
    dataset_code: normalizedCode,
    ...(siruta !== undefined ? { siruta } : {}),
    ...(contactEmail !== undefined ? { contact_email: contactEmail } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(clerkUserId !== undefined ? { clerk_user_id: clerkUserId } : {}),
  };

  if (!isValidDatasetRequestInput(record)) {
    return err(createValidationError('body', 'Dataset request payload failed validation'));
  }

  // A request for a dataset that does not exist is unsatisfiable, so refuse it
  // rather than accumulating unactionable rows. Checked last: it is the only
  // step that performs I/O.
  const exists = await deps.datasetCatalog.datasetExists(normalizedCode);
  if (exists.isErr()) {
    return err(exists.error);
  }
  if (!exists.value) {
    return err(createValidationError('datasetCode', `Unknown INS dataset code: ${normalizedCode}`));
  }

  return deps.datasetRequestRepo.create(record);
};
