import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import {
  DEBATE_REQUEST_INTERACTION_ID,
  parseDebateRequestPayloadValue,
  type DebateRequestPayload,
} from './public-debate-request.js';

// Maintenance note: check /docs/guides/INTERACTIVE-ELEMENT-CHECKS-AND-TRIGGERS.md.
export const CITY_HALL_WEBSITE_INTERACTION_ID = 'funky:interaction:city_hall_website' as const;
export const BUDGET_DOCUMENT_INTERACTION_ID = 'funky:interaction:budget_document' as const;
export const BUDGET_PUBLICATION_DATE_INTERACTION_ID =
  'funky:interaction:budget_publication_date' as const;
export const BUDGET_STATUS_INTERACTION_ID = 'funky:interaction:budget_status' as const;
export const CITY_HALL_CONTACT_INTERACTION_ID = 'funky:interaction:city_hall_contact' as const;
export const PARTICIPATION_REPORT_INTERACTION_ID = 'funky:interaction:funky_participation' as const;
export const BUDGET_CONTESTATION_INTERACTION_ID = 'funky:interaction:budget_contestation' as const;
export const CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS = [
  'ch-civic-01-how-module-works-q1',
  'ch-civic-01-why-budget-matters-q1',
  'ch-civic-01-what-campaign-is-q1',
  'ch-civic-02-cycle-q1',
  'ch-civic-02-deadlines-q1',
  'ch-civic-02-rights-q1',
  'ch-civic-03-why-check-q1',
  'ch-civic-04-why-debate-q1',
  'ch-civic-04-next-steps-q1',
  'ch-civic-05-preparation-q1',
  'ch-civic-06-when-contest-q1',
] as const;

const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);
const NullableNumberSchema = Type.Union([Type.Number(), Type.Null()]);

const WebsiteLinkPayloadCandidateSchema = Type.Object(
  {
    websiteUrl: Type.Optional(Type.String()),
    submittedAt: Type.Optional(NullableStringSchema),
  },
  { additionalProperties: false }
);

export interface WebsiteLinkPayload {
  readonly websiteUrl: string | null;
  readonly submittedAt: string | null;
}

export function parseWebsiteLinkPayloadValue(candidate: unknown): WebsiteLinkPayload | null {
  if (!Value.Check(WebsiteLinkPayloadCandidateSchema, candidate)) {
    return null;
  }

  const payload = candidate;

  return {
    websiteUrl: typeof payload.websiteUrl === 'string' ? payload.websiteUrl : null,
    submittedAt: typeof payload.submittedAt === 'string' ? payload.submittedAt : null,
  };
}

const BudgetDocumentTypeSchema = Type.Union([
  Type.Literal('pdf'),
  Type.Literal('word'),
  Type.Literal('excel'),
  Type.Literal('webpage'),
  Type.Literal('graphics'),
  Type.Literal('other'),
]);

const BudgetDocumentPayloadCandidateSchema = Type.Object(
  {
    documentUrl: Type.Optional(Type.String()),
    documentTypes: Type.Optional(Type.Array(BudgetDocumentTypeSchema)),
    documentType: Type.Optional(Type.Union([BudgetDocumentTypeSchema, Type.Null()])),
    submittedAt: Type.Optional(NullableStringSchema),
  },
  { additionalProperties: false }
);

export interface BudgetDocumentPayload {
  readonly documentUrl: string | null;
  readonly documentTypes: readonly ('pdf' | 'word' | 'excel' | 'webpage' | 'graphics' | 'other')[];
  readonly submittedAt: string | null;
}

function normalizeBudgetDocumentTypes(
  documentTypes: readonly string[] | undefined,
  documentType: string | null | undefined
): BudgetDocumentPayload['documentTypes'] {
  const candidateValues =
    documentTypes ?? (documentType === undefined || documentType === null ? [] : [documentType]);

  return Array.from(
    new Set(
      candidateValues.filter(
        (value): value is BudgetDocumentPayload['documentTypes'][number] =>
          value === 'pdf' ||
          value === 'word' ||
          value === 'excel' ||
          value === 'webpage' ||
          value === 'graphics' ||
          value === 'other'
      )
    )
  );
}

