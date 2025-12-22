/**
 * Learning Progress REST API Schemas
 *
 * TypeBox schemas for request/response validation.
 * Implements strict validation to catch client bugs.
 */

import { Type, type Static } from '@sinclair/typebox';

import { MAX_EVENTS_PER_REQUEST } from '../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Event Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Content status enum.
 * Per client spec: not_started | in_progress | completed | passed
 */
export const LearningContentStatusSchema = Type.Union([
  Type.Literal('not_started'),
  Type.Literal('in_progress'),
  Type.Literal('completed'),
  Type.Literal('passed'),
]);

/**
 * Event type enum.
 */
export const LearningProgressEventTypeSchema = Type.Union([
  Type.Literal('content.progressed'),
  Type.Literal('onboarding.completed'),
  Type.Literal('onboarding.reset'),
  Type.Literal('activePath.set'),
  Type.Literal('progress.reset'),
]);

/**
 * Interaction state (flexible JSON object).
 */
export const LearningInteractionStateSchema = Type.Record(Type.String(), Type.Unknown(), {
  description: 'Interaction state data',
});

/**
 * Interaction update within content progress.
 */
export const InteractionUpdateSchema = Type.Object(
  {
    interactionId: Type.String({ minLength: 1, maxLength: 200 }),
    state: Type.Union([LearningInteractionStateSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

/**
 * Payload for content.progressed events.
 */
export const ContentProgressPayloadSchema = Type.Object(
  {
    contentId: Type.String({ minLength: 1, maxLength: 200 }),
    status: LearningContentStatusSchema,
    score: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    contentVersion: Type.Optional(Type.String({ maxLength: 50 })),
    interaction: Type.Optional(InteractionUpdateSchema),
  },
  { additionalProperties: false }
);

/**
 * Base event fields (shared by all event types).
 */
const EventBaseSchema = {
  eventId: Type.String({
    minLength: 1,
    maxLength: 100,
    description: 'Unique event identifier (client-generated UUID)',
  }),
  occurredAt: Type.String({
    format: 'date-time',
    description: 'When the event occurred (ISO 8601)',
  }),
  clientId: Type.String({
    minLength: 1,
    maxLength: 100,
    description: 'Client/device identifier',
  }),
};

/**
 * Content progressed event.
 */
export const ContentProgressedEventSchema = Type.Object({
  ...EventBaseSchema,
  type: Type.Literal('content.progressed'),
  payload: ContentProgressPayloadSchema,
});

/**
 * Onboarding completed event.
 */
export const OnboardingCompletedEventSchema = Type.Object({
  ...EventBaseSchema,
  type: Type.Literal('onboarding.completed'),
  payload: Type.Object(
    {
      pathId: Type.String({ minLength: 1, maxLength: 100 }),
    },
    { additionalProperties: false }
  ),
});

/**
 * Onboarding reset event.
 * This event has NO payload field per client specification.
 */
export const OnboardingResetEventSchema = Type.Object({
  ...EventBaseSchema,
  type: Type.Literal('onboarding.reset'),
});

/**
 * Active path set event.
 */
export const ActivePathSetEventSchema = Type.Object({
  ...EventBaseSchema,
  type: Type.Literal('activePath.set'),
  payload: Type.Object(
    {
      pathId: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    },
    { additionalProperties: false }
  ),
});

/**
 * Progress reset event.
 * Resets all learning progress for the user.
 * This event has NO payload field.
 */
export const ProgressResetEventSchema = Type.Object({
  ...EventBaseSchema,
  type: Type.Literal('progress.reset'),
});

/**
 * Union of all event types.
 */
export const LearningProgressEventSchema = Type.Union([
  ContentProgressedEventSchema,
  OnboardingCompletedEventSchema,
  OnboardingResetEventSchema,
  ActivePathSetEventSchema,
  ProgressResetEventSchema,
]);

export type LearningProgressEventBody = Static<typeof LearningProgressEventSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Request Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query params for GET /progress.
 */
export const GetProgressQuerySchema = Type.Object(
  {
    since: Type.Optional(
      Type.String({
        description: 'Cursor (ISO timestamp) to get events since',
      })
    ),
  },
  { additionalProperties: false }
);

export type GetProgressQuery = Static<typeof GetProgressQuerySchema>;

/**
 * Request body for PUT /progress.
 */
export const SyncEventsBodySchema = Type.Object(
  {
    clientUpdatedAt: Type.String({
      format: 'date-time',
      description: 'Client timestamp when sync was initiated',
    }),
    events: Type.Array(LearningProgressEventSchema, {
      maxItems: MAX_EVENTS_PER_REQUEST,
      description: `Array of events to sync (max ${String(MAX_EVENTS_PER_REQUEST)})`,
    }),
  },
  { additionalProperties: false }
);

export type SyncEventsBody = Static<typeof SyncEventsBodySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Response Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Content progress in snapshot.
 */
export const LearningContentProgressSchema = Type.Object({
  contentId: Type.String(),
  status: LearningContentStatusSchema,
  score: Type.Optional(Type.Number()),
  completedAt: Type.Optional(Type.String()),
  lastAttemptAt: Type.Optional(Type.String()),
  interactions: Type.Record(
    Type.String(),
    Type.Union([LearningInteractionStateSchema, Type.Null()])
  ),
});

/**
 * Streak information.
 */
export const LearningStreakSchema = Type.Object({
  currentStreak: Type.Number(),
  longestStreak: Type.Number(),
  lastActivityDate: Type.Union([Type.String(), Type.Null()]),
});

/**
 * Learning progress snapshot.
 */
export const LearningProgressSnapshotSchema = Type.Object({
  version: Type.Number(),
  activePath: Type.Union([Type.String(), Type.Null()]),
  onboardingCompletedAt: Type.Union([Type.String(), Type.Null()]),
  onboardingPathId: Type.Union([Type.String(), Type.Null()]),
  content: Type.Record(Type.String(), LearningContentProgressSchema),
  streak: LearningStreakSchema,
  lastUpdated: Type.Union([Type.String(), Type.Null()]),
});

/**
 * Success response for GET /progress.
 * Client derives snapshot from events.
 */
export const GetProgressResponseSchema = Type.Object({
  ok: Type.Literal(true),
  data: Type.Object({
    events: Type.Array(LearningProgressEventSchema),
    cursor: Type.String(),
  }),
});

/**
 * Success response for PUT /progress.
 */
export const SyncEventsResponseSchema = Type.Object({
  ok: Type.Literal(true),
});

/**
 * Error response.
 */
export const ErrorResponseSchema = Type.Object({
  ok: Type.Literal(false),
  error: Type.String(),
  message: Type.String(),
});
