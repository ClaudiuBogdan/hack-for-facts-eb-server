/**
 * Fiscal codes compare in the data platform's form (no leading zeros): a legacy
 * or client code with leading zeros matches its procurement_v3 row, and the
 * public-supplier set accepts either form (procurement-prod measured, 18 Nov).
 */
import { describe, expect, it } from 'vitest';

import { withoutLeadingZeros } from '@/modules/shared/core/types.js';
import { makeSupplierDisclosureRepo } from '@/modules/shared/shell/repo/supplier-disclosure-repo.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

describe('withoutLeadingZeros', () => {
  it('strips leading zeros and keeps a lone zero', () => {
    expect(withoutLeadingZeros('0014399840')).toBe('14399840');
    expect(withoutLeadingZeros('14399840')).toBe('14399840');
    expect(withoutLeadingZeros('0')).toBe('0');
  });
});

describe('the public-supplier set', () => {
  it('matches a legacy code with leading zeros to its public platform code', async () => {
    const captured: CapturedQuery[] = [];
    const db = makeCapturingDb(captured, {
      respond: (text) => {
        if (text.includes('to_regclass')) return [{ release: true, privacy: true }];
        if (text.includes('max(data_as_of)')) return [{ as_of: '2026-11-18T03:10:00.000000Z' }];
        if (text.includes('where public is true')) return [{ code: '14399840' }];
        return [];
      },
    });
    const codes = (
      await makeSupplierDisclosureRepo(db, true).publicSupplierCodes()
    )._unsafeUnwrap();
    expect(codes.has('0014399840')).toBe(true);
    expect(codes.has('14399840')).toBe(true);
    expect(codes.has('30254716')).toBe(false);
  });
});
