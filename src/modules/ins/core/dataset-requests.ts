/**
 * Dataset requests: a user asks for an INS dataset (usually a CATALOG_ONLY one)
 * to be loaded, optionally for a specific territory.
 *
 * Submissions are allowed anonymously, so `contact_email` and `clerk_user_id`
 * are both optional. `contact_email` and `note` are only persisted for an
 * authenticated submission: Clerk `user.deleted` identifies the account by user
 * id alone, so a row without `clerk_user_id` could never be matched and its PII
 * would outlive the account. See docs/USER-DATA-ANONYMIZATION.md.
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/** Maximum length of the free-text note attached to a request. */
export const MAX_DATASET_REQUEST_NOTE_LENGTH = 1000;

/** Maximum length of an INS dataset code (e.g. `POP107D`). */
export const MAX_DATASET_CODE_LENGTH = 64;

/** Maximum length of a SIRUTA code. */
export const MAX_SIRUTA_CODE_LENGTH = 16;

/** Maximum length of a contact email address. */
export const MAX_CONTACT_EMAIL_LENGTH = 320;

export const InsDatasetRequestInputSchema = Type.Object(
  {
    dataset_code: Type.String({ minLength: 1, maxLength: MAX_DATASET_CODE_LENGTH }),
    siruta: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_SIRUTA_CODE_LENGTH })),
    // Deliberately no `format: 'email'`: TypeBox installs no format registry by
    // default, so `Value.Check` would reject every value. Shape is enforced by
    // `isValidContactEmail`.
    contact_email: Type.Optional(
      Type.String({ minLength: 3, maxLength: MAX_CONTACT_EMAIL_LENGTH })
    ),
    note: Type.Optional(Type.String({ maxLength: MAX_DATASET_REQUEST_NOTE_LENGTH })),
    clerk_user_id: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

export type InsDatasetRequestInput = Static<typeof InsDatasetRequestInputSchema>;

export interface InsDatasetRequest {
  id: string;
  dataset_code: string;
  siruta: string | null;
  created_at: Date;
}

/**
 * Deliberately conservative. Each dot-separated label on either side of the `@`
 * must be non-empty, which rejects consecutive dots (`a@b..com`) and leading or
 * trailing dots — cases the naive `[^\s@]+@[^\s@]+\.[^\s@]+` shape accepts.
 */
const EMAIL_LOCAL = String.raw`[^\s@.]+(?:\.[^\s@.]+)*`;
const EMAIL_DOMAIN = String.raw`[^\s@.]+(?:\.[^\s@.]+)+`;
const EMAIL_REGEX = new RegExp(`^${EMAIL_LOCAL}@${EMAIL_DOMAIN}$`);

export const isValidContactEmail = (value: string): boolean =>
  value.length <= MAX_CONTACT_EMAIL_LENGTH && EMAIL_REGEX.test(value);

export const isValidDatasetRequestInput = (value: unknown): value is InsDatasetRequestInput =>
  Value.Check(InsDatasetRequestInputSchema, value);
