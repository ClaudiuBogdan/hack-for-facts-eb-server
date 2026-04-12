import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import {
  createDatabaseError as createEntityDatabaseError,
  type EntityProfileRepository,
  type EntityRepository,
} from '@/modules/entity/index.js';
import {
  makeCampaignAdminUserInteractionRoutes,
  type LearningProgressRepository,
  type ReviewDecision,
} from '@/modules/learning-progress/index.js';
import { prepareApprovedPublicDebateReviewSideEffects } from '@/modules/user-events/index.js';

import { createTestInteractiveRecord, makeFakeLearningProgressRepo } from '../fixtures/fakes.js';
import { makeInMemoryCorrespondenceRepo } from '../unit/institution-correspondence/fake-repo.js';

import type { LearningProgressRecordRow } from '@/modules/learning-progress/core/types.js';

function makeRow(
  userId: string,
  record: LearningProgressRecordRow['record'],
  updatedSeq: string
): LearningProgressRecordRow {
  return {
    userId,
    recordKey: record.key,
    record,
    auditEvents: [],
    updatedSeq,
    createdAt: record.updatedAt,
    updatedAt: record.updatedAt,
  };
}

function createDebateRequestRecord(input: {
  entityCui?: string;
  institutionEmail?: string;
  submissionPath?: 'request_platform' | 'send_yourself';
  updatedAt?: string;
  organizationName?: string | null;
}) {
  const entityCui = input.entityCui ?? '12345678';
  const updatedAt = input.updatedAt ?? '2026-04-10T10:00:00.000Z';

  return createTestInteractiveRecord({
    key: `funky:interaction:public_debate_request::entity:${entityCui}`,
    interactionId: 'funky:interaction:public_debate_request',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui },
    phase: 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          primariaEmail: input.institutionEmail ?? 'contact@primarie.ro',
          isNgo: true,
          organizationName: input.organizationName ?? 'Asociatia Test',
          ngoSenderEmail: 'ngo@example.com',
          preparedSubject: 'Sensitive prepared subject',
          legalRepresentativeName: 'Sensitive Person',
          legalRepresentativeRole: 'Sensitive Role',
          submissionPath: input.submissionPath ?? 'request_platform',
          submittedAt: updatedAt,
        },
      },
    },
    result: null,
    updatedAt,
    submittedAt: updatedAt,
  });
}

function createCityHallWebsiteRecord(input?: {
  entityCui?: string;
  updatedAt?: string;
  websiteUrl?: string;
}) {
  const entityCui = input?.entityCui ?? '12345678';
  const updatedAt = input?.updatedAt ?? '2026-04-10T10:00:00.000Z';

  return createTestInteractiveRecord({
    key: `funky:interaction:city_hall_website::entity:${entityCui}`,
    interactionId: 'funky:interaction:city_hall_website',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui },
    phase: 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          websiteUrl: input?.websiteUrl ?? 'https://primarie.test',
        },
      },
    },
    result: null,
    updatedAt,
    submittedAt: updatedAt,
  });
}

function createBudgetDocumentRecord(input?: {
  entityCui?: string;
  updatedAt?: string;
  documentUrl?: string;
  documentTypes?: readonly ('pdf' | 'word' | 'excel' | 'webpage' | 'graphics' | 'other')[];
}) {
  const entityCui = input?.entityCui ?? '12345678';
  const updatedAt = input?.updatedAt ?? '2026-04-10T10:00:00.000Z';

  return createTestInteractiveRecord({
    key: `funky:interaction:budget_document::entity:${entityCui}`,
    interactionId: 'funky:interaction:budget_document',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui },
    phase: 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          documentUrl: input?.documentUrl ?? 'https://primarie.test/buget.pdf',
          documentTypes: input?.documentTypes ?? ['pdf'],
          submittedAt: updatedAt,
        },
      },
    },
    result: null,
    updatedAt,
    submittedAt: updatedAt,
  });
}

function createBudgetPublicationDateRecord(input?: {
  entityCui?: string;
  updatedAt?: string;
  publicationDate?: string | null;
}) {
  const entityCui = input?.entityCui ?? '12345678';
  const updatedAt = input?.updatedAt ?? '2026-04-10T10:00:00.000Z';

  return createTestInteractiveRecord({
    key: `funky:interaction:budget_publication_date::entity:${entityCui}`,
    interactionId: 'funky:interaction:budget_publication_date',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui },
    phase: 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          publicationDate: input?.publicationDate ?? '2026-02-15',
          sources: [
            {
              type: 'website',
              url: 'https://primarie.test/anunt',
            },
          ],
          submittedAt: updatedAt,
        },
      },
    },
    result: null,
    updatedAt,
    submittedAt: updatedAt,
  });
}

function createBudgetStatusRecord(input?: {
  entityCui?: string;
  updatedAt?: string;
  isPublished?: 'yes' | 'no' | 'dont_know' | null;
  budgetStage?: 'draft' | 'approved' | null;
}) {
  const entityCui = input?.entityCui ?? '12345678';
  const updatedAt = input?.updatedAt ?? '2026-04-10T10:00:00.000Z';

  return createTestInteractiveRecord({
    key: `funky:interaction:budget_status::entity:${entityCui}`,
    interactionId: 'funky:interaction:budget_status',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui },
    phase: 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          isPublished: input?.isPublished ?? 'yes',
          budgetStage: input?.budgetStage ?? 'draft',
          submittedAt: updatedAt,
        },
      },
    },
    result: null,
    updatedAt,
    submittedAt: updatedAt,
  });
}

function createCityHallContactRecord(input?: {
  entityCui?: string;
  updatedAt?: string;
  email?: string | null;
  phone?: string | null;
}) {
  const entityCui = input?.entityCui ?? '12345678';
  const updatedAt = input?.updatedAt ?? '2026-04-10T10:00:00.000Z';

  return createTestInteractiveRecord({
    key: `funky:interaction:city_hall_contact::entity:${entityCui}`,
    interactionId: 'funky:interaction:city_hall_contact',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui },
    phase: 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          email: input?.email ?? 'contact@primarie.ro',
          phone: input?.phone ?? '+40 123 456 789',
          submittedAt: updatedAt,
        },
      },
    },
    result: null,
    updatedAt,
    submittedAt: updatedAt,
  });
}

function createParticipationReportRecord(input?: { entityCui?: string; updatedAt?: string }) {
  const entityCui = input?.entityCui ?? '12345678';
  const updatedAt = input?.updatedAt ?? '2026-04-10T10:00:00.000Z';

  return createTestInteractiveRecord({
    key: `funky:interaction:funky_participation::entity:${entityCui}`,
    interactionId: 'funky:interaction:funky_participation',
    lessonId: 'civic-participate-and-act',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui },
    phase: 'resolved',
    value: {
      kind: 'json',
      json: {
        value: {
          debateTookPlace: 'yes',
          approximateAttendees: 42,
          citizensAllowedToSpeak: 'partially',
          citizenInputsRecorded: 'yes',
          observations: 'Citizens raised multiple budget priorities.',
          submittedAt: updatedAt,
        },
      },
    },
    result: null,
    updatedAt,
    submittedAt: updatedAt,
  });
}

