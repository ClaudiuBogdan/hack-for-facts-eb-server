import { describe, expect, it } from 'vitest';

import { companiesTypeDefs } from '@/modules/companies/shell/graphql/typedefs.js';
import { pnrrTypeDefs } from '@/modules/pnrr/shell/graphql/typedefs.js';
import { mergeGraphqlSlices, baseTypeDefs } from '@/modules/shared/index.js';

describe('companies schema slice', () => {
  it('merges with kernel base + pnrr without a conflict', () => {
    expect(() =>
      mergeGraphqlSlices(baseTypeDefs, [
        { source: 'pnrr', typeDefs: pnrrTypeDefs },
        { source: 'companies', typeDefs: companiesTypeDefs },
      ])
    ).not.toThrow();
  });

  it('declares the company Query fields', () => {
    const merged = mergeGraphqlSlices(baseTypeDefs, [{ source: 'companies', typeDefs: companiesTypeDefs }]);
    expect(merged.typeDefs).toContain('company(cui: CUI!)');
    expect(merged.typeDefs).toContain('companyCountyProfile');
    expect(merged.typeDefs).toContain('CompaniesFilter');
  });
});
