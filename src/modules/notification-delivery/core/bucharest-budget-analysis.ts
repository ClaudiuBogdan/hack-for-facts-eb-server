import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

export const BUCHAREST_BUDGET_ANALYSIS_FAMILY_ID = 'bucharest_budget_analysis' as const;
export const BUCHAREST_BUDGET_ANALYSIS_TEMPLATE_ID =
  'bucharest_budget_analysis_2026_04_23' as const;
export const BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI = '4267117' as const;
export const BUCHAREST_BUDGET_ANALYSIS_ENTITY_NAME = 'Primăria Municipiului București' as const;
export const BUCHAREST_BUDGET_ANALYSIS_ID = 'pmb-budget-analysis-2026' as const;
export const BUCHAREST_BUDGET_ANALYSIS_URL =
  'https://funky.ong/analiza-buget-local-primaria-municipiului-bucuresti-2026/' as const;
export const BUCHAREST_BUDGET_ANALYSIS_PUBLISHED_AT = '2026-04-23' as const;

export const BucharestBudgetAnalysisOutboxMetadataSchema = Type.Object({
  campaignKey: Type.Literal('funky'),
  familyId: Type.Literal(BUCHAREST_BUDGET_ANALYSIS_FAMILY_ID),
  entityCui: Type.Literal(BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI),
  entityName: Type.String({ minLength: 1 }),
  analysisId: Type.Literal(BUCHAREST_BUDGET_ANALYSIS_ID),
  analysisUrl: Type.String({ minLength: 1 }),
  analysisPublishedAt: Type.String({ minLength: 1 }),
  analysisFingerprint: Type.String({ minLength: 1 }),
  triggerSource: Type.Optional(Type.String({ minLength: 1 })),
  triggeredByUserId: Type.Optional(Type.String({ minLength: 1 })),
});

export type BucharestBudgetAnalysisOutboxMetadata = Static<
  typeof BucharestBudgetAnalysisOutboxMetadataSchema
>;

const getValidationMessage = (value: unknown): string => {
  const [firstError] = [...Value.Errors(BucharestBudgetAnalysisOutboxMetadataSchema, value)];
  if (firstError !== undefined && typeof firstError.message === 'string') {
    return firstError.message;
  }

  return 'Invalid bucharest-budget-analysis metadata';
};

export const parseBucharestBudgetAnalysisOutboxMetadata = (
  value: unknown
): Result<BucharestBudgetAnalysisOutboxMetadata, string> => {
  if (!Value.Check(BucharestBudgetAnalysisOutboxMetadataSchema, value)) {
    return err(getValidationMessage(value));
  }

  return ok(value);
};
