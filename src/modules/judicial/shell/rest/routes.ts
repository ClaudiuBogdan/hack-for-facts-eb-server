/**
 * Judicial REST (API-04) — the public GET read surface under `/api/v1/judicial`.
 *
 * Nineteen GET paths over the SAME usecases GraphQL and MCP call (Fastify adds
 * the matching HEAD). No write route, no raw body/source fetch, no new client
 * deep link. Stored decisions are served AS STORED under the scoped human
 * instruction recorded in core/types.ts; every existing case/party/hearing/
 * company/lineage/citation rule is unchanged (the usecase projections are
 * reused, never a new SELECT).
 *
 * BOUNDARY. Query strings are decoded from the ORIGINAL parsed values by each
 * route's parameter table (schemas.ts `decodeQuery`) — never by Fastify's
 * coercing/stripping AJV. Path parameters are validated by the usecases.
 * Flat filters map through the ONE transport rule table, so the operator
 * object (and its cursor identity) equals what GraphQL/MCP express.
 *
 * ENVELOPES (foundation §5.2/§14.11): success `{ ok:true, data, requestId }`
 * (+ `meta.cursor.next` — the exact repo cursor — on cursor lists); failure
 * `{ ok:false, error:<ApiError type>, message, field?, resource?, requestId }`
 * with the kernel HTTP status (400 invalid input, 404 a valid but absent
 * detail). A 5xx carries a fixed message — never a cause, SQL or driver text.
 * Every reply, errors included, is `Cache-Control: no-store` (no freshness or
 * cache contract exists yet).
 */

import { Type } from '@sinclair/typebox';

import {
  httpStatusFor,
  invalidInput,
  notFound,
  type ApiError,
  type CursorPageRequest,
} from '@/modules/shared/index.js';

import {
  CaseAggregateSchema,
  CaseCitationSchema,
  CaseDetailSchema,
  CaseLinkSchema,
  CaseSchema,
  CompanyLitigationSchema,
  CourtSchema,
  CourtTreeSchema,
  DecisionSchema,
  DecisionSubjectLinkSchema,
  IssuingBodySchema,
  LegalRefSchema,
  LineageEdgeSchema,
  PAGE_QUERY,
  ResolveHitSchema,
  decodeQuery,
  pageSuccessSchema,
  queryTableOf,
  responses,
  successSchema,
  type QueryTable,
} from './schemas.js';
import { JUDICIAL_DECISION_PAGE_DEFAULT, isJudicialDecisionPageSize } from '../../core/types.js';
import {
  getCaseDetail,
  getCaseLegalRefs,
  getCaseLineage,
  getCompanyLitigation,
  getCourtCaseload,
  getCourtTree,
  getDecision,
  getDecisionBySource,
  listCases,
  listCasesCitingAct,
  listCompanyLitigationCases,
  listCourts,
  listDecisionIssuingBodies,
  listDecisionSubjectLinks,
  listDecisions,
  resolveDecisionFilters,
  resolveJudicialFilters,
  type JudicialRepos,
} from '../../core/usecases.js';
import {
  CASE_FLAT_RULES,
  COURT_FLAT_RULES,
  DECISION_FLAT_RULES,
  DECISION_LINK_FLAT_RULES,
  flatToFilter,
} from '../filters/transport-input.js';
import { normalizeCompanyLitigationFilter } from '../repo/company-link-repo.js';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Result } from 'neverthrow';

export interface JudicialRestDeps {
  readonly repos: JudicialRepos;
}

/** The fixed 5xx message: no cause, SQL, driver or source text ever reaches a client. */
const INTERNAL_MESSAGE = 'judicial read failed; quote the requestId to report it';

// ── parameter tables ───────────────────────────────────────────────────────────

