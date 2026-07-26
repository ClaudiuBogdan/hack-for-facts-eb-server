import {
  isWithheldOrganizationIdentifier,
  normalizeCui,
  httpStatusFor,
  type ApiError,
  type CursorPage,
  type FilterInput,
} from '@/modules/shared/index.js';

import {
  PnrrCountyParamsSchema,
  PnrrCuiParamsSchema,
  PnrrErrorSchema,
  PnrrKeyParamsSchema,
  PnrrOrganizationsQuerySchema,
  PnrrPageQuerySchema,
  PnrrProjectsQuerySchema,
  PnrrReleaseQuerySchema,
  PnrrScopeQuerySchema,
  PnrrSuccessSchema,
  type PnrrCountyParams,
  type PnrrCuiParams,
  type PnrrKeyParams,
  type PnrrOrganizationsQuery,
  type PnrrPageQuery,
  type PnrrProjectsQuery,
  type PnrrReleaseQuery,
  type PnrrScopeQuery,
} from './schemas.js';
import {
  getPnrrCapabilities,
  getPnrrCurrentRelease,
  getPnrrEntity,
  getPnrrEntityProfile,
  getPnrrOverview,
  getPnrrPlaceProfile,
  getPnrrProject,
  getPnrrProjectFacets,
  getPnrrProjectHistory,
  getPnrrVerification,
  listPnrrEntities,
  listPnrrFundingApplicationListings,
  listPnrrFundingCalls,
  listPnrrCatalogResources,
  listPnrrDocumentReferences,
  listPnrrPlaces,
  listPnrrProjects,
  listPnrrProgramRevisions,
} from '../../core/usecases.js';

import type { PnrrRepository } from '../../core/ports.js';
import type { PnrrAnalysisScope } from '../../core/types.js';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { Result } from 'neverthrow';

export interface PnrrRestDeps {
  readonly repo: PnrrRepository;
}

const sendError = (reply: FastifyReply, error: ApiError) =>
  reply.code(httpStatusFor(error)).send({
    ok: false,
    error: error.type,
    message: error.message,
  });

const scopeOf = (
  query: PnrrScopeQuery,
  defaults: Pick<PnrrAnalysisScope, 'grain' | 'measure' | 'timeRole' | 'geographyRole'>
): PnrrAnalysisScope => {
  const normalizedCui =
    query.beneficiaryCui === undefined ? null : normalizeCui(query.beneficiaryCui);
  return {
    ...defaults,
    componentCode: query.componentCode ?? null,
    beneficiaryCui: normalizedCui,
    countySiruta: query.countySiruta ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
    currency: query.currency ?? null,
    resolutionPolicyVersion: 'pnrr-resolution-v1',
  };
};

const rejectInvalidScopeCui = (query: PnrrScopeQuery, reply: FastifyReply): boolean => {
  if (query.beneficiaryCui === undefined) return false;
  const cui = normalizeCui(query.beneficiaryCui);
  if (cui !== null && !isWithheldOrganizationIdentifier(cui)) return false;
  reply.code(400).send({
    ok: false,
    error: 'InvalidInput',
    message: 'Invalid or withheld organization identifier.',
  });
  return true;
};

const rejectUnsupportedScope = (
  query: PnrrScopeQuery,
  reply: FastifyReply,
  options: { allowFilters: boolean }
): boolean => {
  if (query.currency !== undefined) {
    reply.code(400).send({
      ok: false,
      error: 'InvalidInput',
      message: 'Currency-scoped PNRR analysis is not implemented for this operation.',
    });
    return true;
  }
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
    reply.code(400).send({
      ok: false,
      error: 'InvalidInput',
      message: 'PNRR scope end date precedes start date.',
    });
    return true;
  }
  if (
    !options.allowFilters &&
    [query.componentCode, query.beneficiaryCui, query.countySiruta, query.from, query.to].some(
      (value) => value !== undefined
    )
  ) {
    reply.code(400).send({
      ok: false,
      error: 'InvalidInput',
      message: 'Filters are not implemented for this PNRR operation.',
    });
    return true;
  }
  return false;
};

