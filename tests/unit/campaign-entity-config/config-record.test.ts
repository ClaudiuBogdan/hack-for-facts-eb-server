import { describe, expect, it } from 'vitest';

import {
  buildNextCampaignEntityConfigCursor,
  buildCampaignEntityConfigRecordKey,
  buildCampaignEntityConfigUserId,
  compareCampaignEntityConfigDtos,
  createCampaignEntityConfigRecord,
  normalizeCampaignEntityConfigValues,
  parseCampaignEntityConfigRecord,
  resolveCampaignEntityConfigPageStartIndex,
} from '@/modules/campaign-entity-config/core/config-record.js';

import type { LearningProgressRecordRow } from '@/modules/learning-progress/index.js';

function makeRow(
  record: LearningProgressRecordRow['record'],
  overrides?: Partial<LearningProgressRecordRow>
): LearningProgressRecordRow {
  return {
    userId: buildCampaignEntityConfigUserId('funky'),
    recordKey: record.key,
    record,
    auditEvents: [],
    updatedSeq: '1',
    createdAt: '2026-04-18T10:00:00.000Z',
    updatedAt: '2026-04-18T10:00:00.000Z',
    ...overrides,
  };
}

function getJsonValue(record: LearningProgressRecordRow['record']): Record<string, unknown> {
  if (record.value?.kind !== 'json') {
    throw new Error('Expected a json interaction value in test setup.');
  }

  return record.value.json.value;
}

