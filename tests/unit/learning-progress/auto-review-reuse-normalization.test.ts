import { describe, expect, it } from 'vitest';

import { normalizeAutoReviewReuseRecord } from '@/modules/learning-progress/core/auto-review-reuse-normalization.js';

import { createTestInteractiveRecord } from '../../fixtures/fakes.js';

describe('normalizeAutoReviewReuseRecord', () => {
  it('normalizes website records from url values', () => {
    const result = normalizeAutoReviewReuseRecord(
      createTestInteractiveRecord({
        key: 'funky:interaction:city_hall_website::entity:12345678',
        interactionId: 'funky:interaction:city_hall_website',
        kind: 'url',
        phase: 'pending',
        value: {
          kind: 'url',
          url: {
            value: ' https://primarie.test/portal ',
          },
        },
      })
    );

    expect(result).toEqual({
      kind: 'supported',
      value: {
        kind: 'website_url',
        websiteUrl: 'https://primarie.test/portal',
      },
    });
  });

  it('sorts and deduplicates budget document types while dropping submittedAt', () => {
    const result = normalizeAutoReviewReuseRecord(
      createTestInteractiveRecord({
        key: 'funky:interaction:budget_document::entity:12345678',
        interactionId: 'funky:interaction:budget_document',
        kind: 'custom',
        phase: 'pending',
        value: {
          kind: 'json',
          json: {
            value: {
              documentUrl: ' https://primarie.test/buget.pdf ',
              documentTypes: ['word', 'pdf', 'word'],
              submittedAt: '2026-04-16T10:00:00.000Z',
            },
          },
        },
      })
    );

    expect(result).toEqual({
      kind: 'supported',
      value: {
        kind: 'budget_document',
        documentUrl: 'https://primarie.test/buget.pdf',
        documentTypes: ['pdf', 'word'],
      },
    });
  });

  it('sorts publication sources deterministically and trims source urls', () => {
    const result = normalizeAutoReviewReuseRecord(
      createTestInteractiveRecord({
        key: 'funky:interaction:budget_publication_date::entity:12345678',
        interactionId: 'funky:interaction:budget_publication_date',
        kind: 'custom',
        phase: 'pending',
        value: {
          kind: 'json',
          json: {
            value: {
              publicationDate: ' 2026-03-31 ',
              submittedAt: '2026-04-16T10:00:00.000Z',
              sources: [
                {
                  type: 'website',
                  url: ' https://primarie.test/source-b ',
                },
                {
                  type: 'other',
                  url: 'https://primarie.test/source-a',
                },
              ],
            },
          },
        },
      })
    );

    expect(result).toEqual({
      kind: 'supported',
      value: {
        kind: 'budget_publication_date',
        publicationDate: '2026-03-31',
        sources: [
          {
            type: 'other',
            url: 'https://primarie.test/source-a',
          },
          {
            type: 'website',
            url: 'https://primarie.test/source-b',
          },
        ],
      },
    });
  });

  it('lowercases city hall contact emails', () => {
    const result = normalizeAutoReviewReuseRecord(
      createTestInteractiveRecord({
        key: 'funky:interaction:city_hall_contact::entity:12345678',
        interactionId: 'funky:interaction:city_hall_contact',
        kind: 'custom',
        phase: 'pending',
        value: {
          kind: 'json',
          json: {
            value: {
              email: ' CONTACT@PRIMARIE.TEST ',
              phone: ' 0269-123-456 ',
              submittedAt: '2026-04-16T10:00:00.000Z',
            },
          },
        },
      })
    );

    expect(result).toEqual({
      kind: 'supported',
      value: {
        kind: 'city_hall_contact',
        email: 'contact@primarie.test',
        phone: '0269-123-456',
      },
    });
  });

  it('returns unsupported for interactions outside the allowlist', () => {
    const result = normalizeAutoReviewReuseRecord(
      createTestInteractiveRecord({
        key: 'funky:interaction:public_debate_request::entity:12345678',
        interactionId: 'funky:interaction:public_debate_request',
        kind: 'custom',
        phase: 'pending',
        value: {
          kind: 'json',
          json: {
            value: {
              primariaEmail: 'contact@primarie.test',
              submissionPath: 'request_platform',
              submittedAt: '2026-04-16T10:00:00.000Z',
            },
          },
        },
      })
    );

    expect(result).toEqual({
      kind: 'unsupported',
    });
  });

  it('returns invalid for malformed allowlisted payloads', () => {
    const result = normalizeAutoReviewReuseRecord(
      createTestInteractiveRecord({
        key: 'funky:interaction:budget_status::entity:12345678',
        interactionId: 'funky:interaction:budget_status',
        kind: 'custom',
        phase: 'pending',
        value: {
          kind: 'json',
          json: {
            value: {
              isPublished: 'sometimes',
            },
          },
        },
      })
    );

    expect(result).toEqual({
      kind: 'invalid',
    });
  });
});
