import { Type, type Static } from '@sinclair/typebox';

import { CampaignEntityConfigValuesSchema } from '../../core/config-record.js';

export const CampaignKeyParamsSchema = Type.Object(
  {
    campaignKey: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const CampaignEntityConfigParamsSchema = Type.Object(
  {
    campaignKey: Type.String({ minLength: 1 }),
    entityCui: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const CampaignEntityConfigSortBySchema = Type.Union([
  Type.Literal('updatedAt'),
  Type.Literal('entityCui'),
  Type.Literal('budgetPublicationDate'),
  Type.Literal('officialBudgetUrl'),
]);

export const CampaignEntityConfigSortOrderSchema = Type.Union([
  Type.Literal('asc'),
  Type.Literal('desc'),
]);

export const CampaignEntityConfigCursorSchema = Type.Object(
  {
    value: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    entityCui: Type.String({ minLength: 1 }),
    sortBy: CampaignEntityConfigSortBySchema,
    sortOrder: CampaignEntityConfigSortOrderSchema,
  },
  { additionalProperties: false }
);

export const CampaignEntityConfigListQuerySchema = Type.Object(
  {
    query: Type.Optional(Type.String({ maxLength: 0 })),
    entityCui: Type.Optional(Type.String()),
    budgetPublicationDate: Type.Optional(Type.String({ format: 'date' })),
    hasBudgetPublicationDate: Type.Optional(Type.Boolean()),
    officialBudgetUrl: Type.Optional(Type.String()),
    hasOfficialBudgetUrl: Type.Optional(Type.Boolean()),
    updatedAtFrom: Type.Optional(Type.String({ format: 'date-time' })),
    updatedAtTo: Type.Optional(Type.String({ format: 'date-time' })),
    sortBy: Type.Optional(CampaignEntityConfigSortBySchema),
    sortOrder: Type.Optional(CampaignEntityConfigSortOrderSchema),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 50 })),
  },
  { additionalProperties: false }
);

export const CampaignEntityConfigExportQuerySchema = Type.Object(
  {
    query: Type.Optional(Type.String()),
    entityCui: Type.Optional(Type.String()),
    budgetPublicationDate: Type.Optional(Type.String({ format: 'date' })),
    hasBudgetPublicationDate: Type.Optional(Type.Boolean()),
    officialBudgetUrl: Type.Optional(Type.String()),
    hasOfficialBudgetUrl: Type.Optional(Type.Boolean()),
    updatedAtFrom: Type.Optional(Type.String({ format: 'date-time' })),
    updatedAtTo: Type.Optional(Type.String({ format: 'date-time' })),
    sortBy: Type.Optional(CampaignEntityConfigSortBySchema),
    sortOrder: Type.Optional(CampaignEntityConfigSortOrderSchema),
  },
  { additionalProperties: false }
);

export const CampaignEntityConfigPutBodySchema = Type.Object(
  {
    expectedUpdatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    values: CampaignEntityConfigValuesSchema,
  },
  { additionalProperties: false }
);

export const CampaignEntityConfigDtoSchema = Type.Object(
  {
    campaignKey: Type.Literal('funky'),
    entityCui: Type.String({ minLength: 1 }),
    entityName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    isConfigured: Type.Boolean(),
    values: CampaignEntityConfigValuesSchema,
    updatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    updatedByUserId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false }
);

export const CampaignEntityConfigResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: CampaignEntityConfigDtoSchema,
  },
  { additionalProperties: false }
);

export const CampaignEntityConfigListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        items: Type.Array(CampaignEntityConfigDtoSchema),
        page: Type.Object(
          {
            limit: Type.Number({ minimum: 1 }),
            totalCount: Type.Number({ minimum: 0 }),
            hasMore: Type.Boolean(),
            nextCursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
            sortBy: CampaignEntityConfigSortBySchema,
            sortOrder: CampaignEntityConfigSortOrderSchema,
          },
          { additionalProperties: false }
        ),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const ErrorResponseSchema = Type.Object(
  {
    ok: Type.Optional(Type.Literal(false)),
    error: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false }
);

export type CampaignKeyParams = Static<typeof CampaignKeyParamsSchema>;
export type CampaignEntityConfigParams = Static<typeof CampaignEntityConfigParamsSchema>;
export type CampaignEntityConfigListQuery = Static<typeof CampaignEntityConfigListQuerySchema>;
export type CampaignEntityConfigExportQuery = Static<typeof CampaignEntityConfigExportQuerySchema>;
export type CampaignEntityConfigPutBody = Static<typeof CampaignEntityConfigPutBodySchema>;
