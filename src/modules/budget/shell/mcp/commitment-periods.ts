import { z } from 'zod';

import { listCommitmentPeriods, type BudgetPeriodRepo } from '../../core/commitment-periods.js';
import { COMMITMENT_REPORT_TYPES } from '../../core/constants.js';

import type { KernelMcpTool } from '@/modules/shared/index.js';

const querySchema = z.object({
  cui: z.string().regex(/^[0-9]{1,10}$/u),
  year: z.number().int().min(1).max(9999),
  reportType: z.enum(COMMITMENT_REPORT_TYPES),
  startMonth: z.number().int().min(1).max(12).default(1),
  endMonth: z.number().int().min(1).max(12).default(12),
  page: z.number().int().min(1).max(10000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});

export const makeCommitmentPeriodTool = (repo: BudgetPeriodRepo): KernelMcpTool => ({
  name: 'get_budget_commitment_periods',
  description:
    'Read exact source intervals and published-sector terminal coverage for one entity/year/report type. Nominal RON excluding transfers. Month bounds select report endpoints, never clip amounts. Do not sum overlapping intervals or interpret source-empty as zero. metadataAvailable only indicates published metadata exists; whole-year correctness is gated by the publisher.',
  inputShape: querySchema.shape,
  async handler(args) {
    const parsed = querySchema.safeParse(args);
    if (!parsed.success)
      return { ok: false, kind: 'commitment_periods', error: 'Invalid period query' };
    const result = await listCommitmentPeriods(repo, parsed.data);
    return result.isErr()
      ? { ok: false, kind: 'commitment_periods', error: result.error.message }
      : { ok: true, kind: 'commitment_periods', item: result.value };
  },
});
