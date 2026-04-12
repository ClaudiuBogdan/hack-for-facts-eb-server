import { FUNKY_CAMPAIGN_ADMIN_PERMISSION, FUNKY_CAMPAIGN_KEY } from '@/common/campaign-keys.js';
import {
  BUDGET_CONTESTATION_INTERACTION_ID,
  BUDGET_DOCUMENT_INTERACTION_ID,
  BUDGET_PUBLICATION_DATE_INTERACTION_ID,
  BUDGET_STATUS_INTERACTION_ID,
  CITY_HALL_WEBSITE_INTERACTION_ID,
  CITY_HALL_CONTACT_INTERACTION_ID,
  CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS,
  DEBATE_REQUEST_INTERACTION_ID,
  PARTICIPATION_REPORT_INTERACTION_ID,
} from '@/common/campaign-user-interactions.js';

import type {
  CampaignAdminCampaignKey,
  CampaignAdminInteractionFilter,
  CampaignAdminSubmissionPath,
} from './types.js';

export type CampaignReviewProjectionKind =
  | 'public_debate_request'
  | 'website_url'
  | 'budget_document'
  | 'budget_publication_date'
  | 'budget_status'
  | 'city_hall_contact'
  | 'participation_report'
  | 'quiz'
  | 'contestation';

export interface CampaignInteractionStepLocation {
  readonly moduleSlug: string;
  readonly challengeSlug: string;
  readonly stepSlug: string;
}

export interface CampaignAdminInteractionConfig {
  readonly campaignKey: CampaignAdminCampaignKey;
  readonly interactionId: string;
  readonly label: string | null;
  readonly projection: CampaignReviewProjectionKind;
  readonly interactionStepLocation: CampaignInteractionStepLocation | null;
  readonly adminAuditVisible: boolean;
  readonly reviewable: boolean;
  readonly reviewableSubmissionPaths?: readonly CampaignAdminSubmissionPath[];
  readonly supportsInstitutionThreadSummary: boolean;
}

export interface CampaignAuditConfig {
  readonly campaignKey: CampaignAdminCampaignKey;
  readonly permissionName: string;
  readonly interactions: readonly CampaignAdminInteractionConfig[];
}

export interface CampaignAdminAvailableInteractionType {
  readonly interactionId: string;
  readonly label: string | null;
  readonly reviewable: boolean;
}

function createCampaignInteractionConfig(
  input: Omit<CampaignAdminInteractionConfig, 'campaignKey' | 'adminAuditVisible'> & {
    readonly campaignKey?: CampaignAdminCampaignKey;
    readonly adminAuditVisible?: boolean;
  }
): CampaignAdminInteractionConfig {
  return {
    campaignKey: input.campaignKey ?? FUNKY_CAMPAIGN_KEY,
    adminAuditVisible: input.adminAuditVisible ?? true,
    ...input,
  };
}

