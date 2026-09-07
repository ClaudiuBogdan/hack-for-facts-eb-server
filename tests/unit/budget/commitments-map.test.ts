import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  commitmentsMapValues,
  type CommitmentsMapInput,
} from '@/modules/budget/core/legacy-analytics/commitments-map.js';

const filter: CommitmentsMapInput['filter'] = {
  report_period: { type: 'YEAR', selection: { dates: ['2024'] } },
};
const deps = () => ({
  repo: { yearlyAmounts: vi.fn().mockResolvedValue(ok([])) },
  factors: { yearly: vi.fn().mockResolvedValue(ok(null)) },
  population: { annualUnions: vi.fn().mockResolvedValue(ok([])) },
});

describe('native commitments map input', () => {
  it.each([
    [' PRINCIPAL_AGGREGATED ', 'Executie - Angajamente bugetare agregat principal'],
    ['SECONDARY_AGGREGATED', 'Executie - Angajamente bugetare agregat secundar'],
    [' DETAILED ', 'Executie - Angajamente bugetare detaliat'],
    [' Executie - Angajamente bugetare detaliat ', 'Executie - Angajamente bugetare detaliat'],
  ])('replays saved report %s', async (report, expected) => {
    const d = deps();
    const result = await commitmentsMapValues(d, {
      granularity: 'County',
      metric: 'CREDITE_ANGAJAMENT',
      filter: { ...filter, report_type: report },
    });
    expect(result.isOk()).toBe(true);
    expect(d.repo.yearlyAmounts).toHaveBeenCalledWith(
      expect.objectContaining({ reportType: expected }),
      'County',
      'CREDITE_ANGAJAMENT',
      true
    );
  });
  it('rejects unsupported execution dimensions before reading data', async () => {
    const d = deps();
    const result = await commitmentsMapValues(d, {
      granularity: 'County',
      metric: 'CREDITE_ANGAJAMENT',
      filter: { ...filter, program_codes: ['1'] },
    });
    expect(result.isErr()).toBe(true);
    expect(d.repo.yearlyAmounts).not.toHaveBeenCalled();
  });
  it('rejects annual unpaid-change metrics before reading data', async () => {
    const d = deps();
    const result = await commitmentsMapValues(d, {
      granularity: 'County',
      metric: 'RECEPTII_NEPLATITE_CHANGE',
      filter,
    });
    expect(result.isErr()).toBe(true);
    expect(d.repo.yearlyAmounts).not.toHaveBeenCalled();
  });
});
