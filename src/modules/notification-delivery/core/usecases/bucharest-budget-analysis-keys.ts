import { BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI } from '../bucharest-budget-analysis.js';

export interface BucharestBudgetAnalysisKeyInput {
  userId: string;
  analysisFingerprint: string;
}

export const buildBucharestBudgetAnalysisScopeKey = (analysisFingerprint: string): string => {
  return `funky:delivery:bucharest_budget_analysis:${BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI}:${analysisFingerprint}`;
};

export const buildBucharestBudgetAnalysisDeliveryKey = (
  input: BucharestBudgetAnalysisKeyInput
): string => {
  return `funky:delivery:bucharest_budget_analysis:${input.userId}:${BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI}:${input.analysisFingerprint}`;
};
