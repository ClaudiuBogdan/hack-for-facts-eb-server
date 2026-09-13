import { z } from 'zod';

import {
  commitmentDashboard,
  type CommitmentDashboardRepo,
} from '../../core/commitment-dashboard.js';
import {
  BUDGET_FREQUENCIES,
  BUDGET_NORMALIZATIONS,
  COMMITMENT_REPORT_TYPES,
} from '../../core/constants.js';

import type { KernelMcpTool } from '@/modules/shared/index.js';
const schema = z.object({
  cui: z.string(),
  mainCreditorCui: z.string().optional(),
  detailYear: z.number().int(),
  yearFrom: z.number().int(),
  yearTo: z.number().int(),
  frequency: z.enum(BUDGET_FREQUENCIES),
  reportType: z.enum(COMMITMENT_REPORT_TYPES),
  normalization: z.enum(BUDGET_NORMALIZATIONS).default('TOTAL'),
  currency: z.enum(['RON', 'EUR', 'USD']).optional(),
  inflationAdjusted: z.boolean().optional(),
});
export const makeCommitmentDashboardTool = (repo: CommitmentDashboardRepo): KernelMcpTool => ({
  name: 'get_budget_commitment_dashboard',
  description:
    'Entity commitment dashboard excluding transfers. Budget and authority are endpoint balances; commitments and payments are period movements (YEAR is latest YTD). Only detailYear includes classification breakdowns. Missing values stay null; firstReportMonth/lastReportMonth disclose differing sector endpoints. Never sum budget balances across periods.',
  inputShape: schema.shape,
  async handler(args) {
    const parsed = schema.safeParse(args);
    if (!parsed.success)
      return { ok: false, kind: 'commitment_dashboard', error: 'Invalid dashboard query' };
    const { mainCreditorCui, currency, inflationAdjusted, ...required } = parsed.data;
    const result = await commitmentDashboard(repo, {
      ...required,
      ...(mainCreditorCui !== undefined ? { mainCreditorCui } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(inflationAdjusted !== undefined ? { inflationAdjusted } : {}),
    });
    return result.isErr()
      ? { ok: false, kind: 'commitment_dashboard', error: result.error.message }
      : { ok: true, kind: 'commitment_dashboard', item: result.value };
  },
});