export function parseBudgetDocumentPayloadValue(candidate: unknown): BudgetDocumentPayload | null {
  if (!Value.Check(BudgetDocumentPayloadCandidateSchema, candidate)) {
    return null;
  }

  const payload = candidate as {
    documentUrl?: string;
    documentTypes?: readonly string[];
    documentType?: string | null;
    submittedAt?: string | null;
  };

  return {
    documentUrl: typeof payload.documentUrl === 'string' ? payload.documentUrl : null,
    documentTypes: normalizeBudgetDocumentTypes(payload.documentTypes, payload.documentType),
    submittedAt: typeof payload.submittedAt === 'string' ? payload.submittedAt : null,
  };
}

const BudgetPublicationDateSourceTypeSchema = Type.Union([
  Type.Literal('website'),
  Type.Literal('press'),
  Type.Literal('social_media'),
  Type.Literal('other'),
]);

const BudgetPublicationDateSourceCandidateSchema = Type.Object(
  {
    type: BudgetPublicationDateSourceTypeSchema,
    url: Type.Optional(NullableStringSchema),
  },
  { additionalProperties: false }
);

const BudgetPublicationDatePayloadCandidateSchema = Type.Object(
  {
    publicationDate: Type.Optional(NullableStringSchema),
    sources: Type.Optional(Type.Array(BudgetPublicationDateSourceCandidateSchema)),
    submittedAt: Type.Optional(NullableStringSchema),
  },
  { additionalProperties: false }
);

export interface BudgetPublicationDatePayload {
  readonly publicationDate: string | null;
  readonly sources: readonly {
    type: 'website' | 'press' | 'social_media' | 'other';
    url: string | null;
  }[];
  readonly submittedAt: string | null;
}

export function parseBudgetPublicationDatePayloadValue(
  candidate: unknown
): BudgetPublicationDatePayload | null {
  if (!Value.Check(BudgetPublicationDatePayloadCandidateSchema, candidate)) {
    return null;
  }

  const payload = candidate as {
    publicationDate?: string | null;
    sources?: readonly {
      type: BudgetPublicationDatePayload['sources'][number]['type'];
      url?: string | null;
    }[];
    submittedAt?: string | null;
  };

  return {
    publicationDate: typeof payload.publicationDate === 'string' ? payload.publicationDate : null,
    sources:
      payload.sources?.map((source) => ({
        type: source.type,
        url: typeof source.url === 'string' ? source.url : null,
      })) ?? [],
    submittedAt: typeof payload.submittedAt === 'string' ? payload.submittedAt : null,
  };
}

const BudgetStatusReportPayloadCandidateSchema = Type.Object(
  {
    isPublished: Type.Optional(
      Type.Union([Type.Literal('yes'), Type.Literal('no'), Type.Literal('dont_know'), Type.Null()])
    ),
    budgetStage: Type.Optional(
      Type.Union([Type.Literal('draft'), Type.Literal('approved'), Type.Null()])
    ),
    submittedAt: Type.Optional(NullableStringSchema),
  },
  { additionalProperties: false }
);

export interface BudgetStatusReportPayload {
  readonly isPublished: 'yes' | 'no' | 'dont_know' | null;
  readonly budgetStage: 'draft' | 'approved' | null;
  readonly submittedAt: string | null;
}

export function parseBudgetStatusReportPayloadValue(
  candidate: unknown
): BudgetStatusReportPayload | null {
  if (!Value.Check(BudgetStatusReportPayloadCandidateSchema, candidate)) {
    return null;
  }

  const payload = candidate;

  return {
    isPublished: payload.isPublished ?? null,
    budgetStage: payload.budgetStage ?? null,
    submittedAt: typeof payload.submittedAt === 'string' ? payload.submittedAt : null,
  };
}

const CityHallContactPayloadCandidateSchema = Type.Object(
  {
    email: Type.Optional(NullableStringSchema),
    phone: Type.Optional(NullableStringSchema),
    submittedAt: Type.Optional(NullableStringSchema),
  },
  { additionalProperties: false }
);

export interface CityHallContactPayload {
  readonly email: string | null;
  readonly phone: string | null;
  readonly submittedAt: string | null;
}

export function parseCityHallContactPayloadValue(
  candidate: unknown
): CityHallContactPayload | null {
  if (!Value.Check(CityHallContactPayloadCandidateSchema, candidate)) {
    return null;
  }

  const payload = candidate;

  return {
    email: typeof payload.email === 'string' ? payload.email : null,
    phone: typeof payload.phone === 'string' ? payload.phone : null,
    submittedAt: typeof payload.submittedAt === 'string' ? payload.submittedAt : null,
  };
}