const FUNKY_CIVIC_QUIZ_CONFIGS = [
  createCampaignInteractionConfig({
    interactionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[0],
    label: 'Quiz: Module structure',
    projection: 'quiz',
    interactionStepLocation: {
      moduleSlug: 'civic-campaign',
      challengeSlug: 'civic-intro',
      stepSlug: '01-about-this-challenge',
    },
    reviewable: false,
    supportsInstitutionThreadSummary: false,
  }),
  createCampaignInteractionConfig({
    interactionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[1],
    label: 'Quiz: Why the local budget matters',
    projection: 'quiz',
    interactionStepLocation: {
      moduleSlug: 'civic-campaign',
      challengeSlug: 'civic-intro',
      stepSlug: '01-about-this-challenge',
    },
    reviewable: false,
    supportsInstitutionThreadSummary: false,
  }),
  createCampaignInteractionConfig({
    interactionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[2],
    label: 'Quiz: Budget consultation actions',
    projection: 'quiz',
    interactionStepLocation: {
      moduleSlug: 'civic-campaign',
      challengeSlug: 'civic-intro',
      stepSlug: '01-about-this-challenge',
    },
    reviewable: false,
    supportsInstitutionThreadSummary: false,
  }),
  createCampaignInteractionConfig({
    interactionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[3],
    label: 'Quiz: Budget proposer',
    projection: 'quiz',
    interactionStepLocation: {
      moduleSlug: 'civic-campaign',
      challengeSlug: 'civic-intro',
      stepSlug: '02-budget-calendar-and-rights',
    },
    reviewable: false,
    supportsInstitutionThreadSummary: false,
  }),
  createCampaignInteractionConfig({
    interactionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[4],
    label: 'Quiz: Contestation deadline',
    projection: 'quiz',
    interactionStepLocation: {
      moduleSlug: 'civic-campaign',
      challengeSlug: 'civic-intro',
      stepSlug: '02-budget-calendar-and-rights',
    },
    reviewable: false,
    supportsInstitutionThreadSummary: false,
  }),
  createCampaignInteractionConfig({
    interactionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[5],
    label: 'Quiz: Right to a public debate',
    projection: 'quiz',
    interactionStepLocation: {
      moduleSlug: 'civic-campaign',
      challengeSlug: 'civic-intro',
      stepSlug: '02-budget-calendar-and-rights',
    },
    reviewable: false,
    supportsInstitutionThreadSummary: false,
  }),
  createCampaignInteractionConfig({
    interactionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[6],
    label: 'Quiz: Why budget status matters',
    projection: 'quiz',
    interactionStepLocation: {
      moduleSlug: 'civic-campaign',
      challengeSlug: 'civic-monitor-and-request',
      stepSlug: '03-budget-status-2026',
    },
    reviewable: false,
    supportsInstitutionThreadSummary: false,
  }),
  createCampaignInteractionConfig({
    interactionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[7],
    label: 'Quiz: Why request a debate',
    projection: 'quiz',
    interactionStepLocation: {
      moduleSlug: 'civic-campaign',
      challengeSlug: 'civic-monitor-and-request',
      stepSlug: '04-debate-request',
    },
    reviewable: false,
    supportsInstitutionThreadSummary: false,
  }),
  createCampaignInteractionConfig({
    interactionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[8],
    label: 'Quiz: Debate request follow-up',
    projection: 'quiz',
    interactionStepLocation: {
      moduleSlug: 'civic-campaign',
      challengeSlug: 'civic-monitor-and-request',
      stepSlug: '04-debate-request',
    },
    reviewable: false,
    supportsInstitutionThreadSummary: false,
  }),
  createCampaignInteractionConfig({
    interactionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[9],
    label: 'Quiz: Debate preparation',
    projection: 'quiz',
    interactionStepLocation: {
      moduleSlug: 'civic-campaign',
      challengeSlug: 'civic-participate-and-act',
      stepSlug: '05-participation-report',
    },
    reviewable: false,
    supportsInstitutionThreadSummary: false,
  }),
  createCampaignInteractionConfig({
    interactionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[10],
    label: 'Quiz: What makes a contestation effective',
    projection: 'quiz',
    interactionStepLocation: {
      moduleSlug: 'civic-campaign',
      challengeSlug: 'civic-participate-and-act',
      stepSlug: '06-contestation',
    },
    reviewable: false,
    supportsInstitutionThreadSummary: false,
  }),
] as const satisfies readonly CampaignAdminInteractionConfig[];

// Maintenance note: check /docs/guides/INTERACTIVE-ELEMENT-CHECKS-AND-TRIGGERS.md.
const CAMPAIGN_REVIEW_CONFIGS: Readonly<Record<CampaignAdminCampaignKey, CampaignAuditConfig>> = {
  [FUNKY_CAMPAIGN_KEY]: {
    campaignKey: FUNKY_CAMPAIGN_KEY,
    permissionName: FUNKY_CAMPAIGN_ADMIN_PERMISSION,
    interactions: [
      createCampaignInteractionConfig({
        interactionId: DEBATE_REQUEST_INTERACTION_ID,
        label: 'Public debate request',
        projection: 'public_debate_request',
        interactionStepLocation: {
          moduleSlug: 'civic-campaign',
          challengeSlug: 'civic-monitor-and-request',
          stepSlug: '04-debate-request',
        },
        reviewable: true,
        reviewableSubmissionPaths: ['request_platform'],
        supportsInstitutionThreadSummary: true,
      }),
      createCampaignInteractionConfig({
        interactionId: CITY_HALL_WEBSITE_INTERACTION_ID,
        label: 'City hall website',
        projection: 'website_url',
        interactionStepLocation: {
          moduleSlug: 'civic-campaign',
          challengeSlug: 'civic-monitor-and-request',
          stepSlug: '03-budget-status-2026',
        },
        reviewable: true,
        supportsInstitutionThreadSummary: false,
      }),
      createCampaignInteractionConfig({
        interactionId: BUDGET_DOCUMENT_INTERACTION_ID,
        label: 'Budget document',
        projection: 'budget_document',
        interactionStepLocation: {
          moduleSlug: 'civic-campaign',
          challengeSlug: 'civic-monitor-and-request',
          stepSlug: '03-budget-status-2026',
        },
        reviewable: true,
        supportsInstitutionThreadSummary: false,
      }),
      createCampaignInteractionConfig({
        interactionId: BUDGET_PUBLICATION_DATE_INTERACTION_ID,
        label: 'Budget publication date',
        projection: 'budget_publication_date',
        interactionStepLocation: {
          moduleSlug: 'civic-campaign',
          challengeSlug: 'civic-monitor-and-request',
          stepSlug: '03-budget-status-2026',
        },
        reviewable: true,
        supportsInstitutionThreadSummary: false,
      }),
      createCampaignInteractionConfig({
        interactionId: BUDGET_STATUS_INTERACTION_ID,
        label: 'Budget status',
        projection: 'budget_status',
        interactionStepLocation: {
          moduleSlug: 'civic-campaign',
          challengeSlug: 'civic-monitor-and-request',
          stepSlug: '03-budget-status-2026',
        },
        reviewable: true,
        supportsInstitutionThreadSummary: false,
      }),
      createCampaignInteractionConfig({
        interactionId: CITY_HALL_CONTACT_INTERACTION_ID,
        label: 'City hall contact',
        projection: 'city_hall_contact',
        interactionStepLocation: {
          moduleSlug: 'civic-campaign',
          challengeSlug: 'civic-monitor-and-request',
          stepSlug: '04-debate-request',
        },
        reviewable: true,
        supportsInstitutionThreadSummary: false,
      }),
      createCampaignInteractionConfig({
        interactionId: PARTICIPATION_REPORT_INTERACTION_ID,
        label: 'Participation report',
        projection: 'participation_report',
        interactionStepLocation: {
          moduleSlug: 'civic-campaign',
          challengeSlug: 'civic-participate-and-act',
          stepSlug: '05-participation-report',
        },
        reviewable: false,
        supportsInstitutionThreadSummary: false,
      }),
      createCampaignInteractionConfig({
        interactionId: BUDGET_CONTESTATION_INTERACTION_ID,
        label: 'Budget contestation',
        projection: 'contestation',
        interactionStepLocation: {
          moduleSlug: 'civic-campaign',
          challengeSlug: 'civic-participate-and-act',
          stepSlug: '06-contestation',
        },
        reviewable: true,
        supportsInstitutionThreadSummary: false,
      }),
      ...FUNKY_CIVIC_QUIZ_CONFIGS,
    ],
  },
};

