/**
 * National budget — the five reviewed named law totals.
 *
 * A total is a name for one reviewed descriptor match, never an amount match or
 * a sum. The adapter matches codes/labels after trimming and otherwise exactly;
 * credit rows require every code column below capitol to be empty, revenue
 * permits its printed subcapitol and requires the other lower codes empty.
 * Presence in a given edition is data (P0), not assumed here.
 */

import {
  AUTHORITY_DETAIL_FORM,
  BUDGET_FUNDS,
  SYNTHESIS_FORM,
  type ApprovedForm,
  type BudgetFund,
  type RowRole,
  type TotalKey,
  type TotalScope,
} from './vocabulary.js';

export interface TotalDefinition {
  readonly key: TotalKey;
  readonly scope: TotalScope;
  /** Funds the descriptor exists for (canonical order). */
  readonly funds: readonly BudgetFund[];
  readonly forms: readonly ApprovedForm[];
  readonly rowRole: RowRole;
  readonly capitol: string;
  /** Descriptor label (revenue) or credit context label (credits). */
  readonly label: string;
  readonly requiresCreditType: boolean;
  readonly description: string;
}

const ALL_FUNDS: readonly BudgetFund[] = BUDGET_FUNDS;
const ALL_SYNTHESIS: readonly ApprovedForm[] = BUDGET_FUNDS.map((fund) => SYNTHESIS_FORM[fund]);

export const TOTAL_DEFINITIONS: Readonly<Record<TotalKey, TotalDefinition>> = {
  REVENUE_TOTAL: {
    key: 'REVENUE_TOTAL',
    scope: 'FUND',
    funds: ALL_FUNDS,
    forms: ALL_SYNTHESIS,
    rowRole: 'DESCRIPTOR',
    capitol: '0001',
    label: 'VENITURI - TOTAL',
    requiresCreditType: false,
    description: 'Fund synthesis revenue descriptor, capitol 0001 "VENITURI - TOTAL".',
  },
  EXPENDITURE_5000_TOTAL_GENERAL: {
    key: 'EXPENDITURE_5000_TOTAL_GENERAL',
    scope: 'FUND',
    funds: ALL_FUNDS,
    forms: ALL_SYNTHESIS,
    rowRole: 'CREDIT',
    capitol: '5000',
    label: 'TOTAL GENERAL',
    requiresCreditType: true,
    description: 'Fund synthesis credit row, capitol 5000 in context "TOTAL GENERAL".',
  },
  EXPENDITURE_5001_STATE_BUDGET: {
    key: 'EXPENDITURE_5001_STATE_BUDGET',
    scope: 'FUND',
    funds: ['STATE_BUDGET'],
    forms: [SYNTHESIS_FORM.STATE_BUDGET],
    rowRole: 'CREDIT',
    capitol: '5001',
    label: 'CHELTUIELI - BUGET DE STAT',
    requiresCreditType: true,
    description: 'State budget synthesis credit row, capitol 5001 "CHELTUIELI - BUGET DE STAT".',
  },
  EXPENDITURE_5005_CHELTUIELI_TOTAL: {
    key: 'EXPENDITURE_5005_CHELTUIELI_TOTAL',
    scope: 'FUND',
    funds: ALL_FUNDS,
    forms: ALL_SYNTHESIS,
    rowRole: 'CREDIT',
    capitol: '5005',
    label: 'CHELTUIELI - TOTAL',
    requiresCreditType: true,
    description: 'Fund synthesis credit row, capitol 5005 in context "CHELTUIELI - TOTAL".',
  },
  AUTHORITY_EXPENDITURE_5001: {
    key: 'AUTHORITY_EXPENDITURE_5001',
    scope: 'AUTHORITY',
    funds: ['STATE_BUDGET'],
    forms: [AUTHORITY_DETAIL_FORM],
    rowRole: 'CREDIT',
    capitol: '5001',
    label: 'CHELTUIELI - BUGET DE STAT',
    requiresCreditType: true,
    description:
      "One authority's own state budget credit row, capitol 5001; code 999 (revenue holder) excluded.",
  },
};

/** The form a total reads for a fund (authority detail for the authority scope). */
export const formFor = (definition: TotalDefinition, fund: BudgetFund): ApprovedForm =>
  definition.scope === 'AUTHORITY' ? AUTHORITY_DETAIL_FORM : SYNTHESIS_FORM[fund];