const projectFilterOf = (query: PnrrProjectsQuery): FilterInput => {
  const filter: Record<string, unknown> = {};
  if (query.componentCode !== undefined) {
    filter['componentCode'] = { eq: query.componentCode };
  }
  if (query.beneficiaryCui !== undefined) {
    filter['beneficiaryCui'] = { eq: query.beneficiaryCui };
  }
  if (query.countySiruta !== undefined) {
    filter['countySiruta'] = { eq: query.countySiruta };
  }
  if (query.contractNumber !== undefined) {
    filter['contractNumber'] = { eq: query.contractNumber };
  }
  if (query.measureCode !== undefined) {
    filter['measureCode'] = { eq: query.measureCode };
  }
  if (query.status !== undefined) filter['status'] = { eq: query.status };
  if (query.from !== undefined || query.to !== undefined) {
    filter['snapshotDate'] = {
      between: {
        ...(query.from !== undefined && { from: query.from }),
        ...(query.to !== undefined && { to: query.to }),
      },
    };
  }
  return filter as FilterInput;
};

const observedReleaseIds = new WeakMap<FastifyReply, string>();

const assertRelease = async (
  repo: PnrrRepository,
  expected: string | undefined,
  reply: FastifyReply,
  options: { allowAbstained?: boolean } = {}
): Promise<string | null> => {
  const release = await getPnrrCurrentRelease(repo);
  if (release.isErr()) {
    sendError(reply, release.error);
    return null;
  }
  if (release.value.state === 'abstained' && options.allowAbstained !== true) {
    reply.code(503).send({
      ok: false,
      error: 'PNRR_UNAVAILABLE',
      message: 'PNRR serving release is unavailable.',
    });
    return null;
  }
  const pinned = expected ?? observedReleaseIds.get(reply);
  if (pinned === undefined || release.value.releaseId === pinned) {
    observedReleaseIds.set(reply, release.value.releaseId);
    return release.value.releaseId;
  }
  reply.code(409).send({
    ok: false,
    error: 'RELEASE_MISMATCH',
    message: 'PNRR release changed; restart the query.',
    expectedReleaseId: pinned,
    currentReleaseId: release.value.releaseId,
  });
  return null;
};

const schemas = {
  response: {
    200: PnrrSuccessSchema,
    400: PnrrErrorSchema,
    404: PnrrErrorSchema,
    409: PnrrErrorSchema,
    500: PnrrErrorSchema,
    503: PnrrErrorSchema,
  },
};