export const CAMPAIGN_ADMIN_REVIEW_CAMPAIGN_KEYS = Object.freeze(
  Object.keys(CAMPAIGN_REVIEW_CONFIGS) as CampaignAdminCampaignKey[]
);

export function getCampaignAdminReviewConfig(campaignKey: string): CampaignAuditConfig | null {
  const configMap = CAMPAIGN_REVIEW_CONFIGS as Partial<Record<string, CampaignAuditConfig>>;
  return configMap[campaignKey] ?? null;
}

export function getCampaignAdminInteractionConfig(
  config: CampaignAuditConfig,
  interactionId: string
): CampaignAdminInteractionConfig | null {
  return (
    config.interactions.find((interaction) => interaction.interactionId === interactionId) ?? null
  );
}

export function selectCampaignAdminAuditVisibleInteractions(input: {
  config: CampaignAuditConfig;
  interactionId?: string;
  requiresInstitutionThreadSummary: boolean;
}): readonly CampaignAdminInteractionConfig[] {
  let interactions = input.config.interactions.filter(
    (interaction) => interaction.adminAuditVisible
  );

  if (input.interactionId !== undefined) {
    interactions = interactions.filter(
      (interaction) => interaction.interactionId === input.interactionId
    );
  }

  if (input.requiresInstitutionThreadSummary) {
    interactions = interactions.filter(
      (interaction) => interaction.supportsInstitutionThreadSummary
    );
  }

  return interactions;
}

export function buildCampaignInteractionFilters(input: {
  interactions: readonly CampaignAdminInteractionConfig[];
  kind: 'visible' | 'reviewable' | 'thread_summary';
}): readonly CampaignAdminInteractionFilter[] {
  return input.interactions.flatMap((interaction) => {
    if (input.kind === 'visible') {
      return interaction.adminAuditVisible ? [{ interactionId: interaction.interactionId }] : [];
    }

    if (input.kind === 'reviewable') {
      if (!interaction.reviewable) {
        return [];
      }

      return interaction.reviewableSubmissionPaths === undefined
        ? [{ interactionId: interaction.interactionId }]
        : interaction.reviewableSubmissionPaths.map((submissionPath) => ({
            interactionId: interaction.interactionId,
            submissionPath,
          }));
    }

    if (!interaction.supportsInstitutionThreadSummary) {
      return [];
    }

    return interaction.reviewableSubmissionPaths === undefined
      ? [{ interactionId: interaction.interactionId }]
      : interaction.reviewableSubmissionPaths.map((submissionPath) => ({
          interactionId: interaction.interactionId,
          submissionPath,
        }));
  });
}

export function listCampaignAdminAvailableInteractionTypes(
  config: CampaignAuditConfig
): readonly CampaignAdminAvailableInteractionType[] {
  return config.interactions
    .filter((interaction) => interaction.adminAuditVisible)
    .map((interaction) => ({
      interactionId: interaction.interactionId,
      label: interaction.label,
      reviewable: interaction.reviewable,
    }));
}
