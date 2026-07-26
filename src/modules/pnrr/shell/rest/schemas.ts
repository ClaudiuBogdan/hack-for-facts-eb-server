import { Type, type Static } from '@sinclair/typebox';

export const PnrrScopeQuerySchema = Type.Object(
  {
    componentCode: Type.Optional(Type.String({ maxLength: 32 })),
    beneficiaryCui: Type.Optional(Type.String({ maxLength: 32 })),
    countySiruta: Type.Optional(Type.String({ maxLength: 16 })),
    from: Type.Optional(Type.String({ format: 'date' })),
    to: Type.Optional(Type.String({ format: 'date' })),
    currency: Type.Optional(Type.Union([Type.Literal('RON'), Type.Literal('EUR')])),
    assertReleaseId: Type.Optional(Type.String({ maxLength: 160 })),
  },
  { additionalProperties: false }
);

export const PnrrProjectsQuerySchema = Type.Intersect([
  PnrrScopeQuerySchema,
  Type.Object(
    {
      contractNumber: Type.Optional(Type.String({ maxLength: 200 })),
      measureCode: Type.Optional(Type.String({ maxLength: 64 })),
      status: Type.Optional(Type.String({ maxLength: 100 })),
      first: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
      after: Type.Optional(Type.String({ maxLength: 4096 })),
    },
    { additionalProperties: false }
  ),
]);

export const PnrrOrganizationsQuerySchema = Type.Object(
  {
    q: Type.Optional(Type.String({ maxLength: 200 })),
    cui: Type.Optional(Type.String({ maxLength: 32 })),
    role: Type.Optional(
      Type.Union([
        Type.Literal('beneficiary'),
        Type.Literal('applicant'),
        Type.Literal('winner'),
        Type.Literal('subcontractor'),
      ])
    ),
    hub: Type.Optional(Type.Union([Type.Literal('public_entities'), Type.Literal('companies')])),
    first: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
    after: Type.Optional(Type.String({ maxLength: 4096 })),
    assertReleaseId: Type.Optional(Type.String({ maxLength: 160 })),
  },
  { additionalProperties: false }
);

export const PnrrPageQuerySchema = Type.Object(
  {
    first: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
    after: Type.Optional(Type.String({ maxLength: 4096 })),
    assertReleaseId: Type.Optional(Type.String({ maxLength: 160 })),
  },
  { additionalProperties: false }
);

export const PnrrReleaseQuerySchema = Type.Object(
  {
    assertReleaseId: Type.Optional(Type.String({ maxLength: 160 })),
  },
  { additionalProperties: false }
);

export const PnrrKeyParamsSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false }
);

export const PnrrCuiParamsSchema = Type.Object(
  {
    cui: Type.String({ minLength: 1, maxLength: 32 }),
  },
  { additionalProperties: false }
);

export const PnrrCountyParamsSchema = Type.Object(
  {
    siruta: Type.String({ minLength: 1, maxLength: 16, pattern: '^[0-9]+$' }),
  },
  { additionalProperties: false }
);

export const PnrrSuccessSchema = Type.Object({
  ok: Type.Literal(true),
  data: Type.Unknown(),
});

export const PnrrErrorSchema = Type.Object({
  ok: Type.Literal(false),
  error: Type.String(),
  message: Type.String(),
  expectedReleaseId: Type.Optional(Type.String()),
  currentReleaseId: Type.Optional(Type.String()),
});

export type PnrrScopeQuery = Static<typeof PnrrScopeQuerySchema>;
export type PnrrProjectsQuery = Static<typeof PnrrProjectsQuerySchema>;
export type PnrrOrganizationsQuery = Static<typeof PnrrOrganizationsQuerySchema>;
export type PnrrPageQuery = Static<typeof PnrrPageQuerySchema>;
export type PnrrReleaseQuery = Static<typeof PnrrReleaseQuerySchema>;
export type PnrrKeyParams = Static<typeof PnrrKeyParamsSchema>;
export type PnrrCuiParams = Static<typeof PnrrCuiParamsSchema>;
export type PnrrCountyParams = Static<typeof PnrrCountyParamsSchema>;