export const makePnrrRestRoutes =
  ({ repo }: PnrrRestDeps): FastifyPluginAsync =>
  async (fastify) => {
    fastify.get('/release', { schema: schemas }, async (_request, reply) => {
      const result = await getPnrrCurrentRelease(repo);
      return result.isErr()
        ? sendError(reply, result.error)
        : reply.send({ ok: true, data: result.value });
    });

    fastify.get<{ Querystring: PnrrReleaseQuery }>(
      '/capabilities',
      { schema: { ...schemas, querystring: PnrrReleaseQuerySchema } },
      async (request, reply) => {
        const releaseId = await assertRelease(repo, request.query.assertReleaseId, reply, {
          allowAbstained: true,
        });
        if (releaseId === null) return;
        const result = await getPnrrCapabilities(repo);
        if (result.isErr()) return sendError(reply, result.error);
        if (result.value.some((capability) => capability.releaseId !== releaseId)) {
          reply.code(409).send({
            ok: false,
            error: 'RELEASE_MISMATCH',
            message: 'PNRR capability manifest does not match the observed release.',
            expectedReleaseId: releaseId,
            currentReleaseId: result.value[0]?.releaseId ?? 'unknown',
          });
          return;
        }
        if ((await assertRelease(repo, releaseId, reply, { allowAbstained: true })) === null)
          return;
        return reply.send({ ok: true, data: result.value });
      }
    );

    fastify.get<{ Querystring: PnrrScopeQuery }>(
      '/overview',
      { schema: { ...schemas, querystring: PnrrScopeQuerySchema } },
      async (request, reply) => {
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        if (rejectInvalidScopeCui(request.query, reply)) return;
        if (rejectUnsupportedScope(request.query, reply, { allowFilters: true })) return;
        const result = await getPnrrOverview(
          repo,
          scopeOf(request.query, {
            grain: 'program',
            measure: 'amount',
            timeRole: 'snapshot_date',
            geographyRole: 'implementation_county',
          })
        );
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        return result.isErr()
          ? sendError(reply, result.error)
          : reply.send({ ok: true, data: result.value });
      }
    );

    fastify.get<{ Querystring: PnrrProjectsQuery }>(
      '/projects',
      { schema: { ...schemas, querystring: PnrrProjectsQuerySchema } },
      async (request, reply) => {
        const releaseId = await assertRelease(repo, request.query.assertReleaseId, reply);
        if (releaseId === null) return;
        const result = await listPnrrProjects(
          repo,
          projectFilterOf(request.query),
          {
            first: request.query.first ?? 20,
            ...(request.query.after !== undefined && { after: request.query.after }),
          },
          releaseId
        );
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        return result.isErr()
          ? sendError(reply, result.error)
          : reply.send({ ok: true, data: result.value });
      }
    );

    fastify.get<{ Querystring: PnrrProjectsQuery }>(
      '/projects/facets',
      { schema: { ...schemas, querystring: PnrrProjectsQuerySchema } },
      async (request, reply) => {
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        const result = await getPnrrProjectFacets(repo, projectFilterOf(request.query));
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        return result.isErr()
          ? sendError(reply, result.error)
          : reply.send({ ok: true, data: result.value });
      }
    );

    fastify.get<{ Params: PnrrKeyParams; Querystring: PnrrScopeQuery }>(
      '/projects/:key/history',
      {
        schema: {
          ...schemas,
          params: PnrrKeyParamsSchema,
          querystring: PnrrScopeQuerySchema,
        },
      },
      async (request, reply) => {
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        const result = await getPnrrProjectHistory(repo, request.params.key);
        if (result.isErr()) return sendError(reply, result.error);
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        if (result.value.length === 0) {
          return reply.code(404).send({
            ok: false,
            error: 'NotFound',
            message: `PNRR project ${request.params.key} was not found.`,
          });
        }
        return reply.send({ ok: true, data: result.value });
      }
    );

    fastify.get<{ Querystring: PnrrOrganizationsQuery }>(
      '/organizations',
      { schema: { ...schemas, querystring: PnrrOrganizationsQuerySchema } },
      async (request, reply) => {
        const releaseId = await assertRelease(repo, request.query.assertReleaseId, reply);
        if (releaseId === null) return;
        const filter: Record<string, unknown> = {};
        if (request.query.q !== undefined) filter['q'] = { contains: request.query.q };
        if (request.query.role !== undefined) filter['role'] = { eq: request.query.role };
        if (request.query.hub !== undefined) filter['hub'] = { eq: request.query.hub };
        if (request.query.cui !== undefined) {
          const cui = normalizeCui(request.query.cui);
          if (cui === null || isWithheldOrganizationIdentifier(cui)) {
            return reply.code(400).send({
              ok: false,
              error: 'InvalidInput',
              message: 'Invalid or withheld organization identifier.',
            });
          }
          filter['cui'] = { eq: cui };
        }
        const result = await listPnrrEntities(repo, filter as FilterInput, {
          first: request.query.first ?? 20,
          ...(request.query.after !== undefined && { after: request.query.after }),
          releaseId,
        });
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        return result.isErr()
          ? sendError(reply, result.error)
          : reply.send({ ok: true, data: result.value });
      }
    );

    const registerSourcePage = <T>(
      path: string,
      read: (
        page: { first: number; after?: string },
        releaseId?: string
      ) => Promise<Result<CursorPage<T>, ApiError>>
    ): void => {
      fastify.get<{ Querystring: PnrrPageQuery }>(
        path,
        { schema: { ...schemas, querystring: PnrrPageQuerySchema } },
        async (request, reply) => {
          const releaseId = await assertRelease(repo, request.query.assertReleaseId, reply);
          if (releaseId === null) return;
          const result = await read(
            {
              first: request.query.first ?? 20,
              ...(request.query.after !== undefined && { after: request.query.after }),
            },
            releaseId
          );
          if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
          return result.isErr()
            ? sendError(reply, result.error)
            : reply.send({ ok: true, data: result.value });
        }
      );
    };

    registerSourcePage('/calls', (page, releaseId) => listPnrrFundingCalls(repo, page, releaseId));
    registerSourcePage('/applications', (page, releaseId) =>
      listPnrrFundingApplicationListings(repo, page, releaseId)
    );
    registerSourcePage('/program-revisions', (page, releaseId) =>
      listPnrrProgramRevisions(repo, page, releaseId)
    );
    registerSourcePage('/catalog-resources', (page, releaseId) =>
      listPnrrCatalogResources(repo, page, releaseId)
    );
    registerSourcePage('/documents', (page, releaseId) =>
      listPnrrDocumentReferences(repo, page, releaseId)
    );

    fastify.get<{ Params: PnrrKeyParams; Querystring: PnrrScopeQuery }>(
      '/projects/:key',
      {
        schema: {
          ...schemas,
          params: PnrrKeyParamsSchema,
          querystring: PnrrScopeQuerySchema,
        },
      },
      async (request, reply) => {
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        const result = await getPnrrProject(repo, request.params.key);
        if (result.isErr()) return sendError(reply, result.error);
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        if (result.value === null) {
          return reply.code(404).send({
            ok: false,
            error: 'NotFound',
            message: `PNRR project ${request.params.key} was not found.`,
          });
        }
        return reply.send({ ok: true, data: result.value });
      }
    );

    fastify.get<{ Params: PnrrCuiParams; Querystring: PnrrScopeQuery }>(
      '/organizations/:cui',
      {
        schema: {
          ...schemas,
          params: PnrrCuiParamsSchema,
          querystring: PnrrScopeQuerySchema,
        },
      },
      async (request, reply) => {
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        const cui = normalizeCui(request.params.cui);
        if (cui === null || isWithheldOrganizationIdentifier(cui)) {
          return reply.code(400).send({
            ok: false,
            error: 'InvalidInput',
            message: 'Invalid or withheld organization identifier.',
          });
        }
        const [entity, profile] = await Promise.all([
          getPnrrEntity(repo, cui),
          getPnrrEntityProfile(repo, cui),
        ]);
        if (entity.isErr()) return sendError(reply, entity.error);
        if (profile.isErr()) return sendError(reply, profile.error);
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        if (entity.value === null || profile.value === null) {
          return reply.code(404).send({
            ok: false,
            error: 'NotFound',
            message: `PNRR organization ${cui} was not found.`,
          });
        }
        return reply.send({
          ok: true,
          data: { entity: entity.value, profile: profile.value },
        });
      }
    );

    fastify.get<{
      Params: PnrrCountyParams;
      Querystring: PnrrScopeQuery;
    }>(
      '/counties/:siruta',
      {
        schema: {
          ...schemas,
          params: PnrrCountyParamsSchema,
          querystring: PnrrScopeQuerySchema,
        },
      },
      async (request, reply) => {
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        if (rejectInvalidScopeCui(request.query, reply)) return;
        if (rejectUnsupportedScope(request.query, reply, { allowFilters: true })) return;
        const result = await getPnrrPlaceProfile(
          repo,
          request.params.siruta,
          scopeOf(request.query, {
            grain: 'place',
            measure: 'amount',
            timeRole: 'snapshot_date',
            geographyRole: 'implementation_county',
          })
        );
        if (result.isErr()) return sendError(reply, result.error);
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        if (result.value === null) {
          return reply.code(404).send({
            ok: false,
            error: 'NotFound',
            message: `PNRR county ${request.params.siruta} was not found.`,
          });
        }
        return reply.send({ ok: true, data: result.value });
      }
    );

    fastify.get<{ Querystring: PnrrScopeQuery }>(
      '/counties',
      { schema: { ...schemas, querystring: PnrrScopeQuerySchema } },
      async (request, reply) => {
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        if (rejectInvalidScopeCui(request.query, reply)) return;
        if (rejectUnsupportedScope(request.query, reply, { allowFilters: true })) return;
        const result = await listPnrrPlaces(
          repo,
          scopeOf(request.query, {
            grain: 'place',
            measure: 'amount',
            timeRole: 'snapshot_date',
            geographyRole: 'implementation_county',
          })
        );
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        return result.isErr()
          ? sendError(reply, result.error)
          : reply.send({ ok: true, data: result.value });
      }
    );

    fastify.get<{ Querystring: PnrrScopeQuery }>(
      '/verification',
      { schema: { ...schemas, querystring: PnrrScopeQuerySchema } },
      async (request, reply) => {
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        if (rejectInvalidScopeCui(request.query, reply)) return;
        if (rejectUnsupportedScope(request.query, reply, { allowFilters: false })) return;
        const result = await getPnrrVerification(
          repo,
          scopeOf(request.query, {
            grain: 'verification',
            measure: 'count',
            timeRole: 'snapshot_date',
            geographyRole: 'implementation_county',
          })
        );
        if ((await assertRelease(repo, request.query.assertReleaseId, reply)) === null) return;
        return result.isErr()
          ? sendError(reply, result.error)
          : reply.send({ ok: true, data: result.value });
      }
    );
  };
