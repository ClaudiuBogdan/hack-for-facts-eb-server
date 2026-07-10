/**
 * INS Module REST API - TypeBox Schemas
 */

import { Type, type Static } from '@sinclair/typebox';

import {
  MAX_CONTACT_EMAIL_LENGTH,
  MAX_DATASET_CODE_LENGTH,
  MAX_DATASET_REQUEST_NOTE_LENGTH,
  MAX_SIRUTA_CODE_LENGTH,
} from '../../core/dataset-requests.js';

export const CreateDatasetRequestBodySchema = Type.Object(
  {
    datasetCode: Type.String({
      minLength: 1,
      maxLength: MAX_DATASET_CODE_LENGTH,
      description: 'INS Tempo dataset code, e.g. POP107D',
    }),
    siruta: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_SIRUTA_CODE_LENGTH,
        description: 'SIRUTA code of the territory the request is about',
      })
    ),
    contactEmail: Type.Optional(
      Type.String({
        minLength: 3,
        maxLength: MAX_CONTACT_EMAIL_LENGTH,
        description: 'Optional contact address; anonymous requests are allowed',
      })
    ),
    note: Type.Optional(
      Type.String({
        maxLength: MAX_DATASET_REQUEST_NOTE_LENGTH,
        description: 'Free-text context for the request',
      })
    ),
  },
  { additionalProperties: false }
);

export type CreateDatasetRequestBody = Static<typeof CreateDatasetRequestBodySchema>;

export const CreateDatasetRequestResponseSchema = Type.Object({
  ok: Type.Literal(true),
  data: Type.Object({
    id: Type.String({ description: 'Identifier of the recorded request' }),
    datasetCode: Type.String(),
  }),
});

export const ErrorResponseSchema = Type.Object({
  ok: Type.Literal(false),
  error: Type.String({ description: 'Error type' }),
  message: Type.Optional(Type.String({ description: 'Human-readable error message' })),
});

export type ErrorResponse = Static<typeof ErrorResponseSchema>;
