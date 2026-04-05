import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { createValidationError, type AdminEventError } from './errors.js';

import type { TSchema, Static } from '@sinclair/typebox';

const formatPath = (path: string): string => {
  return path === '' ? '<root>' : path;
};

export const validateSchema = <TSchemaType extends TSchema>(
  schema: TSchemaType,
  candidate: unknown,
  label: string
): Result<Static<TSchemaType>, AdminEventError> => {
  if (Value.Check(schema, candidate)) {
    return ok(candidate);
  }

  const errors = [...Value.Errors(schema, candidate)];
  const message =
    errors.length > 0
      ? errors.map((error) => `${formatPath(error.path)}: ${error.message}`).join(', ')
      : `Invalid ${label}.`;

  return err(createValidationError(`${label}: ${message}`));
};