const ParticipationReportPayloadCandidateSchema = Type.Object(
  {
    debateTookPlace: Type.Optional(
      Type.Union([Type.Literal('yes'), Type.Literal('no'), Type.Literal('dont_know'), Type.Null()])
    ),
    approximateAttendees: Type.Optional(NullableNumberSchema),
    citizensAllowedToSpeak: Type.Optional(
      Type.Union([Type.Literal('yes'), Type.Literal('no'), Type.Literal('partially'), Type.Null()])
    ),
    citizenInputsRecorded: Type.Optional(
      Type.Union([Type.Literal('yes'), Type.Literal('no'), Type.Literal('dont_know'), Type.Null()])
    ),
    observations: Type.Optional(NullableStringSchema),
    submittedAt: Type.Optional(NullableStringSchema),
  },
  { additionalProperties: false }
);

export interface ParticipationReportPayload {
  readonly debateTookPlace: 'yes' | 'no' | 'dont_know' | null;
  readonly approximateAttendees: number | null;
  readonly citizensAllowedToSpeak: 'yes' | 'no' | 'partially' | null;
  readonly citizenInputsRecorded: 'yes' | 'no' | 'dont_know' | null;
  readonly observations: string | null;
  readonly submittedAt: string | null;
}

export function parseParticipationReportPayloadValue(
  candidate: unknown
): ParticipationReportPayload | null {
  if (!Value.Check(ParticipationReportPayloadCandidateSchema, candidate)) {
    return null;
  }

  const payload = candidate;

  return {
    debateTookPlace: payload.debateTookPlace ?? null,
    approximateAttendees:
      typeof payload.approximateAttendees === 'number' ? payload.approximateAttendees : null,
    citizensAllowedToSpeak: payload.citizensAllowedToSpeak ?? null,
    citizenInputsRecorded: payload.citizenInputsRecorded ?? null,
    observations: typeof payload.observations === 'string' ? payload.observations : null,
    submittedAt: typeof payload.submittedAt === 'string' ? payload.submittedAt : null,
  };
}

const ContestationBuilderPayloadCandidateSchema = Type.Object(
  {
    contestedItem: Type.Optional(Type.String()),
    reasoning: Type.Optional(Type.String()),
    impact: Type.Optional(Type.String()),
    proposedChange: Type.Optional(Type.String()),
    senderName: Type.Optional(NullableStringSchema),
    submissionPath: Type.Optional(
      Type.Union([Type.Literal('send_email'), Type.Literal('download_text'), Type.Null()])
    ),
    primariaEmail: Type.Optional(NullableStringSchema),
    submittedAt: Type.Optional(NullableStringSchema),
  },
  { additionalProperties: false }
);

export interface ContestationBuilderPayload {
  readonly contestedItem: string | null;
  readonly reasoning: string | null;
  readonly impact: string | null;
  readonly proposedChange: string | null;
  readonly senderName: string | null;
  readonly submissionPath: 'send_email' | 'download_text' | null;
  readonly primariaEmail: string | null;
  readonly submittedAt: string | null;
}

export function parseContestationBuilderPayloadValue(
  candidate: unknown
): ContestationBuilderPayload | null {
  if (!Value.Check(ContestationBuilderPayloadCandidateSchema, candidate)) {
    return null;
  }

  const payload = candidate;

  return {
    contestedItem: typeof payload.contestedItem === 'string' ? payload.contestedItem : null,
    reasoning: typeof payload.reasoning === 'string' ? payload.reasoning : null,
    impact: typeof payload.impact === 'string' ? payload.impact : null,
    proposedChange: typeof payload.proposedChange === 'string' ? payload.proposedChange : null,
    senderName: typeof payload.senderName === 'string' ? payload.senderName : null,
    submissionPath: payload.submissionPath ?? null,
    primariaEmail: typeof payload.primariaEmail === 'string' ? payload.primariaEmail : null,
    submittedAt: typeof payload.submittedAt === 'string' ? payload.submittedAt : null,
  };
}

export { DEBATE_REQUEST_INTERACTION_ID, parseDebateRequestPayloadValue, type DebateRequestPayload };