function createBudgetContestationRecord(input?: {
  entityCui?: string;
  updatedAt?: string;
  submissionPath?: 'send_email' | 'download_text' | null;
}) {
  const entityCui = input?.entityCui ?? '12345678';
  const updatedAt = input?.updatedAt ?? '2026-04-10T10:00:00.000Z';

  return createTestInteractiveRecord({
    key: `funky:interaction:budget_contestation::entity:${entityCui}`,
    interactionId: 'funky:interaction:budget_contestation',
    lessonId: 'civic-participate-and-act',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui },
    phase: 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          contestedItem: 'Chapter 65 personnel expenses',
          reasoning: 'The increase is disproportionate to the proposed investment cuts.',
          impact: 'Community services would lose funding.',
          proposedChange: 'Rebalance the increase toward infrastructure.',
          senderName: 'Asociatia Test',
          submissionPath: input?.submissionPath ?? 'send_email',
          primariaEmail: 'contact@primarie.ro',
          submittedAt: updatedAt,
        },
      },
    },
    result: null,
    updatedAt,
    submittedAt: updatedAt,
  });
}

function createQuizRecord(input?: {
  interactionId?: string;
  lessonId?: string;
  updatedAt?: string;
  selectedOptionId?: string | null;
  outcome?: 'correct' | 'incorrect' | null;
  score?: number | null;
  phase?: 'idle' | 'draft' | 'pending' | 'resolved' | 'failed';
}) {
  const interactionId = input?.interactionId ?? 'ch-civic-03-why-check-q1';
  const updatedAt = input?.updatedAt ?? '2026-04-10T10:00:00.000Z';

  return createTestInteractiveRecord({
    key: `${interactionId}::global`,
    interactionId,
    lessonId: input?.lessonId ?? 'ch-civic-03-budget-status-2026',
    kind: 'quiz',
    completionRule: { type: 'outcome', outcome: 'correct' },
    scope: { type: 'global' },
    phase: input?.phase ?? 'resolved',
    value:
      input?.selectedOptionId === undefined
        ? {
            kind: 'choice',
            choice: { selectedId: 'b' },
          }
        : input.selectedOptionId === null
          ? null
          : {
              kind: 'choice',
              choice: { selectedId: input.selectedOptionId },
            },
    result:
      input?.outcome === undefined
        ? {
            outcome: 'correct',
            score: 100,
            evaluatedAt: updatedAt,
          }
        : {
            outcome: input.outcome,
            score: input.score ?? null,
            evaluatedAt: updatedAt,
          },
    updatedAt,
    submittedAt: updatedAt,
  });
}

function makeTestEntityProfileRepo(
  officialEmails: Record<string, string | null>
): EntityProfileRepository {
  return {
    async getByEntityCui(entityCui) {
      return ok({
        institution_type: null,
        website_url: null,
        official_email: officialEmails[entityCui] ?? null,
        phone_primary: null,
        address_raw: null,
        address_locality: null,
        county_code: null,
        county_name: null,
        leader_name: null,
        leader_title: null,
        leader_party: null,
        scraped_at: '2026-04-10T10:00:00.000Z',
        extraction_confidence: null,
      });
    },
    async getByEntityCuis(entityCuis) {
      return ok(
        new Map(
          entityCuis.map((entityCui) => [
            entityCui,
            {
              institution_type: null,
              website_url: null,
              official_email: officialEmails[entityCui] ?? null,
              phone_primary: null,
              address_raw: null,
              address_locality: null,
              county_code: null,
              county_name: null,
              leader_name: null,
              leader_title: null,
              leader_party: null,
              scraped_at: '2026-04-10T10:00:00.000Z',
              extraction_confidence: null,
            },
          ])
        )
      );
    },
  };
}

