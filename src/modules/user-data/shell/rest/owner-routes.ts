import { createHash } from 'node:crypto';

import { hashCanonicalJson } from '@/common/canonical-json/index.js';
import { isAuthenticated, requireAuthHandler } from '@/modules/auth/index.js';

import { sendUserDataRouteError } from './route-errors.js';
import {
  CategoryParamsSchema,
  DeleteMutationQuerySchema,
  ErrorResponseSchema,
  EventPageResponseSchema,
  HistoryQuerySchema,
  MutationBodySchema,
  MutationResponseSchema,
  PageQuerySchema,
  PageResponseSchema,
  RecordKeyParamsSchema,
  RecordViewSchema,
  SyncQuerySchema,
  SyncResponseSchema,
  type CategoryParams,
  type DeleteMutationQuery,
  type HistoryQuery,
  type MutationBody,
  type PageQuery,
  type RecordKeyParams,
  type SyncQuery,
} from './schemas.js';
import { createInvalidPayload, createNotFound } from '../../core/errors.js';
import { deleteRecord } from '../../core/usecases/delete-record.js';
import { getRecordHistory } from '../../core/usecases/get-record-history.js';
import { getRecord } from '../../core/usecases/get-record.js';
import { listRecords } from '../../core/usecases/list-records.js';
import { replaceRecord } from '../../core/usecases/replace-record.js';
import { restoreRecord } from '../../core/usecases/restore-record.js';
import { syncRecords } from '../../core/usecases/sync-records.js';

import type { MutationOperation, ReceiptClaim, RecordIdentity } from '../../core/types.js';
import type { RegisteredReadDeps } from '../../core/usecases/read-shared.js';
import type { MutationDeps } from '../../core/usecases/shared.js';
import type { FastifyPluginAsync } from 'fastify';

export type MakeUserDataOwnerRoutesDeps = MutationDeps & RegisteredReadDeps;

const ERRORS = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  413: ErrorResponseSchema,
  429: ErrorResponseSchema,
  500: ErrorResponseSchema,
} as const;

const makeClaim = (
  requesterId: string,
  idempotencyKey: string,
  canonicalCommand: unknown
): ReceiptClaim | null => {
  const canonicalRequestHash = hashCanonicalJson(canonicalCommand);
  if (canonicalRequestHash.isErr()) return null;
  return {
    requesterId,
    idempotencyKeyHash: createHash('sha256').update(idempotencyKey).digest('hex'),
    canonicalRequestHash: canonicalRequestHash.value,
  };
};

const mutationIdentity = (ownerId: string, params: RecordKeyParams): RecordIdentity => ({
  ownerId,
  category: params.category,
  logicalKey: params.logicalKey,
});

const clientDate = (raw: string | undefined): Date | null =>
  raw === undefined ? null : new Date(raw);

const canonicalMutation = (
  identity: RecordIdentity,
  body: Pick<MutationBody, 'schemaVersion' | 'expectedRevision' | 'payload' | 'target'>,
  operation: MutationOperation
) => ({
  identity,
  schemaVersion: body.schemaVersion,
  expectedRevision: body.expectedRevision,
  payload: body.payload,
  target: body.target ?? null,
  operation,
});

