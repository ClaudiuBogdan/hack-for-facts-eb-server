import {
  BUDGET_DOCUMENT_INTERACTION_ID,
  BUDGET_PUBLICATION_DATE_INTERACTION_ID,
  BUDGET_STATUS_INTERACTION_ID,
  CITY_HALL_CONTACT_INTERACTION_ID,
  CITY_HALL_WEBSITE_INTERACTION_ID,
  parseBudgetDocumentPayloadValue,
  parseBudgetPublicationDatePayloadValue,
  parseBudgetStatusReportPayloadValue,
  parseCityHallContactPayloadValue,
  parseWebsiteLinkPayloadValue,
} from '@/common/campaign-user-interactions.js';

import type { InteractiveStateRecord } from './types.js';

export type AutoReviewReuseNormalizedValue =
  | {
      readonly kind: 'website_url';
      readonly websiteUrl: string | null;
    }
  | {
      readonly kind: 'budget_document';
      readonly documentUrl: string | null;
      readonly documentTypes: readonly (
        | 'excel'
        | 'graphics'
        | 'other'
        | 'pdf'
        | 'webpage'
        | 'word'
      )[];
    }
  | {
      readonly kind: 'budget_publication_date';
      readonly publicationDate: string | null;
      readonly sources: readonly {
        readonly type: 'other' | 'press' | 'social_media' | 'website';
        readonly url: string | null;
      }[];
    }
  | {
      readonly kind: 'budget_status';
      readonly isPublished: 'dont_know' | 'no' | 'yes' | null;
      readonly budgetStage: 'approved' | 'draft' | null;
    }
  | {
      readonly kind: 'city_hall_contact';
      readonly email: string | null;
      readonly phone: string | null;
    };

export type NormalizeAutoReviewReuseRecordResult =
  | {
      readonly kind: 'supported';
      readonly value: AutoReviewReuseNormalizedValue;
    }
  | {
      readonly kind: 'unsupported';
    }
  | {
      readonly kind: 'invalid';
    };

function toNullableTrimmedString(value: string | null | undefined): string | null {
  const trimmedValue = value?.trim();
  return trimmedValue === undefined || trimmedValue === '' ? null : trimmedValue;
}

function sortBudgetDocumentTypes(
  documentTypes: readonly ('excel' | 'graphics' | 'other' | 'pdf' | 'webpage' | 'word')[]
): readonly ('excel' | 'graphics' | 'other' | 'pdf' | 'webpage' | 'word')[] {
  return [...new Set(documentTypes)].sort((leftValue, rightValue) =>
    leftValue.localeCompare(rightValue)
  );
}

function sortPublicationSources(
  sources: readonly {
    type: 'other' | 'press' | 'social_media' | 'website';
    url: string | null;
  }[]
): readonly {
  readonly type: 'other' | 'press' | 'social_media' | 'website';
  readonly url: string | null;
}[] {
  return [...sources]
    .map((source) => ({
      type: source.type,
      url: toNullableTrimmedString(source.url),
    }))
    .sort((leftSource, rightSource) => {
      const leftKey = `${leftSource.type}:${leftSource.url ?? ''}`;
      const rightKey = `${rightSource.type}:${rightSource.url ?? ''}`;
      return leftKey.localeCompare(rightKey);
    });
}

export function normalizeAutoReviewReuseRecord(
  record: Pick<InteractiveStateRecord, 'interactionId' | 'value'>
): NormalizeAutoReviewReuseRecordResult {
  switch (record.interactionId) {
    case CITY_HALL_WEBSITE_INTERACTION_ID: {
      if (record.value === null) {
        return { kind: 'invalid' };
      }

      if (record.value.kind === 'url') {
        return {
          kind: 'supported',
          value: {
            kind: 'website_url',
            websiteUrl: toNullableTrimmedString(record.value.url.value),
          },
        };
      }

      if (record.value.kind !== 'json') {
        return { kind: 'invalid' };
      }

      const payload = parseWebsiteLinkPayloadValue(record.value.json.value);
      if (payload === null) {
        return { kind: 'invalid' };
      }

      return {
        kind: 'supported',
        value: {
          kind: 'website_url',
          websiteUrl: toNullableTrimmedString(payload.websiteUrl),
        },
      };
    }
    case BUDGET_DOCUMENT_INTERACTION_ID: {
      if (record.value?.kind !== 'json') {
        return { kind: 'invalid' };
      }

      const payload = parseBudgetDocumentPayloadValue(record.value.json.value);
      if (payload === null) {
        return { kind: 'invalid' };
      }

      return {
        kind: 'supported',
        value: {
          kind: 'budget_document',
          documentUrl: toNullableTrimmedString(payload.documentUrl),
          documentTypes: sortBudgetDocumentTypes(payload.documentTypes),
        },
      };
    }
    case BUDGET_PUBLICATION_DATE_INTERACTION_ID: {
      if (record.value?.kind !== 'json') {
        return { kind: 'invalid' };
      }

      const payload = parseBudgetPublicationDatePayloadValue(record.value.json.value);
      if (payload === null) {
        return { kind: 'invalid' };
      }

      return {
        kind: 'supported',
        value: {
          kind: 'budget_publication_date',
          publicationDate: toNullableTrimmedString(payload.publicationDate),
          sources: sortPublicationSources(payload.sources),
        },
      };
    }
    case BUDGET_STATUS_INTERACTION_ID: {
      if (record.value?.kind !== 'json') {
        return { kind: 'invalid' };
      }

      const payload = parseBudgetStatusReportPayloadValue(record.value.json.value);
      if (payload === null) {
        return { kind: 'invalid' };
      }

      return {
        kind: 'supported',
        value: {
          kind: 'budget_status',
          isPublished: payload.isPublished,
          budgetStage: payload.budgetStage,
        },
      };
    }
    case CITY_HALL_CONTACT_INTERACTION_ID: {
      if (record.value?.kind !== 'json') {
        return { kind: 'invalid' };
      }

      const payload = parseCityHallContactPayloadValue(record.value.json.value);
      if (payload === null) {
        return { kind: 'invalid' };
      }

      return {
        kind: 'supported',
        value: {
          kind: 'city_hall_contact',
          email: toNullableTrimmedString(payload.email)?.toLowerCase() ?? null,
          phone: toNullableTrimmedString(payload.phone),
        },
      };
    }
    default:
      return { kind: 'unsupported' };
  }
}