const COMPANY_QUERY: QueryTable = {
  courtLevel: 'stringList',
  category: 'stringList',
  yearFrom: 'int',
  yearTo: 'int',
};
const RESOLVE_QUERY: QueryTable = { dim: 'string', q: 'string', limit: 'int' };
const LINK_STATUS_QUERY: QueryTable = { validationStatus: 'stringList', ...PAGE_QUERY };

const QUERY = {
  courts: queryTableOf(COURT_FLAT_RULES),
  cases: queryTableOf(CASE_FLAT_RULES, { sort: 'string', dir: 'string', ...PAGE_QUERY }),
  aggregate: queryTableOf(CASE_FLAT_RULES, { groupBy: 'string' }),
  caseLookup: { institutionCode: 'string', caseNumber: 'string' } as QueryTable,
  company: COMPANY_QUERY,
  companyCases: { ...COMPANY_QUERY, ...PAGE_QUERY } as QueryTable,
  page: PAGE_QUERY,
  resolve: RESOLVE_QUERY,
  decisions: queryTableOf(DECISION_FLAT_RULES, PAGE_QUERY),
  decisionLookup: { sourceSystem: 'string', sourceRef: 'string' } as QueryTable,
  nestedLinks: LINK_STATUS_QUERY,
  reverseLinks: {
    subjectKind: 'string',
    subjectRef: 'string',
    ...LINK_STATUS_QUERY,
  } as QueryTable,
  none: {} as QueryTable,
} as const;

// ── the plugin ─────────────────────────────────────────────────────────────────

