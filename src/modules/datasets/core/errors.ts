import type { ValueError } from '@sinclair/typebox/errors';

export type DatasetValidationError =
  | { type: 'InvalidFormat'; message: string }
  | { type: 'InvalidDecimal'; message: string }
  | { type: 'UnitsMismatch'; message: string; metadataUnit: string; axisUnit: string };

export type DatasetRepoError =
  | DatasetValidationError
  | { type: 'NotFound'; message: string }
  | { type: 'ReadError'; message: string }
  | { type: 'ParseError'; message: string }
  | { type: 'SchemaValidationError'; message: string; details: string[] }
  | { type: 'IdMismatch'; message: string; expected: string; actual: string }
  | { type: 'DuplicateId'; message: string; id: string; files: string[] };

export const formatSchemaErrors = (errors: Iterable<ValueError>): string[] =>
  Array.from(errors).map((error) => `${error.path}: ${error.message}`);