describe('campaign entity config record helpers', () => {
  it('normalizes https officialBudgetUrl values', () => {
    const result = normalizeCampaignEntityConfigValues({
      budgetPublicationDate: '2026-02-01',
      officialBudgetUrl: 'https://example.com/budget.pdf',
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      budgetPublicationDate: '2026-02-01',
      officialBudgetUrl: 'https://example.com/budget.pdf',
    });
  });

  it('normalizes http officialBudgetUrl values', () => {
    const result = normalizeCampaignEntityConfigValues({
      budgetPublicationDate: '2026-02-01',
      officialBudgetUrl: '  HTTP://example.com/budget.pdf  ',
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      budgetPublicationDate: '2026-02-01',
      officialBudgetUrl: 'http://example.com/budget.pdf',
    });
  });

  it('rejects invalid business dates', () => {
    const result = normalizeCampaignEntityConfigValues({
      budgetPublicationDate: '2026-02-30',
      officialBudgetUrl: 'https://example.com/budget.pdf',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('budgetPublicationDate');
  });

  it('rejects invalid urls', () => {
    const result = normalizeCampaignEntityConfigValues({
      budgetPublicationDate: '2026-02-01',
      officialBudgetUrl: 'budget.pdf',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('officialBudgetUrl');
  });

  it.each(['javascript:', 'data:', 'file:', 'mailto:', 'ftp:'])(
    'rejects non-http officialBudgetUrl schemes: %s',
    (scheme) => {
      const result = normalizeCampaignEntityConfigValues({
        budgetPublicationDate: '2026-02-01',
        officialBudgetUrl: `${scheme}//example.com/budget.pdf`,
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('officialBudgetUrl');
    }
  );

  it('rejects additional properties', () => {
    const result = normalizeCampaignEntityConfigValues({
      budgetPublicationDate: '2026-02-01',
      officialBudgetUrl: 'https://example.com/budget.pdf',
      extraField: 'nope',
    });

    expect(result.isErr()).toBe(true);
  });

  it('rejects all-null values', () => {
    const result = normalizeCampaignEntityConfigValues({
      budgetPublicationDate: null,
      officialBudgetUrl: null,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('At least one');
  });

  it('rejects persisted rows with an unsupported payload version', () => {
    const baseRecord = createCampaignEntityConfigRecord({
      campaignKey: 'funky',
      entityCui: '12345678',
      values: {
        budgetPublicationDate: '2026-02-01',
        officialBudgetUrl: 'https://example.com/budget.pdf',
      },
      actorUserId: 'admin-1',
      recordUpdatedAt: '2026-04-18T10:00:00.000Z',
    });

    const row = makeRow({
      ...baseRecord,
      value: {
        kind: 'json',
        json: {
          value: {
            ...getJsonValue(baseRecord),
            version: 2,
          },
        },
      },
    });

    const result = parseCampaignEntityConfigRecord({
      campaignKey: 'funky',
      row,
      expectedEntityCui: '12345678',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'DatabaseError',
      retryable: false,
    });
  });

  it('rejects persisted rows whose payload identity mismatches the synthetic key', () => {
    const baseRecord = createCampaignEntityConfigRecord({
      campaignKey: 'funky',
      entityCui: '12345678',
      values: {
        budgetPublicationDate: '2026-02-01',
        officialBudgetUrl: 'https://example.com/budget.pdf',
      },
      actorUserId: 'admin-1',
      recordUpdatedAt: '2026-04-18T10:00:00.000Z',
    });

    const row = makeRow({
      ...baseRecord,
      value: {
        kind: 'json',
        json: {
          value: {
            ...getJsonValue(baseRecord),
            entityCui: '87654321',
          },
        },
      },
    });

    const result = parseCampaignEntityConfigRecord({
      campaignKey: 'funky',
      row: {
        ...row,
        recordKey: buildCampaignEntityConfigRecordKey('12345678'),
      },
      expectedEntityCui: '12345678',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'DatabaseError',
      retryable: false,
    });
  });

  it('sorts null updatedAt values after real timestamps for desc updatedAt ordering', () => {
    const configuredItem = {
      campaignKey: 'funky' as const,
      entityCui: '12345678',
      entityName: null,
      isConfigured: true,
      values: {
        budgetPublicationDate: '2026-02-01',
        officialBudgetUrl: 'https://example.com/budget.pdf',
      },
      updatedAt: '2026-04-18T12:00:00.000Z',
      updatedByUserId: 'admin-1',
    };
    const unconfiguredItem = {
      campaignKey: 'funky' as const,
      entityCui: '87654321',
      entityName: null,
      isConfigured: false,
      values: {
        budgetPublicationDate: null,
        officialBudgetUrl: null,
      },
      updatedAt: null,
      updatedByUserId: null,
    };

    const comparison = compareCampaignEntityConfigDtos({
      left: configuredItem,
      right: unconfiguredItem,
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    });

    expect(comparison).toBeLessThan(0);
  });

  it('includes updatedAt in the next-page cursor and resumes updatedAt sorts from the cursor position', () => {
    const items = [
      {
        campaignKey: 'funky' as const,
        entityCui: '22222222',
        entityName: null,
        isConfigured: true,
        values: {
          budgetPublicationDate: '2026-02-02',
          officialBudgetUrl: 'https://example.com/2.pdf',
        },
        updatedAt: '2026-04-18T13:00:00.000Z',
        updatedByUserId: 'admin-2',
      },
      {
        campaignKey: 'funky' as const,
        entityCui: '11111111',
        entityName: null,
        isConfigured: true,
        values: {
          budgetPublicationDate: '2026-02-01',
          officialBudgetUrl: 'https://example.com/1.pdf',
        },
        updatedAt: '2026-04-18T12:00:00.000Z',
        updatedByUserId: 'admin-1',
      },
      {
        campaignKey: 'funky' as const,
        entityCui: '33333333',
        entityName: null,
        isConfigured: true,
        values: {
          budgetPublicationDate: '2026-02-03',
          officialBudgetUrl: 'https://example.com/3.pdf',
        },
        updatedAt: '2026-04-18T10:00:00.000Z',
        updatedByUserId: 'admin-3',
      },
      {
        campaignKey: 'funky' as const,
        entityCui: '44444444',
        entityName: null,
        isConfigured: true,
        values: {
          budgetPublicationDate: '2026-02-04',
          officialBudgetUrl: 'https://example.com/4.pdf',
        },
        updatedAt: '2026-04-18T09:00:00.000Z',
        updatedByUserId: 'admin-4',
      },
    ];

    const cursor = buildNextCampaignEntityConfigCursor({
      items: [
        {
          campaignKey: 'funky' as const,
          entityCui: '11111111',
          entityName: null,
          isConfigured: true,
          values: {
            budgetPublicationDate: '2026-02-01',
            officialBudgetUrl: 'https://example.com/1.pdf',
          },
          updatedAt: '2026-04-18T11:00:00.000Z',
          updatedByUserId: 'admin-1',
        },
        {
          campaignKey: 'funky' as const,
          entityCui: '22222222',
          entityName: null,
          isConfigured: true,
          values: {
            budgetPublicationDate: '2026-02-02',
            officialBudgetUrl: 'https://example.com/2.pdf',
          },
          updatedAt: '2026-04-18T11:00:00.000Z',
          updatedByUserId: 'admin-2',
        },
      ],
      hasMore: true,
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    });

    expect(cursor).toEqual({
      sortBy: 'updatedAt',
      sortOrder: 'desc',
      updatedAt: '2026-04-18T11:00:00.000Z',
      entityCui: '22222222',
    });

    const pageStartIndexResult = resolveCampaignEntityConfigPageStartIndex({
      items,
      sortBy: 'updatedAt',
      sortOrder: 'desc',
      cursor: cursor ?? undefined,
    });

    expect(pageStartIndexResult.isOk()).toBe(true);
    expect(pageStartIndexResult._unsafeUnwrap()).toBe(2);
  });
});