export const makeJudicialRestPlugin =
  (deps: JudicialRestDeps): FastifyPluginAsync =>
  async (fastify) => {
    const { repos } = deps;

    // No cache contract yet: every reply (errors included) is no-store.
    fastify.addHook('onSend', async (_request, reply, payload) => {
      void reply.header('cache-control', 'no-store');
      return payload;
    });

    // Anything thrown inside this scope gets the module envelope, never a
    // framework body or a 500 from response serialization.
    fastify.setErrorHandler((error, request, reply) => {
      const fault = error as { validation?: unknown; statusCode?: number };
      if (fault.validation !== undefined) {
        return reply.status(400).send({
          ok: false as const,
          error: 'InvalidInput',
          message: 'invalid request',
          requestId: request.id,
        });
      }
      request.log.error({ err: error }, '[judicial] REST route failed');
      return reply.status(500).send({
        ok: false as const,
        error: 'Database',
        message: INTERNAL_MESSAGE,
        requestId: request.id,
      });
    });

    const sendError = (request: FastifyRequest, reply: FastifyReply, error: ApiError) => {
      const status = httpStatusFor(error);
      if (status >= 500) {
        request.log.error({ err: error }, '[judicial] REST read failed');
        return reply.status(status).send({
          ok: false as const,
          error: error.type,
          message: INTERNAL_MESSAGE,
          requestId: request.id,
        });
      }
      return reply.status(status).send({
        ok: false as const,
        error: error.type,
        message: error.message,
        ...(error.type === 'InvalidInput' && error.field !== undefined && { field: error.field }),
        ...(error.type === 'NotFound' &&
          error.resource !== undefined && { resource: error.resource }),
        requestId: request.id,
      });
    };

    const sendData = (request: FastifyRequest, reply: FastifyReply, data: unknown) =>
      reply.status(200).send({ ok: true as const, data, requestId: request.id });

    const sendPage = (
      request: FastifyRequest,
      reply: FastifyReply,
      data: readonly unknown[],
      next: string | null
    ) =>
      reply
        .status(200)
        .send({ ok: true as const, data, requestId: request.id, meta: { cursor: { next } } });

    /** Send a usecase Result; `null` (a valid but absent detail) is a 404. */
    const sendResult = <T>(
      request: FastifyRequest,
      reply: FastifyReply,
      result: Result<T | null, ApiError>,
      absent?: { message: string; resource: string }
    ) => {
      if (result.isErr()) return sendError(request, reply, result.error);
      if (result.value === null && absent !== undefined) {
        return sendError(request, reply, notFound(absent.message, absent.resource));
      }
      return sendData(request, reply, result.value);
    };

    /**
     * The original page of a case-family list: `first` an integer 1..50
     * (default 20), never clamped; on failure the 400 is sent and null returned.
     */
    const pageOrError = (
      request: FastifyRequest,
      reply: FastifyReply,
      q: Readonly<Record<string, unknown>>
    ): CursorPageRequest | null => {
      const first = q['first'] ?? JUDICIAL_DECISION_PAGE_DEFAULT;
      if (!isJudicialDecisionPageSize(first)) {
        void sendError(
          request,
          reply,
          invalidInput('first must be an integer from 1 to 50', 'first')
        );
        return null;
      }
      const after = q['after'];
      return { first, ...(typeof after === 'string' && { after }) };
    };

    /** Decode a route's query; on failure the 400 is sent and null returned. */
    const query = (
      request: FastifyRequest,
      reply: FastifyReply,
      table: QueryTable
    ): Record<string, unknown> | null => {
      const decoded = decodeQuery(request.query, table);
      if (decoded.isErr()) {
        void sendError(request, reply, decoded.error);
        return null;
      }
      return decoded.value;
    };

    const param = (request: FastifyRequest, name: string): string =>
      (request.params as Record<string, string>)[name] ?? '';

    // ── courts ────────────────────────────────────────────────────────────────

    fastify.get(
      '/courts',
      { schema: { response: responses(successSchema(Type.Array(CourtSchema))) } },
      async (request, reply) => {
        const q = query(request, reply, QUERY.courts);
        if (q === null) return reply;
        return sendResult(
          request,
          reply,
          await listCourts(repos, flatToFilter(COURT_FLAT_RULES, q))
        );
      }
    );

    fastify.get(
      '/courts/:code',
      { schema: { response: responses(successSchema(CourtTreeSchema)) } },
      async (request, reply) => {
        if (query(request, reply, QUERY.none) === null) return reply;
        return sendResult(request, reply, await getCourtTree(repos, param(request, 'code')), {
          message: 'no court with that institution code',
          resource: 'court',
        });
      }
    );

    // ── cases (static paths are matched before /cases/:caseId) ───────────────

    fastify.get(
      '/cases',
      { schema: { response: responses(pageSuccessSchema(CaseSchema)) } },
      async (request, reply) => {
        const q = query(request, reply, QUERY.cases);
        if (q === null) return reply;
        const sort = q['sort'] ?? 'modifiedAt';
        if (sort !== 'modifiedAt' && sort !== 'openedAt') {
          return sendError(
            request,
            reply,
            invalidInput('sort must be modifiedAt or openedAt', 'sort')
          );
        }
        const dir = q['dir'] ?? 'DESC';
        if (dir !== 'ASC' && dir !== 'DESC') {
          return sendError(request, reply, invalidInput('dir must be ASC or DESC', 'dir'));
        }
        const page = pageOrError(request, reply, q);
        if (page === null) return reply;
        const res = await listCases(repos, {
          filter: flatToFilter(CASE_FLAT_RULES, q),
          sort,
          dir: dir === 'ASC' ? 'asc' : 'desc',
          page,
        });
        if (res.isErr()) return sendError(request, reply, res.error);
        return sendPage(
          request,
          reply,
          res.value.items.map((item) => item.node),
          res.value.next
        );
      }
    );

    fastify.get(
      '/cases/lookup',
      { schema: { response: responses(successSchema(CaseDetailSchema)) } },
      async (request, reply) => {
        const q = query(request, reply, QUERY.caseLookup);
        if (q === null) return reply;
        const institutionCode = q['institutionCode'];
        const caseNumber = q['caseNumber'];
        if (typeof institutionCode !== 'string' || typeof caseNumber !== 'string') {
          return sendError(
            request,
            reply,
            invalidInput(
              'institutionCode and caseNumber are both required',
              typeof institutionCode !== 'string' ? 'institutionCode' : 'caseNumber'
            )
          );
        }
        return sendResult(
          request,
          reply,
          await getCaseDetail(repos, { institutionCode, caseNumber }),
          { message: 'no matching case', resource: 'case' }
        );
      }
    );

    fastify.get(
      '/cases/aggregate',
      { schema: { response: responses(successSchema(CaseAggregateSchema)) } },
      async (request, reply) => {
        const q = query(request, reply, QUERY.aggregate);
        if (q === null) return reply;
        return sendResult(
          request,
          reply,
          await getCourtCaseload(repos, q['groupBy'], flatToFilter(CASE_FLAT_RULES, q))
        );
      }
    );

    fastify.get(
      '/cases/:caseId',
      { schema: { response: responses(successSchema(CaseDetailSchema)) } },
      async (request, reply) => {
        if (query(request, reply, QUERY.none) === null) return reply;
        return sendResult(
          request,
          reply,
          await getCaseDetail(repos, { caseId: param(request, 'caseId') }),
          { message: 'no case with that caseId', resource: 'case' }
        );
      }
    );

    fastify.get(
      '/cases/:caseId/legal-references',
      { schema: { response: responses(successSchema(Type.Array(LegalRefSchema))) } },
      async (request, reply) => {
        if (query(request, reply, QUERY.none) === null) return reply;
        return sendResult(request, reply, await getCaseLegalRefs(repos, param(request, 'caseId')));
      }
    );

    fastify.get(
      '/cases/:caseId/lineage',
      { schema: { response: responses(successSchema(Type.Array(LineageEdgeSchema))) } },
      async (request, reply) => {
        if (query(request, reply, QUERY.none) === null) return reply;
        return sendResult(request, reply, await getCaseLineage(repos, param(request, 'caseId')));
      }
    );

    // ── company litigation (published-only) ───────────────────────────────────

    fastify.get(
      '/companies/:cui/litigation',
      { schema: { response: responses(successSchema(CompanyLitigationSchema)) } },
      async (request, reply) => {
        const q = query(request, reply, QUERY.company);
        if (q === null) return reply;
        const filter = normalizeCompanyLitigationFilter(q);
        if (filter.isErr()) return sendError(request, reply, filter.error);
        return sendResult(
          request,
          reply,
          await getCompanyLitigation(repos, param(request, 'cui'), filter.value)
        );
      }
    );

    fastify.get(
      '/companies/:cui/cases',
      { schema: { response: responses(pageSuccessSchema(CaseLinkSchema)) } },
      async (request, reply) => {
        const q = query(request, reply, QUERY.companyCases);
        if (q === null) return reply;
        const filter = normalizeCompanyLitigationFilter(q);
        if (filter.isErr()) return sendError(request, reply, filter.error);
        const page = pageOrError(request, reply, q);
        if (page === null) return reply;
        const res = await listCompanyLitigationCases(
          repos,
          param(request, 'cui'),
          page,
          filter.value
        );
        if (res.isErr()) return sendError(request, reply, res.error);
        return sendPage(request, reply, res.value.items, res.value.next);
      }
    );

    // ── citations of one act (one item per stored citation row) ──────────────

    fastify.get(
      '/acts/:targetActId/cases',
      { schema: { response: responses(pageSuccessSchema(CaseCitationSchema)) } },
      async (request, reply) => {
        const q = query(request, reply, QUERY.page);
        if (q === null) return reply;
        const page = pageOrError(request, reply, q);
        if (page === null) return reply;
        const res = await listCasesCitingAct(repos, param(request, 'targetActId'), page);
        if (res.isErr()) return sendError(request, reply, res.error);
        return sendPage(
          request,
          reply,
          res.value.items.map((item) => item.node),
          res.value.next
        );
      }
    );

    fastify.get(
      '/filters/resolve',
      { schema: { response: responses(successSchema(Type.Array(ResolveHitSchema))) } },
      async (request, reply) => {
        const q = query(request, reply, QUERY.resolve);
        if (q === null) return reply;
        return sendResult(
          request,
          reply,
          await resolveJudicialFilters(repos, q['dim'], q['q'], q['limit'])
        );
      }
    );

    // ── stored decisions (served as stored) ───────────────────────────────────

    fastify.get(
      '/issuing-bodies',
      { schema: { response: responses(successSchema(Type.Array(IssuingBodySchema))) } },
      async (request, reply) => {
        if (query(request, reply, QUERY.none) === null) return reply;
        return sendResult(request, reply, await listDecisionIssuingBodies(repos));
      }
    );

    fastify.get(
      '/decisions',
      { schema: { response: responses(pageSuccessSchema(DecisionSchema)) } },
      async (request, reply) => {
        const q = query(request, reply, QUERY.decisions);
        if (q === null) return reply;
        const res = await listDecisions(repos, {
          filter: flatToFilter(DECISION_FLAT_RULES, q),
          first: q['first'],
          after: q['after'],
        });
        if (res.isErr()) return sendError(request, reply, res.error);
        return sendPage(
          request,
          reply,
          res.value.items.map((item) => item.node),
          res.value.next
        );
      }
    );

    fastify.get(
      '/decisions/lookup',
      { schema: { response: responses(successSchema(DecisionSchema)) } },
      async (request, reply) => {
        const q = query(request, reply, QUERY.decisionLookup);
        if (q === null) return reply;
        return sendResult(
          request,
          reply,
          await getDecisionBySource(repos, q['sourceSystem'], q['sourceRef']),
          { message: 'no decision with that source identity', resource: 'decision' }
        );
      }
    );

    fastify.get(
      '/decisions/filters/resolve',
      { schema: { response: responses(successSchema(Type.Array(ResolveHitSchema))) } },
      async (request, reply) => {
        const q = query(request, reply, QUERY.resolve);
        if (q === null) return reply;
        return sendResult(
          request,
          reply,
          await resolveDecisionFilters(repos, q['dim'], q['q'], q['limit'])
        );
      }
    );

    fastify.get(
      '/decisions/:decisionId',
      { schema: { response: responses(successSchema(DecisionSchema)) } },
      async (request, reply) => {
        if (query(request, reply, QUERY.none) === null) return reply;
        return sendResult(request, reply, await getDecision(repos, param(request, 'decisionId')), {
          message: 'no decision with that decisionId',
          resource: 'decision',
        });
      }
    );

    const sendLinks = async (
      request: FastifyRequest,
      reply: FastifyReply,
      flat: Readonly<Record<string, unknown>>
    ) => {
      const res = await listDecisionSubjectLinks(repos, {
        filter: flatToFilter(DECISION_LINK_FLAT_RULES, flat),
        first: flat['first'],
        after: flat['after'],
      });
      if (res.isErr()) return sendError(request, reply, res.error);
      return sendPage(
        request,
        reply,
        res.value.items.map((item) => item.node),
        res.value.next
      );
    };

    fastify.get(
      '/decisions/:decisionId/subject-links',
      { schema: { response: responses(pageSuccessSchema(DecisionSubjectLinkSchema)) } },
      async (request, reply) => {
        const q = query(request, reply, QUERY.nestedLinks);
        if (q === null) return reply;
        return sendLinks(request, reply, { ...q, decisionId: param(request, 'decisionId') });
      }
    );

    fastify.get(
      '/decision-subject-links',
      { schema: { response: responses(pageSuccessSchema(DecisionSubjectLinkSchema)) } },
      async (request, reply) => {
        const q = query(request, reply, QUERY.reverseLinks);
        if (q === null) return reply;
        return sendLinks(request, reply, q);
      }
    );
  };
