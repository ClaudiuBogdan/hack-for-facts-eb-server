import { describe, expect, it } from 'vitest';

import { makeInstitutionCorrespondenceReplyReviewPendingEventDefinition } from '@/modules/admin-events/index.js';

import {
  createCorrespondenceEntry,
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from '../institution-correspondence/fake-repo.js';

describe('institution_correspondence.reply_review_pending event definition', () => {
  it('loads context and applies a reply review outcome', async () => {
    const reply = createCorrespondenceEntry({
      id: 'reply-1',
      direction: 'inbound',
      source: 'institution_reply',
      occurredAt: '2026-04-05T11:00:00.000Z',
    });
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-1',
          phase: 'reply_received_unreviewed',
          updatedAt: new Date('2026-04-05T11:00:00.000Z'),
          record: createThreadAggregateRecord({
            correspondence: [reply],
          }),
        }),
      ],
    });
    const definition = makeInstitutionCorrespondenceReplyReviewPendingEventDefinition({
      repo,
    });

    const contextResult = await definition.loadContext({
      threadId: 'thread-1',
      basedOnEntryId: 'reply-1',
    });
    expect(contextResult.isOk()).toBe(true);
    if (contextResult.isErr() || contextResult.value === null) {
      return;
    }

    const exportBundle = definition.buildExportBundle({
      jobId: 'job-1',
      payload: {
        threadId: 'thread-1',
        basedOnEntryId: 'reply-1',
      },
      context: contextResult.value,
    });

    expect(
      definition.classifyState({
        payload: {
          threadId: 'thread-1',
          basedOnEntryId: 'reply-1',
        },
        context: contextResult.value,
        exportBundle: {
          ...exportBundle,
          exportMetadata: {
            exportId: 'export-1',
            exportedAt: '2026-04-05T11:00:10.000Z',
            workspace: '/tmp',
          },
          outcomeSchema: {},
        },
      })
    ).toBe('actionable');

    const applyResult = await definition.applyOutcome({
      payload: {
        threadId: 'thread-1',
        basedOnEntryId: 'reply-1',
      },
      context: contextResult.value,
      outcome: {
        resolutionCode: 'debate_announced',
        reviewNotes: 'Debate confirmed.',
      },
    });

    expect(applyResult.isOk()).toBe(true);

    const reviewedContext = await definition.loadContext({
      threadId: 'thread-1',
      basedOnEntryId: 'reply-1',
    });
    expect(reviewedContext.isOk()).toBe(true);
    if (reviewedContext.isErr() || reviewedContext.value === null) {
      return;
    }

    expect(reviewedContext.value.thread.phase).toBe('resolved_positive');
    expect(reviewedContext.value.thread.record.latestReview?.resolutionCode).toBe(
      'debate_announced'
    );
    expect(
      definition.classifyState({
        payload: {
          threadId: 'thread-1',
          basedOnEntryId: 'reply-1',
        },
        context: reviewedContext.value,
        outcome: {
          resolutionCode: 'debate_announced',
          reviewNotes: 'Debate confirmed.',
        },
        exportBundle: {
          ...exportBundle,
          exportMetadata: {
            exportId: 'export-1',
            exportedAt: '2026-04-05T11:00:10.000Z',
            workspace: '/tmp',
          },
          outcomeSchema: {},
        },
      })
    ).toBe('already_applied');
  });

  it('detects stale or non-reviewable threads', async () => {
    const reply = createCorrespondenceEntry({
      id: 'reply-2',
      direction: 'inbound',
      source: 'institution_reply',
      occurredAt: '2026-04-05T11:30:00.000Z',
    });
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-2',
          phase: 'reply_received_unreviewed',
          updatedAt: new Date('2026-04-05T11:30:00.000Z'),
          record: createThreadAggregateRecord({
            correspondence: [reply],
          }),
        }),
      ],
    });
    const definition = makeInstitutionCorrespondenceReplyReviewPendingEventDefinition({
      repo,
    });

    const contextResult = await definition.loadContext({
      threadId: 'thread-2',
      basedOnEntryId: 'reply-2',
    });
    expect(contextResult.isOk()).toBe(true);
    if (contextResult.isErr() || contextResult.value === null) {
      return;
    }

    const exportBundle = {
      ...definition.buildExportBundle({
        jobId: 'job-2',
        payload: {
          threadId: 'thread-2',
          basedOnEntryId: 'reply-2',
        },
        context: contextResult.value,
      }),
      exportMetadata: {
        exportId: 'export-2',
        exportedAt: '2026-04-05T11:30:10.000Z',
        workspace: '/tmp',
      },
      outcomeSchema: {},
    };

    expect(
      definition.classifyState({
        payload: {
          threadId: 'thread-2',
          basedOnEntryId: 'reply-2',
        },
        context: {
          ...contextResult.value,
          thread: {
            ...contextResult.value.thread,
            updatedAt: new Date('2026-04-05T11:31:00.000Z'),
          },
        },
        exportBundle,
      })
    ).toBe('stale');

    const reviewedRepo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-3',
          phase: 'resolved_positive',
          record: createThreadAggregateRecord({
            correspondence: [reply],
            latestReview: {
              basedOnEntryId: 'reply-2',
              resolutionCode: 'debate_announced',
              notes: null,
              reviewedAt: '2026-04-05T11:32:00.000Z',
            },
          }),
        }),
      ],
    });
    const reviewedDefinition = makeInstitutionCorrespondenceReplyReviewPendingEventDefinition({
      repo: reviewedRepo,
    });
    const reviewedContext = await reviewedDefinition.loadContext({
      threadId: 'thread-3',
      basedOnEntryId: 'reply-2',
    });
    expect(reviewedContext.isOk()).toBe(true);
    if (reviewedContext.isErr() || reviewedContext.value === null) {
      return;
    }

    expect(
      reviewedDefinition.classifyState({
        payload: {
          threadId: 'thread-3',
          basedOnEntryId: 'reply-2',
        },
        context: reviewedContext.value,
      })
    ).toBe('not_actionable');
  });

  it('treats older inbound replies as stale when a newer inbound reply exists', async () => {
    const olderReply = createCorrespondenceEntry({
      id: 'reply-old',
      direction: 'inbound',
      source: 'institution_reply',
      occurredAt: '2026-04-05T11:00:00.000Z',
    });
    const newerReply = createCorrespondenceEntry({
      id: 'reply-new',
      direction: 'inbound',
      source: 'institution_reply',
      occurredAt: '2026-04-05T11:05:00.000Z',
    });
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-4',
          phase: 'reply_received_unreviewed',
          updatedAt: new Date('2026-04-05T11:05:00.000Z'),
          record: createThreadAggregateRecord({
            correspondence: [olderReply, newerReply],
          }),
        }),
      ],
    });
    const definition = makeInstitutionCorrespondenceReplyReviewPendingEventDefinition({
      repo,
    });

    const olderContext = await definition.loadContext({
      threadId: 'thread-4',
      basedOnEntryId: 'reply-old',
    });
    const newerContext = await definition.loadContext({
      threadId: 'thread-4',
      basedOnEntryId: 'reply-new',
    });

    expect(olderContext.isOk()).toBe(true);
    expect(newerContext.isOk()).toBe(true);

    if (
      olderContext.isErr() ||
      olderContext.value === null ||
      newerContext.isErr() ||
      newerContext.value === null
    ) {
      return;
    }

    expect(
      definition.classifyState({
        payload: {
          threadId: 'thread-4',
          basedOnEntryId: 'reply-old',
        },
        context: olderContext.value,
        exportBundle: {
          ...definition.buildExportBundle({
            jobId: 'job-old',
            payload: {
              threadId: 'thread-4',
              basedOnEntryId: 'reply-old',
            },
            context: olderContext.value,
          }),
          exportMetadata: {
            exportId: 'export-old',
            exportedAt: '2026-04-05T11:05:10.000Z',
            workspace: '/tmp',
          },
          outcomeSchema: {},
        },
      })
    ).toBe('stale');

    expect(
      definition.classifyState({
        payload: {
          threadId: 'thread-4',
          basedOnEntryId: 'reply-new',
        },
        context: newerContext.value,
        exportBundle: {
          ...definition.buildExportBundle({
            jobId: 'job-new',
            payload: {
              threadId: 'thread-4',
              basedOnEntryId: 'reply-new',
            },
            context: newerContext.value,
          }),
          exportMetadata: {
            exportId: 'export-new',
            exportedAt: '2026-04-05T11:05:10.000Z',
            workspace: '/tmp',
          },
          outcomeSchema: {},
        },
      })
    ).toBe('actionable');
  });
});