export const makeUserDataOwnerRoutes = (deps: MakeUserDataOwnerRoutesDeps): FastifyPluginAsync => {
  return (fastify) => {
    fastify.addHook('preHandler', requireAuthHandler);

    fastify.put<{ Params: RecordKeyParams; Body: MutationBody }>(
      '/api/user-data/records/:category/:logicalKey',
      {
        schema: {
          params: RecordKeyParamsSchema,
          body: MutationBodySchema,
          response: { 200: MutationResponseSchema, ...ERRORS },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) return;
        const identity = mutationIdentity(request.auth.userId, request.params);
        const operation = request.body.expectedRevision === 0 ? 'create' : 'replace';
        const receipt = makeClaim(
          request.auth.userId,
          request.body.idempotencyKey,
          canonicalMutation(identity, request.body, operation)
        );
        if (receipt === null)
          return sendUserDataRouteError(reply, createInvalidPayload(['/request:canonicalJson']));
        const result = await replaceRecord(deps, {
          ownerId: request.auth.userId,
          requesterId: request.auth.userId,
          actor: { type: 'owner' },
          command: {
            identity,
            schemaVersion: request.body.schemaVersion,
            expectedRevision: request.body.expectedRevision,
            payload: request.body.payload,
            target: request.body.target ?? null,
            clientOccurredAt: clientDate(request.body.clientOccurredAt),
            receipt,
          },
        });
        return result.isErr()
          ? sendUserDataRouteError(reply, result.error)
          : reply.status(200).send(result.value);
      }
    );

    fastify.delete<{ Params: RecordKeyParams; Querystring: DeleteMutationQuery }>(
      '/api/user-data/records/:category/:logicalKey',
      {
        schema: {
          params: RecordKeyParamsSchema,
          querystring: DeleteMutationQuerySchema,
          response: { 200: MutationResponseSchema, ...ERRORS },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) return;
        const identity = mutationIdentity(request.auth.userId, request.params);
        const canonical = {
          identity,
          schemaVersion: null,
          expectedRevision: request.query.expectedRevision,
          payload: null,
          target: null,
          operation: 'delete',
        };
        const receipt = makeClaim(request.auth.userId, request.query.idempotencyKey, canonical);
        if (receipt === null)
          return sendUserDataRouteError(reply, createInvalidPayload(['/request:canonicalJson']));
        const result = await deleteRecord(deps, {
          ownerId: request.auth.userId,
          requesterId: request.auth.userId,
          actor: { type: 'owner' },
          command: {
            identity,
            expectedRevision: request.query.expectedRevision,
            clientOccurredAt: clientDate(request.query.clientOccurredAt),
            receipt,
          },
        });
        return result.isErr()
          ? sendUserDataRouteError(reply, result.error)
          : reply.status(200).send(result.value);
      }
    );

    fastify.post<{ Params: RecordKeyParams; Body: MutationBody }>(
      '/api/user-data/records/:category/:logicalKey/restore',
      {
        schema: {
          params: RecordKeyParamsSchema,
          body: MutationBodySchema,
          response: { 200: MutationResponseSchema, ...ERRORS },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) return;
        const identity = mutationIdentity(request.auth.userId, request.params);
        const receipt = makeClaim(
          request.auth.userId,
          request.body.idempotencyKey,
          canonicalMutation(identity, request.body, 'restore')
        );
        if (receipt === null)
          return sendUserDataRouteError(reply, createInvalidPayload(['/request:canonicalJson']));
        const result = await restoreRecord(deps, {
          ownerId: request.auth.userId,
          requesterId: request.auth.userId,
          actor: { type: 'owner' },
          command: {
            identity,
            schemaVersion: request.body.schemaVersion,
            expectedRevision: request.body.expectedRevision,
            payload: request.body.payload,
            target: request.body.target ?? null,
            clientOccurredAt: clientDate(request.body.clientOccurredAt),
            receipt,
          },
        });
        return result.isErr()
          ? sendUserDataRouteError(reply, result.error)
          : reply.status(200).send(result.value);
      }
    );

    fastify.get<{ Params: RecordKeyParams }>(
      '/api/user-data/records/:category/:logicalKey',
      { schema: { params: RecordKeyParamsSchema, response: { 200: RecordViewSchema, ...ERRORS } } },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) return;
        const result = await getRecord(deps, {
          by: 'key',
          ownerId: request.auth.userId,
          category: request.params.category,
          logicalKey: request.params.logicalKey,
        });
        if (result.isErr()) return sendUserDataRouteError(reply, result.error);
        return result.value === null
          ? sendUserDataRouteError(
              reply,
              createNotFound(request.params.category, request.params.logicalKey)
            )
          : reply.status(200).send(result.value);
      }
    );

    fastify.get<{ Params: CategoryParams; Querystring: PageQuery }>(
      '/api/user-data/records/:category',
      {
        schema: {
          params: CategoryParamsSchema,
          querystring: PageQuerySchema,
          response: { 200: PageResponseSchema, ...ERRORS },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) return;
        const result = await listRecords(deps, {
          ownerId: request.auth.userId,
          category: request.params.category,
          limit: request.query.limit ?? 100,
          cursor: request.query.cursor ?? null,
        });
        return result.isErr()
          ? sendUserDataRouteError(reply, result.error)
          : reply.status(200).send(result.value);
      }
    );

    fastify.get<{ Params: RecordKeyParams; Querystring: HistoryQuery }>(
      '/api/user-data/records/:category/:logicalKey/history',
      {
        schema: {
          params: RecordKeyParamsSchema,
          querystring: HistoryQuerySchema,
          response: { 200: EventPageResponseSchema, ...ERRORS },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) return;
        const found = await getRecord(deps, {
          by: 'key',
          ownerId: request.auth.userId,
          category: request.params.category,
          logicalKey: request.params.logicalKey,
        });
        if (found.isErr()) return sendUserDataRouteError(reply, found.error);
        if (found.value === null)
          return sendUserDataRouteError(
            reply,
            createNotFound(request.params.category, request.params.logicalKey)
          );
        const result = await getRecordHistory(deps, {
          ownerId: request.auth.userId,
          recordId: found.value.recordId,
          limit: request.query.limit ?? 100,
          beforeRevision: request.query.beforeRevision ?? null,
        });
        return result.isErr()
          ? sendUserDataRouteError(reply, result.error)
          : reply.status(200).send(result.value);
      }
    );

    fastify.get<{ Querystring: SyncQuery }>(
      '/api/user-data/sync',
      {
        schema: {
          querystring: SyncQuerySchema,
          response: { 200: SyncResponseSchema, ...ERRORS },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) return;
        const result = await syncRecords(deps, {
          ownerId: request.auth.userId,
          rawCursor: request.query.cursor ?? null,
          limit: request.query.limit ?? 100,
          category: request.query.category ?? null,
        });
        return result.isErr()
          ? sendUserDataRouteError(reply, result.error)
          : reply.status(200).send(result.value);
      }
    );

    return Promise.resolve();
  };
};