function makeTestEntityRepo(entityName = 'Oras Test'): EntityRepository {
  return {
    async getById(cui) {
      return ok({
        cui,
        name: entityName,
        entity_type: null,
        default_report_type: 'Executie bugetara detaliata',
        uat_id: null,
        is_uat: true,
        address: null,
        last_updated: null,
        main_creditor_1_cui: null,
        main_creditor_2_cui: null,
      });
    },
    async getByIds(cuis) {
      return ok(
        new Map(
          cuis.map((cui) => [
            cui,
            {
              cui,
              name: entityName,
              entity_type: null,
              default_report_type: 'Executie bugetara detaliata',
              uat_id: null,
              is_uat: true,
              address: null,
              last_updated: null,
              main_creditor_1_cui: null,
              main_creditor_2_cui: null,
            },
          ])
        )
      );
    },
    async getAll() {
      return ok({
        nodes: [],
        pageInfo: {
          totalCount: 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      });
    },
    async getChildren() {
      return ok([]);
    },
    async getParents() {
      return ok([]);
    },
    async getCountyEntity() {
      return ok(null);
    },
  };
}

function createPublicDebateApprovalHook(input: {
  learningProgressRepo: LearningProgressRepository;
  entityProfileRepo: EntityProfileRepository;
  correspondenceRepo?: ReturnType<typeof makeInMemoryCorrespondenceRepo>;
  sentEmails?: unknown[];
  sendError?: boolean;
  failSendAttempts?: number;
}) {
  const correspondenceRepo = input.correspondenceRepo ?? makeInMemoryCorrespondenceRepo();
  let sendAttempts = 0;

  return {
    correspondenceRepo,
    prepareApproveReviews: async (reviewInput: { items: readonly ReviewDecision[] }) => {
      return prepareApprovedPublicDebateReviewSideEffects(
        {
          learningProgressRepo: input.learningProgressRepo,
          entityRepo: makeTestEntityRepo(),
          entityProfileRepo: input.entityProfileRepo,
          repo: correspondenceRepo,
          emailSender: {
            getFromAddress() {
              return 'noreply@transparenta.eu';
            },
            async send(params) {
              input.sentEmails?.push(params);
              sendAttempts += 1;
              if (
                input.sendError === true ||
                (input.failSendAttempts !== undefined && sendAttempts <= input.failSendAttempts)
              ) {
                return err({
                  type: 'SERVER' as const,
                  message: 'Provider send failed',
                  retryable: true,
                });
              }

              return ok({ emailId: `email-${String(input.sentEmails?.length ?? 1)}` });
            },
          },
          templateRenderer: {
            renderPublicDebateRequest(renderInput) {
              return {
                subject: `Public debate [teu:${renderInput.threadKey}]`,
                text: `Text for ${renderInput.institutionEmail}`,
                html: `<p>${renderInput.institutionEmail}</p>`,
              };
            },
          },
          auditCcRecipients: ['audit@transparenta.test'],
          platformBaseUrl: 'https://transparenta.test',
          captureAddress: 'debate@transparenta.test',
        },
        reviewInput
      );
    },
  };
}

const createTestApp = async (options?: {
  learningProgressRepo?: LearningProgressRepository;
  permissionAllowed?: boolean;
  entityRepo?: EntityRepository;
  entityProfileRepo?: EntityProfileRepository;
  prepareApproveReviews?: (input: {
    items: readonly ReviewDecision[];
  }) => ReturnType<typeof prepareApprovedPublicDebateReviewSideEffects>;
}) => {
  const testAuth = createTestAuthProvider();
  const app = fastifyLib({ logger: false });

  app.setErrorHandler((err, _request, reply) => {
    const error = err as { statusCode?: number; code?: string; name?: string; message?: string };
    const statusCode = error.statusCode ?? 500;
    void reply.status(statusCode).send({
      ok: false,
      error: error.code ?? error.name ?? 'Error',
      message: error.message ?? 'An error occurred',
      retryable: false,
    });
  });

  app.addHook('preHandler', makeAuthMiddleware({ authProvider: testAuth.provider }));

  const permissionAuthorizer = {
    hasPermission: vi.fn(async () => options?.permissionAllowed ?? true),
  };

  await app.register(
    makeCampaignAdminUserInteractionRoutes({
      learningProgressRepo: options?.learningProgressRepo ?? makeFakeLearningProgressRepo(),
      entityRepo: options?.entityRepo ?? makeTestEntityRepo(),
      entityProfileRepo:
        options?.entityProfileRepo ??
        makeTestEntityProfileRepo({ '12345678': 'contact@primarie.ro' }),
      enabledCampaignKeys: ['funky'],
      permissionAuthorizer,
      ...(options?.prepareApproveReviews !== undefined
        ? { prepareApproveReviews: options.prepareApproveReviews }
        : {}),
    })
  );

  await app.ready();
  return { app, testAuth, permissionAuthorizer };
};

const EXPECTED_AVAILABLE_INTERACTION_TYPES = [
  {
    interactionId: 'funky:interaction:public_debate_request',
    label: 'Public debate request',
    reviewable: true,
  },
  {
    interactionId: 'funky:interaction:city_hall_website',
    label: 'City hall website',
    reviewable: true,
  },
  {
    interactionId: 'funky:interaction:budget_document',
    label: 'Budget document',
    reviewable: true,
  },
  {
    interactionId: 'funky:interaction:budget_publication_date',
    label: 'Budget publication date',
    reviewable: true,
  },
  {
    interactionId: 'funky:interaction:budget_status',
    label: 'Budget status',
    reviewable: true,
  },
  {
    interactionId: 'funky:interaction:city_hall_contact',
    label: 'City hall contact',
    reviewable: true,
  },
  {
    interactionId: 'funky:interaction:funky_participation',
    label: 'Participation report',
    reviewable: false,
  },
  {
    interactionId: 'funky:interaction:budget_contestation',
    label: 'Budget contestation',
    reviewable: true,
  },
  {
    interactionId: 'ch-civic-01-how-module-works-q1',
    label: 'Quiz: Module structure',
    reviewable: false,
  },
  {
    interactionId: 'ch-civic-01-why-budget-matters-q1',
    label: 'Quiz: Why the local budget matters',
    reviewable: false,
  },
  {
    interactionId: 'ch-civic-01-what-campaign-is-q1',
    label: 'Quiz: Budget consultation actions',
    reviewable: false,
  },
  {
    interactionId: 'ch-civic-02-cycle-q1',
    label: 'Quiz: Budget proposer',
    reviewable: false,
  },
  {
    interactionId: 'ch-civic-02-deadlines-q1',
    label: 'Quiz: Contestation deadline',
    reviewable: false,
  },
  {
    interactionId: 'ch-civic-02-rights-q1',
    label: 'Quiz: Right to a public debate',
    reviewable: false,
  },
  {
    interactionId: 'ch-civic-03-why-check-q1',
    label: 'Quiz: Why budget status matters',
    reviewable: false,
  },
  {
    interactionId: 'ch-civic-04-why-debate-q1',
    label: 'Quiz: Why request a debate',
    reviewable: false,
  },
  {
    interactionId: 'ch-civic-04-next-steps-q1',
    label: 'Quiz: Debate request follow-up',
    reviewable: false,
  },
  {
    interactionId: 'ch-civic-05-preparation-q1',
    label: 'Quiz: Debate preparation',
    reviewable: false,
  },
  {
    interactionId: 'ch-civic-06-when-contest-q1',
    label: 'Quiz: What makes a contestation effective',
    reviewable: false,
  },
] as const;

describe('Campaign Admin User Interactions REST API', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    if (app != null) {
      await app.close();
    }
  });

  beforeEach(async () => {
    if (app != null) {
      await app.close();
    }
  });

  it('returns 401 when authentication is missing', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions',
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 403 when the authenticated user lacks campaign-admin permission', async () => {
    const learningProgressRepo = makeFakeLearningProgressRepo();
    const listRowsSpy = vi.spyOn(learningProgressRepo, 'listCampaignAdminInteractionRows');
    const setup = await createTestApp({
      permissionAllowed: false,
      learningProgressRepo,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ForbiddenError',
      message: 'You do not have permission to access this campaign interaction audit',
      retryable: false,
    });
    expect(setup.permissionAuthorizer.hasPermission).toHaveBeenCalledWith({
      userId: 'user_test_1',
      permissionName: 'campaign:funky_admin',
    });
    expect(listRowsSpy).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown campaign queues', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/unknown/user-interactions',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns campaign-admin interaction metadata for the selector', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        availableInteractionTypes: EXPECTED_AVAILABLE_INTERACTION_TYPES,
        stats: {
          total: 0,
          riskFlagged: 0,
          withInstitutionThread: 0,
          reviewStatusCounts: {
            pending: 0,
            approved: 0,
            rejected: 0,
            notReviewed: 0,
          },
          phaseCounts: {
            idle: 0,
            draft: 0,
            pending: 0,
            resolved: 0,
            failed: 0,
          },
          threadPhaseCounts: {
            sending: 0,
            awaiting_reply: 0,
            reply_received_unreviewed: 0,
            manual_follow_up_needed: 0,
            resolved_positive: 0,
            resolved_negative: 0,
            closed_no_response: 0,
            failed: 0,
            none: 0,
          },
        },
      },
    });
  });

  it('returns campaign-wide stats in metadata independent of the current page', async () => {
    const pendingInvalidEmailRecord = createDebateRequestRecord({
      entityCui: '12345678',
      institutionEmail: 'invalid-email',
      updatedAt: '2026-04-10T11:00:00.000Z',
    });
    const approvedWithFailedThreadRecord = {
      ...createDebateRequestRecord({
        entityCui: '87654321',
        institutionEmail: 'contact@primarie-2.ro',
        updatedAt: '2026-04-10T10:00:00.000Z',
      }),
      phase: 'resolved' as const,
      review: {
        status: 'approved' as const,
        reviewedAt: '2026-04-10T10:30:00.000Z',
      },
    };
    const rejectedWebsiteRecord = {
      ...createCityHallWebsiteRecord({
        entityCui: '11111111',
        updatedAt: '2026-04-10T09:00:00.000Z',
      }),
      phase: 'failed' as const,
      review: {
        status: 'rejected' as const,
        reviewedAt: '2026-04-10T09:30:00.000Z',
      },
    };
    const draftWebsiteRecord = {
      ...createCityHallWebsiteRecord({
        entityCui: '22222222',
        updatedAt: '2026-04-10T08:00:00.000Z',
      }),
      phase: 'draft' as const,
      submittedAt: null,
    };

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', pendingInvalidEmailRecord, '1')]);
    initialRecords.set('user-2', [makeRow('user-2', approvedWithFailedThreadRecord, '2')]);
    initialRecords.set('user-3', [makeRow('user-3', rejectedWebsiteRecord, '3')]);
    initialRecords.set('user-4', [makeRow('user-4', draftWebsiteRecord, '4')]);

    const campaignAdminThreadSummaries = new Map([
      [
        'funky::87654321',
        {
          threadId: 'thread-1',
          threadPhase: 'failed' as const,
          lastEmailAt: '2026-04-10T10:15:00.000Z',
          lastReplyAt: null,
          nextActionAt: '2026-04-10T11:00:00.000Z',
        },
      ],
    ]);

    const repo = makeFakeLearningProgressRepo({
      initialRecords,
      campaignAdminThreadSummaries,
    });
    const setup = await createTestApp({
      learningProgressRepo: repo,
      entityProfileRepo: makeTestEntityProfileRepo({
        '12345678': 'contact@primarie.ro',
        '87654321': 'contact@primarie-2.ro',
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        availableInteractionTypes: EXPECTED_AVAILABLE_INTERACTION_TYPES,
        stats: {
          total: 4,
          riskFlagged: 2,
          withInstitutionThread: 1,
          reviewStatusCounts: {
            pending: 1,
            approved: 1,
            rejected: 1,
            notReviewed: 1,
          },
          phaseCounts: {
            idle: 0,
            draft: 1,
            pending: 1,
            resolved: 1,
            failed: 1,
          },
          threadPhaseCounts: {
            sending: 0,
            awaiting_reply: 0,
            reply_received_unreviewed: 0,
            manual_follow_up_needed: 0,
            resolved_positive: 0,
            resolved_negative: 0,
            closed_no_response: 0,
            failed: 1,
            none: 3,
          },
        },
      },
    });
  });

  it('degrades risk stats gracefully when official-email enrichment fails', async () => {
    const mismatchRecord = createDebateRequestRecord({
      entityCui: '12345678',
      institutionEmail: 'mismatch@primarie.ro',
      updatedAt: '2026-04-10T11:00:00.000Z',
    });
    const invalidEmailRecord = createDebateRequestRecord({
      entityCui: '87654321',
      institutionEmail: 'invalid-email',
      updatedAt: '2026-04-10T10:00:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', mismatchRecord, '1')]);
    initialRecords.set('user-2', [makeRow('user-2', invalidEmailRecord, '2')]);

    const failingEntityProfileRepo: EntityProfileRepository = {
      async getByEntityCui() {
        return err(createEntityDatabaseError('Failed to load entity profile'));
      },
      async getByEntityCuis() {
        return err(createEntityDatabaseError('Failed to load entity profiles'));
      },
    };

    const setup = await createTestApp({
      learningProgressRepo: makeFakeLearningProgressRepo({ initialRecords }),
      entityProfileRepo: failingEntityProfileRepo,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        availableInteractionTypes: EXPECTED_AVAILABLE_INTERACTION_TYPES,
        stats: {
          total: 2,
          riskFlagged: 1,
          withInstitutionThread: 0,
          reviewStatusCounts: {
            pending: 2,
            approved: 0,
            rejected: 0,
            notReviewed: 0,
          },
          phaseCounts: {
            idle: 0,
            draft: 0,
            pending: 2,
            resolved: 0,
            failed: 0,
          },
          threadPhaseCounts: {
            sending: 0,
            awaiting_reply: 0,
            reply_received_unreviewed: 0,
            manual_follow_up_needed: 0,
            resolved_positive: 0,
            resolved_negative: 0,
            closed_no_response: 0,
            failed: 0,
            none: 2,
          },
        },
      },
    });
  });

  it('lists multiple pending reviewable interaction types when interactionId is omitted', async () => {
    const publicDebateRecord = createDebateRequestRecord({
      entityCui: '12345678',
      updatedAt: '2026-04-10T11:00:00.000Z',
    });
    const cityHallWebsiteRecord = createCityHallWebsiteRecord({
      entityCui: '87654321',
      updatedAt: '2026-04-10T10:00:00.000Z',
      websiteUrl: 'https://primarie-2.test',
    });
    const approvedRecord = createDebateRequestRecord({
      entityCui: '99999999',
      updatedAt: '2026-04-10T09:00:00.000Z',
    });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', publicDebateRecord, '1')]);
    initialRecords.set('user-2', [makeRow('user-2', cityHallWebsiteRecord, '2')]);
    initialRecords.set('user-3', [
      makeRow(
        'user-3',
        {
          ...approvedRecord,
          phase: 'resolved',
          review: {
            status: 'approved',
            reviewedAt: '2026-04-10T09:00:00.000Z',
          },
        },
        '3'
      ),
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const setup = await createTestApp({ learningProgressRepo: repo });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions?reviewStatus=pending',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            recordKey: publicDebateRecord.key,
            interactionId: 'funky:interaction:public_debate_request',
            entityName: 'Oras Test',
            interactionElementLink:
              '/primarie/12345678/buget/provocari/civic-campaign/civic-monitor-and-request/04-debate-request',
            submissionPath: 'request_platform',
            pendingReason: 'awaiting_manual_review',
            websiteUrl: null,
          }),
          expect.objectContaining({
            recordKey: cityHallWebsiteRecord.key,
            interactionId: 'funky:interaction:city_hall_website',
            entityName: 'Oras Test',
            interactionElementLink:
              '/primarie/87654321/buget/provocari/civic-campaign/civic-monitor-and-request/03-budget-status-2026',
            websiteUrl: 'https://primarie-2.test',
            institutionEmail: null,
            submissionPath: null,
            pendingReason: 'awaiting_manual_review',
            riskFlags: [],
            threadId: null,
          }),
        ],
        page: {
          limit: 50,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
  });

  it('lists campaign-wide audit rows with safe summaries for non-debate interactions', async () => {
    const websiteRecord = createCityHallWebsiteRecord({
      entityCui: '10000001',
      updatedAt: '2026-04-10T16:00:00.000Z',
      websiteUrl: 'https://primarie-website.test',
    });
    const documentRecord = createBudgetDocumentRecord({
      entityCui: '10000002',
      updatedAt: '2026-04-10T15:00:00.000Z',
      documentTypes: ['pdf', 'excel'],
    });
    const publicationDateRecord = createBudgetPublicationDateRecord({
      entityCui: '10000003',
      updatedAt: '2026-04-10T14:00:00.000Z',
      publicationDate: '2026-02-20',
    });
    const statusRecord = createBudgetStatusRecord({
      entityCui: '10000004',
      updatedAt: '2026-04-10T13:00:00.000Z',
      isPublished: 'yes',
      budgetStage: 'approved',
    });
    const contactRecord = createCityHallContactRecord({
      entityCui: '10000005',
      updatedAt: '2026-04-10T12:00:00.000Z',
      email: 'contact@primarie-contact.test',
      phone: '+40 321 654 987',
    });
    const participationRecord = createParticipationReportRecord({
      entityCui: '10000006',
      updatedAt: '2026-04-10T11:00:00.000Z',
    });
    const contestationRecord = createBudgetContestationRecord({
      entityCui: '10000007',
      updatedAt: '2026-04-10T10:00:00.000Z',
      submissionPath: 'send_email',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', websiteRecord, '1')]);
    initialRecords.set('user-2', [makeRow('user-2', documentRecord, '2')]);
    initialRecords.set('user-3', [makeRow('user-3', publicationDateRecord, '3')]);
    initialRecords.set('user-4', [makeRow('user-4', statusRecord, '4')]);
    initialRecords.set('user-5', [makeRow('user-5', contactRecord, '5')]);
    initialRecords.set('user-6', [makeRow('user-6', participationRecord, '6')]);
    initialRecords.set('user-7', [makeRow('user-7', contestationRecord, '7')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const setup = await createTestApp({ learningProgressRepo: repo });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      ok: boolean;
      data: {
        items: Record<string, unknown>[];
        page: { limit: number; hasMore: boolean; nextCursor: string | null };
      };
    }>();

    expect(body.ok).toBe(true);
    expect(body.data.page).toEqual({
      limit: 50,
      hasMore: false,
      nextCursor: null,
    });
    expect(body.data.items).toHaveLength(7);

    const itemsByRecordKey = new Map(
      body.data.items.map((item) => [String(item['recordKey']), item] as const)
    );

    expect(itemsByRecordKey.get(websiteRecord.key)).toMatchObject({
      interactionId: 'funky:interaction:city_hall_website',
      reviewable: true,
      interactionElementLink:
        '/primarie/10000001/buget/provocari/civic-campaign/civic-monitor-and-request/03-budget-status-2026',
      payloadSummary: {
        kind: 'website_url',
        websiteUrl: 'https://primarie-website.test',
      },
    });
    expect(itemsByRecordKey.get(documentRecord.key)).toMatchObject({
      interactionId: 'funky:interaction:budget_document',
      reviewable: true,
      payloadSummary: {
        kind: 'budget_document',
        documentUrl: 'https://primarie.test/buget.pdf',
        documentTypes: ['pdf', 'excel'],
      },
    });
    expect(itemsByRecordKey.get(publicationDateRecord.key)).toMatchObject({
      interactionId: 'funky:interaction:budget_publication_date',
      reviewable: true,
      payloadSummary: {
        kind: 'budget_publication_date',
        publicationDate: '2026-02-20',
        sources: [{ type: 'website', url: 'https://primarie.test/anunt' }],
      },
    });
    expect(itemsByRecordKey.get(statusRecord.key)).toMatchObject({
      interactionId: 'funky:interaction:budget_status',
      reviewable: true,
      payloadSummary: {
        kind: 'budget_status',
        isPublished: 'yes',
        budgetStage: 'approved',
      },
    });
    expect(itemsByRecordKey.get(contactRecord.key)).toMatchObject({
      interactionId: 'funky:interaction:city_hall_contact',
      reviewable: true,
      payloadSummary: {
        kind: 'city_hall_contact',
        email: 'contact@primarie-contact.test',
        phone: '+40 321 654 987',
      },
    });
    expect(itemsByRecordKey.get(participationRecord.key)).toMatchObject({
      interactionId: 'funky:interaction:funky_participation',
      reviewable: false,
      reviewStatus: null,
      payloadSummary: {
        kind: 'participation_report',
        debateTookPlace: 'yes',
        approximateAttendees: 42,
        citizensAllowedToSpeak: 'partially',
        citizenInputsRecorded: 'yes',
        observations: 'Citizens raised multiple budget priorities.',
      },
    });
    expect(itemsByRecordKey.get(contestationRecord.key)).toMatchObject({
      interactionId: 'funky:interaction:budget_contestation',
      reviewable: true,
      institutionEmail: 'contact@primarie.ro',
      submissionPath: 'send_email',
      payloadSummary: {
        kind: 'contestation',
        contestedItem: 'Chapter 65 personnel expenses',
        reasoning: 'The increase is disproportionate to the proposed investment cuts.',
        impact: 'Community services would lose funding.',
        proposedChange: 'Rebalance the increase toward infrastructure.',
        senderName: 'Asociatia Test',
        submissionPath: 'send_email',
        institutionEmail: 'contact@primarie.ro',
      },
    });

    for (const item of body.data.items) {
      expect(item).not.toHaveProperty('record');
      expect(item).not.toHaveProperty('auditEvents');
    }
  });

  it('filters the queue by a single configured interactionId', async () => {
    const publicDebateRecord = createDebateRequestRecord({
      entityCui: '12345678',
      updatedAt: '2026-04-10T11:00:00.000Z',
    });
    const cityHallWebsiteRecord = createCityHallWebsiteRecord({
      entityCui: '87654321',
      updatedAt: '2026-04-10T10:00:00.000Z',
      websiteUrl: 'https://primarie-2.test',
    });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', publicDebateRecord, '1')]);
    initialRecords.set('user-2', [makeRow('user-2', cityHallWebsiteRecord, '2')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const setup = await createTestApp({ learningProgressRepo: repo });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions?reviewStatus=pending&interactionId=funky:interaction:city_hall_website',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            recordKey: cityHallWebsiteRecord.key,
            interactionId: 'funky:interaction:city_hall_website',
            entityName: 'Oras Test',
            interactionElementLink:
              '/primarie/87654321/buget/provocari/civic-campaign/civic-monitor-and-request/03-budget-status-2026',
            websiteUrl: 'https://primarie-2.test',
            pendingReason: 'awaiting_manual_review',
          }),
        ],
        page: {
          limit: 50,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
  });

  it('includes persisted civic quiz rows in the audit list with minimized summaries', async () => {
    const quizRecord = createQuizRecord({
      interactionId: 'ch-civic-04-why-debate-q1',
      lessonId: 'ch-civic-04-debate-request',
      updatedAt: '2026-04-10T11:00:00.000Z',
      selectedOptionId: 'b',
      outcome: 'correct',
      score: 100,
      phase: 'resolved',
    });
    const websiteRecord = createCityHallWebsiteRecord({
      entityCui: '87654321',
      updatedAt: '2026-04-10T10:00:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', quizRecord, '1')]);
    initialRecords.set('user-2', [makeRow('user-2', websiteRecord, '2')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const setup = await createTestApp({ learningProgressRepo: repo });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions?interactionId=ch-civic-04-why-debate-q1',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            recordKey: quizRecord.key,
            interactionId: 'ch-civic-04-why-debate-q1',
            lessonId: 'ch-civic-04-debate-request',
            scopeType: 'global',
            entityCui: null,
            entityName: null,
            reviewable: false,
            reviewStatus: null,
            interactionElementLink: null,
            payloadKind: 'choice',
            payloadSummary: {
              kind: 'quiz',
              selectedOptionId: 'b',
              outcome: 'correct',
              score: 100,
            },
          }),
        ],
        page: {
          limit: 50,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
  });

  it('supports generic submissionPath filters for contestation rows', async () => {
    const contestationRecord = createBudgetContestationRecord({
      entityCui: '12345678',
      updatedAt: '2026-04-10T11:00:00.000Z',
      submissionPath: 'send_email',
    });
    const debateRecord = createDebateRequestRecord({
      entityCui: '87654321',
      updatedAt: '2026-04-10T10:00:00.000Z',
      submissionPath: 'request_platform',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', contestationRecord, '1')]);
    initialRecords.set('user-2', [makeRow('user-2', debateRecord, '2')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const setup = await createTestApp({ learningProgressRepo: repo });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions?submissionPath=send_email',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            recordKey: contestationRecord.key,
            interactionId: 'funky:interaction:budget_contestation',
            reviewable: true,
            submissionPath: 'send_email',
          }),
        ],
        page: {
          limit: 50,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
  });

  it('lists safe flattened public-debate items, excludes non-allowlisted records, and supports keyset pagination', async () => {
    const firstRecord = createDebateRequestRecord({
      entityCui: '12345678',
      institutionEmail: 'wrong@primarie.ro',
      updatedAt: '2026-04-10T11:00:00.000Z',
    });
    const secondRecord = createDebateRequestRecord({
      entityCui: '87654321',
      institutionEmail: 'contact@primarie2.ro',
      updatedAt: '2026-04-10T10:00:00.000Z',
    });
    const otherRecord = createTestInteractiveRecord({
      key: 'other:interaction::global',
      interactionId: 'other:interaction',
      lessonId: 'lesson-other',
      phase: 'pending',
      updatedAt: '2026-04-10T12:00:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      makeRow('user-1', firstRecord, '1'),
      makeRow('user-1', otherRecord, '2'),
    ]);
    initialRecords.set('user-2', [makeRow('user-2', secondRecord, '3')]);

    const repo = makeFakeLearningProgressRepo({
      initialRecords,
      campaignAdminThreadSummaries: new Map([
        [
          'funky::12345678',
          {
            threadId: 'thread-1',
            threadPhase: 'failed',
            lastEmailAt: '2026-04-10T11:05:00.000Z',
            lastReplyAt: null,
            nextActionAt: null,
          },
        ],
      ]),
    });

    const setup = await createTestApp({
      learningProgressRepo: repo,
      entityProfileRepo: makeTestEntityProfileRepo({
        '12345678': 'official@primarie.ro',
        '87654321': 'contact@primarie2.ro',
      }),
    });
    app = setup.app;

    const firstResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions?limit=1',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    const firstBody = firstResponse.json<{
      ok: boolean;
      data: {
        items: Record<string, unknown>[];
        page: { limit: number; hasMore: boolean; nextCursor: string | null };
      };
    }>();

    expect(firstBody.ok).toBe(true);
    expect(firstBody.data.items).toHaveLength(1);
    expect(firstBody.data.items[0]).toMatchObject({
      userId: 'user-1',
      recordKey: firstRecord.key,
      interactionId: 'funky:interaction:public_debate_request',
      entityName: 'Oras Test',
      interactionElementLink:
        '/primarie/12345678/buget/provocari/civic-campaign/civic-monitor-and-request/04-debate-request',
      institutionEmail: 'wrong@primarie.ro',
      submissionPath: 'request_platform',
      riskFlags: ['institution_email_mismatch', 'institution_thread_failed'],
      pendingReason: 'institution_email_mismatch',
      threadId: 'thread-1',
      threadPhase: 'failed',
    });
    expect(firstBody.data.items[0]).not.toHaveProperty('record');
    expect(firstBody.data.items[0]).not.toHaveProperty('auditEvents');
    expect(firstBody.data.items[0]).not.toHaveProperty('preparedSubject');
    expect(firstBody.data.items[0]).not.toHaveProperty('legalRepresentativeName');
    expect(firstBody.data.page.hasMore).toBe(true);
    expect(firstBody.data.page.nextCursor).not.toBeNull();

    const secondPageQuery = new URLSearchParams({
      limit: '1',
      cursor: firstBody.data.page.nextCursor ?? '',
    });

    const secondResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/campaigns/funky/user-interactions?${secondPageQuery.toString()}`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            userId: 'user-2',
            recordKey: secondRecord.key,
            entityName: 'Oras Test',
            interactionElementLink:
              '/primarie/87654321/buget/provocari/civic-campaign/civic-monitor-and-request/04-debate-request',
            institutionEmail: 'contact@primarie2.ro',
            pendingReason: 'awaiting_manual_review',
            riskFlags: [],
          }),
        ],
        page: {
          limit: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
  });

  it('derives pendingReason from server risk analysis with stable precedence and nulls it after review', async () => {
    const invalidPendingRecord = createDebateRequestRecord({
      entityCui: '12345678',
      institutionEmail: 'invalid-email',
      updatedAt: '2026-04-10T12:00:00.000Z',
    });
    const missingOfficialPendingRecord = createDebateRequestRecord({
      entityCui: '87654321',
      institutionEmail: 'contact@primarie-2.ro',
      updatedAt: '2026-04-10T11:00:00.000Z',
    });
    const genericPendingRecord = createCityHallWebsiteRecord({
      entityCui: '99999999',
      updatedAt: '2026-04-10T10:00:00.000Z',
    });
    const reviewedRecord = {
      ...createDebateRequestRecord({
        entityCui: '22222222',
        institutionEmail: 'wrong@primarie-4.ro',
        updatedAt: '2026-04-10T09:00:00.000Z',
      }),
      phase: 'resolved' as const,
      review: {
        status: 'approved' as const,
        reviewedAt: '2026-04-10T09:30:00.000Z',
      },
    };

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', invalidPendingRecord, '1')]);
    initialRecords.set('user-2', [makeRow('user-2', missingOfficialPendingRecord, '2')]);
    initialRecords.set('user-3', [makeRow('user-3', genericPendingRecord, '3')]);
    initialRecords.set('user-4', [makeRow('user-4', reviewedRecord, '4')]);

    const repo = makeFakeLearningProgressRepo({
      initialRecords,
      campaignAdminThreadSummaries: new Map([
        [
          'funky::12345678',
          {
            threadId: 'thread-invalid',
            threadPhase: 'failed',
            lastEmailAt: '2026-04-10T12:05:00.000Z',
            lastReplyAt: null,
            nextActionAt: null,
          },
        ],
        [
          'funky::87654321',
          {
            threadId: 'thread-missing',
            threadPhase: 'failed',
            lastEmailAt: '2026-04-10T11:05:00.000Z',
            lastReplyAt: null,
            nextActionAt: null,
          },
        ],
        [
          'funky::22222222',
          {
            threadId: 'thread-reviewed',
            threadPhase: 'failed',
            lastEmailAt: '2026-04-10T09:05:00.000Z',
            lastReplyAt: null,
            nextActionAt: null,
          },
        ],
      ]),
    });

    const setup = await createTestApp({
      learningProgressRepo: repo,
      entityProfileRepo: makeTestEntityProfileRepo({
        '12345678': 'official@primarie.ro',
        '22222222': 'official@primarie-4.ro',
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      ok: boolean;
      data: {
        items: {
          recordKey: string;
          reviewStatus: 'pending' | 'approved' | 'rejected' | null;
          pendingReason:
            | 'invalid_institution_email'
            | 'missing_official_email'
            | 'institution_email_mismatch'
            | 'institution_thread_failed'
            | 'awaiting_manual_review'
            | null;
          riskFlags: string[];
        }[];
      };
    }>();

    expect(body.ok).toBe(true);

    const itemsByRecordKey = new Map(body.data.items.map((item) => [item.recordKey, item]));

    expect(itemsByRecordKey.get(invalidPendingRecord.key)).toMatchObject({
      reviewStatus: 'pending',
      pendingReason: 'invalid_institution_email',
      riskFlags: ['invalid_institution_email', 'institution_thread_failed'],
    });
    expect(itemsByRecordKey.get(missingOfficialPendingRecord.key)).toMatchObject({
      reviewStatus: 'pending',
      pendingReason: 'missing_official_email',
      riskFlags: ['missing_official_email', 'institution_thread_failed'],
    });
    expect(itemsByRecordKey.get(genericPendingRecord.key)).toMatchObject({
      reviewStatus: 'pending',
      pendingReason: 'awaiting_manual_review',
      riskFlags: [],
    });
    expect(itemsByRecordKey.get(reviewedRecord.key)).toMatchObject({
      reviewStatus: 'approved',
      pendingReason: null,
      riskFlags: ['institution_email_mismatch', 'institution_thread_failed'],
    });
  });

  it('sorts by organizationName before cursor pagination and echoes sort metadata', async () => {
    const zetaRecord = createDebateRequestRecord({
      entityCui: '12345678',
      organizationName: 'Zeta Action',
      updatedAt: '2026-04-10T12:00:00.000Z',
    });
    const alphaRecord = createDebateRequestRecord({
      entityCui: '87654321',
      organizationName: 'Alpha Group',
      updatedAt: '2026-04-10T11:00:00.000Z',
    });
    const betaRecord = createDebateRequestRecord({
      entityCui: '99999999',
      organizationName: 'Beta Watch',
      updatedAt: '2026-04-10T10:00:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', zetaRecord, '1')]);
    initialRecords.set('user-2', [makeRow('user-2', alphaRecord, '2')]);
    initialRecords.set('user-3', [makeRow('user-3', betaRecord, '3')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const setup = await createTestApp({ learningProgressRepo: repo });
    app = setup.app;

    const firstResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions?sortBy=organizationName&sortOrder=asc&limit=1',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    const firstBody = firstResponse.json<{
      ok: boolean;
      data: {
        items: { organizationName: string | null }[];
        page: {
          limit: number;
          hasMore: boolean;
          nextCursor: string | null;
          sortBy?: string;
          sortOrder?: string;
        };
      };
    }>();

    expect(firstBody).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            organizationName: 'Alpha Group',
          }),
        ],
        page: {
          limit: 1,
          hasMore: true,
          nextCursor: expect.any(String),
          sortBy: 'organizationName',
          sortOrder: 'asc',
        },
      },
    });

    const secondPageQuery = new URLSearchParams({
      sortBy: 'organizationName',
      sortOrder: 'asc',
      limit: '1',
      cursor: firstBody.data.page.nextCursor ?? '',
    });

    const secondResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/campaigns/funky/user-interactions?${secondPageQuery.toString()}`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            organizationName: 'Beta Watch',
          }),
        ],
        page: {
          limit: 1,
          hasMore: true,
          nextCursor: expect.any(String),
          sortBy: 'organizationName',
          sortOrder: 'asc',
        },
      },
    });
  });

  it('supports entity and hasInstitutionThread filters', async () => {
    const firstRecord = createDebateRequestRecord({
      entityCui: '12345678',
      updatedAt: '2026-04-10T11:00:00.000Z',
    });
    const secondRecord = createDebateRequestRecord({
      entityCui: '87654321',
      updatedAt: '2026-04-10T10:00:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', firstRecord, '1')]);
    initialRecords.set('user-2', [makeRow('user-2', secondRecord, '2')]);

    const repo = makeFakeLearningProgressRepo({
      initialRecords,
      campaignAdminThreadSummaries: new Map([
        [
          'funky::12345678',
          {
            threadId: 'thread-1',
            threadPhase: 'awaiting_reply',
            lastEmailAt: '2026-04-10T11:05:00.000Z',
            lastReplyAt: null,
            nextActionAt: null,
          },
        ],
      ]),
    });

    const setup = await createTestApp({ learningProgressRepo: repo });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions?entityCui=12345678&hasInstitutionThread=true',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            entityCui: '12345678',
            entityName: 'Oras Test',
            interactionElementLink:
              '/primarie/12345678/buget/provocari/civic-campaign/civic-monitor-and-request/04-debate-request',
            threadId: 'thread-1',
          }),
        ],
        page: {
          limit: 50,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
  });

  it('returns 400 when a campaign-admin list query exceeds the safety cap', async () => {
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();

    for (let index = 0; index <= 5000; index += 1) {
      const userId = `user-${String(index)}`;
      const entityCui = String(10000000 + index);
      initialRecords.set(userId, [
        makeRow(
          userId,
          createCityHallWebsiteRecord({
            entityCui,
            updatedAt: `2026-04-10T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
          }),
          String(index + 1)
        ),
      ]);
    }

    const setup = await createTestApp({
      learningProgressRepo: makeFakeLearningProgressRepo({ initialRecords }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'InvalidEventError',
      message:
        'Campaign interaction audit query matched too many rows. Narrow the filters to 5000 rows or fewer.',
      retryable: false,
    });
  });

  it('returns 400 for malformed cursors', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const malformedCursor = Buffer.from(
      JSON.stringify({
        updatedAt: 'not-a-date',
        userId: 'user-1',
        recordKey: 'key-1',
      }),
      'utf-8'
    ).toString('base64url');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/campaigns/funky/user-interactions?cursor=${malformedCursor}`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ValidationError',
      message: 'Invalid campaign interaction cursor',
      retryable: false,
    });
  });

  it('shows self-send public-debate submissions in the audit list but still rejects reviews for them', async () => {
    const selfSendRecord = createDebateRequestRecord({
      entityCui: '12345678',
      submissionPath: 'send_yourself',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', selfSendRecord, '1')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const setup = await createTestApp({ learningProgressRepo: repo });
    app = setup.app;

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            recordKey: selfSendRecord.key,
            interactionId: 'funky:interaction:public_debate_request',
            reviewable: false,
            reviewStatus: null,
            pendingReason: null,
            submissionPath: 'send_yourself',
            institutionEmail: 'contact@primarie.ro',
            riskFlags: [],
            threadId: null,
          }),
        ],
        page: {
          limit: 50,
          hasMore: false,
          nextCursor: null,
        },
      },
    });

    const reviewResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/user-interactions/reviews',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        items: [
          {
            userId: 'user-1',
            recordKey: selfSendRecord.key,
            expectedUpdatedAt: selfSendRecord.updatedAt,
            status: 'approved',
          },
        ],
      },
    });

    expect(reviewResponse.statusCode).toBe(404);
  });

  it('rejects review attempts for audit-only participation reports', async () => {
    const participationRecord = createParticipationReportRecord({
      entityCui: '12345678',
      updatedAt: '2026-04-10T10:00:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', participationRecord, '1')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const setup = await createTestApp({ learningProgressRepo: repo });
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/user-interactions/reviews',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        items: [
          {
            userId: 'user-1',
            recordKey: participationRecord.key,
            expectedUpdatedAt: participationRecord.updatedAt,
            status: 'approved',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('does not emit missing-official-email risk flags when official-email enrichment fails', async () => {
    const record = createDebateRequestRecord({
      entityCui: '12345678',
      institutionEmail: 'contact@primarie.ro',
    });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', record, '1')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const setup = await createTestApp({
      learningProgressRepo: repo,
      entityProfileRepo: {
        async getByEntityCui() {
          return err(createEntityDatabaseError('should not be called'));
        },
        async getByEntityCuis() {
          return err(createEntityDatabaseError('temporary lookup failure'));
        },
      },
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/user-interactions',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            recordKey: record.key,
            riskFlags: [],
          }),
        ],
        page: {
          limit: 50,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
  });

  it('rejects client-supplied pendingReason on review submissions', async () => {
    const record = createDebateRequestRecord({});
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', record, '1')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const setup = await createTestApp({ learningProgressRepo: repo });
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/user-interactions/reviews',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        items: [
          {
            userId: 'user-1',
            recordKey: record.key,
            expectedUpdatedAt: record.updatedAt,
            status: 'approved',
            pendingReason: 'invalid_institution_email',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
    });

    const storedRow = (await repo.getRecords('user-1'))._unsafeUnwrap()[0];
    expect(storedRow?.record.review).toBeUndefined();
  });

  it('applies admin reviews with reviewer attribution', async () => {
    const record = createDebateRequestRecord({});
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', record, '1')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const setup = await createTestApp({ learningProgressRepo: repo });
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/user-interactions/reviews',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        items: [
          {
            userId: 'user-1',
            recordKey: record.key,
            expectedUpdatedAt: record.updatedAt,
            status: 'rejected',
            feedbackText: 'Needs correction',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            recordKey: record.key,
            phase: 'failed',
            reviewStatus: 'rejected',
            pendingReason: null,
            reviewedByUserId: setup.testAuth.userIds.user1,
            reviewSource: 'campaign_admin_api',
            feedbackText: 'Needs correction',
          }),
        ],
      },
    });

    const storedRow = (await repo.getRecords('user-1'))._unsafeUnwrap()[0];
    expect(storedRow?.record.review).toEqual({
      status: 'rejected',
      reviewedAt: storedRow?.record.updatedAt,
      feedbackText: 'Needs correction',
      reviewedByUserId: setup.testAuth.userIds.user1,
      reviewSource: 'campaign_admin_api',
    });
    expect(storedRow?.auditEvents.at(-1)).toEqual(
      expect.objectContaining({
        type: 'evaluated',
        actor: 'admin',
        actorUserId: setup.testAuth.userIds.user1,
        actorPermission: 'campaign:funky_admin',
        actorSource: 'campaign_admin_api',
        phase: 'failed',
      })
    );
  });

  it('rejects malformed city-hall-website rows without crashing error serialization or response formatting', async () => {
    const malformedRecord = {
      ...createCityHallWebsiteRecord({
        entityCui: '4270740',
        updatedAt: '2026-04-10T12:00:00.000Z',
      }),
      scope: {
        type: 'entity',
      },
    } as unknown as LearningProgressRecordRow['record'];

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user_33khfjyOugrQuZitvM1GLTWfeeg', [
      makeRow('user_33khfjyOugrQuZitvM1GLTWfeeg', malformedRecord, '1'),
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const setup = await createTestApp({ learningProgressRepo: repo });
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/user-interactions/reviews',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        items: [
          {
            userId: 'user_33khfjyOugrQuZitvM1GLTWfeeg',
            recordKey: malformedRecord.key,
            expectedUpdatedAt: malformedRecord.updatedAt,
            status: 'rejected',
            feedbackText: 'Missing required website evidence.',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            recordKey: malformedRecord.key,
            interactionId: 'funky:interaction:city_hall_website',
            entityCui: null,
            entityName: null,
            interactionElementLink: null,
            reviewStatus: 'rejected',
            feedbackText: 'Missing required website evidence.',
          }),
        ],
      },
    });
  });

  it('approves public-debate requests and runs server-derived side effects after commit', async () => {
    const record = createDebateRequestRecord({});
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', record, '1')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const entityProfileRepo = makeTestEntityProfileRepo({
      '12345678': 'contact@primarie.ro',
    });
    const sentEmails: unknown[] = [];
    const approvalHook = createPublicDebateApprovalHook({
      learningProgressRepo: repo,
      entityProfileRepo,
      sentEmails,
    });

    const setup = await createTestApp({
      learningProgressRepo: repo,
      entityProfileRepo,
      prepareApproveReviews: approvalHook.prepareApproveReviews,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/user-interactions/reviews',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        items: [
          {
            userId: 'user-1',
            recordKey: record.key,
            expectedUpdatedAt: record.updatedAt,
            status: 'approved',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(sentEmails).toHaveLength(1);
    expect(approvalHook.correspondenceRepo.snapshotThreads()).toHaveLength(1);

    const storedRow = (await repo.getRecords('user-1'))._unsafeUnwrap()[0];
    expect(storedRow?.record.phase).toBe('resolved');
    expect(storedRow?.record.review).toEqual({
      status: 'approved',
      reviewedAt: storedRow?.record.updatedAt,
      reviewedByUserId: setup.testAuth.userIds.user1,
      reviewSource: 'campaign_admin_api',
    });
  });

  it('returns 502 when approval side effects fail after commit and allows a safe retry', async () => {
    const record = createDebateRequestRecord({});
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', record, '1')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const entityProfileRepo = makeTestEntityProfileRepo({
      '12345678': 'contact@primarie.ro',
    });
    const sentEmails: unknown[] = [];
    const approvalHook = createPublicDebateApprovalHook({
      learningProgressRepo: repo,
      entityProfileRepo,
      sentEmails,
      failSendAttempts: 1,
    });

    const setup = await createTestApp({
      learningProgressRepo: repo,
      entityProfileRepo,
      prepareApproveReviews: approvalHook.prepareApproveReviews,
    });
    app = setup.app;

    const payload = {
      items: [
        {
          userId: 'user-1',
          recordKey: record.key,
          expectedUpdatedAt: record.updatedAt,
          status: 'approved' as const,
        },
      ],
    };

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/user-interactions/reviews',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload,
    });

    expect(firstResponse.statusCode).toBe(502);
    expect(firstResponse.json()).toEqual({
      ok: false,
      error: 'CorrespondenceEmailSendError',
      message: 'Provider send failed',
      retryable: true,
    });

    const firstStoredRow = (await repo.getRecords('user-1'))._unsafeUnwrap()[0];
    expect(firstStoredRow?.record.phase).toBe('resolved');
    expect(firstStoredRow?.record.review).toEqual({
      status: 'approved',
      reviewedAt: firstStoredRow?.record.updatedAt,
      reviewedByUserId: setup.testAuth.userIds.user1,
      reviewSource: 'campaign_admin_api',
    });
    expect(approvalHook.correspondenceRepo.snapshotThreads()).toHaveLength(1);
    expect(approvalHook.correspondenceRepo.snapshotThreads()[0]?.phase).toBe('failed');

    const retryResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/user-interactions/reviews',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload,
    });

    expect(retryResponse.statusCode).toBe(200);
    expect(retryResponse.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            recordKey: record.key,
            phase: 'resolved',
            reviewStatus: 'approved',
            reviewedByUserId: setup.testAuth.userIds.user1,
            reviewSource: 'campaign_admin_api',
          }),
        ],
      },
    });
    expect(sentEmails).toHaveLength(2);

    const activeThreadResult = await approvalHook.correspondenceRepo.findPlatformSendThreadByEntity(
      {
        entityCui: '12345678',
        campaign: 'funky',
      }
    );
    expect(activeThreadResult.isOk()).toBe(true);
    expect(activeThreadResult._unsafeUnwrap()).not.toBeNull();
  });
});
