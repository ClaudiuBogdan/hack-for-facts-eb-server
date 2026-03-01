import { type Result, err, ok } from 'neverthrow';

import { createInvalidInputError, type AdvancedMapAnalyticsError } from '../errors.js';
import {
  ADVANCED_MAP_ANALYTICS_DESCRIPTION_MAX_LENGTH,
  ADVANCED_MAP_ANALYTICS_TITLE_MAX_LENGTH,
} from '../types.js';

export function normalizeOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeNullableText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function validateTitle(
  value: string,
  fieldName: string
): Result<string, AdvancedMapAnalyticsError> {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return err(createInvalidInputError(`${fieldName} cannot be empty`));
  }

  if (trimmed.length > ADVANCED_MAP_ANALYTICS_TITLE_MAX_LENGTH) {
    return err(
      createInvalidInputError(
        `${fieldName} exceeds maximum length of ${String(ADVANCED_MAP_ANALYTICS_TITLE_MAX_LENGTH)}`
      )
    );
  }

  return ok(trimmed);
}

export function validateDescription(
  value: string | null,
  fieldName: string
): Result<string | null, AdvancedMapAnalyticsError> {
  if (value === null) {
    return ok(null);
  }

  if (value.length > ADVANCED_MAP_ANALYTICS_DESCRIPTION_MAX_LENGTH) {
    return err(
      createInvalidInputError(
        `${fieldName} exceeds maximum length of ${String(ADVANCED_MAP_ANALYTICS_DESCRIPTION_MAX_LENGTH)}`
      )
    );
  }

  return ok(value);
}

export function buildDefaultTitle(now: Date): string {
  const iso = now.toISOString().replace('T', ' ').slice(0, 19);
  return `Advanced map ${iso}`;
}
