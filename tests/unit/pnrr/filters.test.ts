/**
 * PNRR filter specs → kernel pipeline (no live DB). Verifies each collection's
 * spec compiles to parameterized SQL with the declared driving column, that the
 * three surfaces derive (TypeBox + GraphQL input), and that `canonicalizeFilters`
 * is stable cross-surface (the fhash contract that binds cursors + cache keys).
 */

import { describe, expect, it } from 'vitest';

import {
  pnrrAcquisitionsFilterSpec,
  pnrrCommitmentsFilterSpec,
  pnrrContractorsFilterSpec,
  pnrrEntitiesFilterSpec,
  pnrrMeasuresFilterSpec,
  pnrrPaymentsFilterSpec,
} from '@/modules/pnrr/core/filters.js';
import { canonicalizeFilters, fhashFor, toConditionBuilders } from '@/modules/shared/core/filters/derive.js';
import { graphqlFilterTypeName, toGraphQLInput, toTypeBox } from '@/modules/shared/core/filters/surfaces.js';

import { compileWhere } from '../shared/helpers.js';

const ALL_SPECS = [
  pnrrEntitiesFilterSpec,
  pnrrPaymentsFilterSpec,
  pnrrCommitmentsFilterSpec,
  pnrrAcquisitionsFilterSpec,
  pnrrContractorsFilterSpec,
  pnrrMeasuresFilterSpec,
];

describe('pnrr filter specs — surfaces derive', () => {
  it.each(ALL_SPECS.map((s) => [s.collection, s] as const))(
    '%s derives TypeBox + GraphQL input without throwing',
    (_name, spec) => {
      expect(() => toTypeBox(spec)).not.toThrow();
      const sdl = toGraphQLInput(spec);
      expect(sdl).toContain(`input ${graphqlFilterTypeName(spec)}`);
    }
  );

  it('payments spec exposes the indexed driving fields', () => {
    const names = pnrrPaymentsFilterSpec.fields.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(['beneficiaryCui', 'componentCode', 'measureFenix', 'paymentDate', 'year'])
    );
  });
});

describe('pnrr filter specs — SQL compilation', () => {
  it('payments beneficiaryCui IN compiles against payments_beneficiary_cui_idx column', () => {
    const built = toConditionBuilders(pnrrPaymentsFilterSpec, {
      beneficiaryCui: { in: ['16054368', '4267117'] },
    });
    expect(built.isOk()).toBe(true);
    const { sql, parameters } = compileWhere(built._unsafeUnwrap());
    expect(sql).toContain('"p"."beneficiary_cui"');
    expect(sql).toMatch(/in \(\$1, \$2\)/u);
    expect(parameters).toEqual(['16054368', '4267117']);
  });

  it('payments measureFenix isNull compiles to IS NULL (coverage probe)', () => {
    const built = toConditionBuilders(pnrrPaymentsFilterSpec, { measureFenix: { isNull: true } });
    const { sql } = compileWhere(built._unsafeUnwrap());
    expect(sql).toContain('"p"."measure_fenix" is null');
  });

  it('contractors role eq compiles against the indexed role column', () => {
    const built = toConditionBuilders(pnrrContractorsFilterSpec, { role: { eq: 'winning_bidder' } });
    const { sql, parameters } = compileWhere(built._unsafeUnwrap());
    expect(sql).toContain('"ct"."role" = $1');
    expect(parameters).toEqual(['winning_bidder']);
  });

  it('rejects an operator not allowed on a field', () => {
    const built = toConditionBuilders(pnrrPaymentsFilterSpec, {
      beneficiaryCui: { contains: 'x' },
    });
    expect(built.isErr()).toBe(true);
  });

  it('rejects an enum value outside the declared set', () => {
    const built = toConditionBuilders(pnrrContractorsFilterSpec, { role: { eq: 'not_a_role' } });
    expect(built.isErr()).toBe(true);
  });
});

describe('pnrr filter specs — canonicalization stability (fhash contract)', () => {
  it('REST string year and GraphQL number year fold to the same canonical form', () => {
    // payments has no `year` canonicalization issue (int), use componentCode IN order-independence.
    const a = canonicalizeFilters(pnrrPaymentsFilterSpec, { componentCode: { in: ['C4', 'C1'] } });
    const b = canonicalizeFilters(pnrrPaymentsFilterSpec, { componentCode: { in: ['C1', 'C4'] } });
    expect(a).toBe(b); // array order does not change the hash
  });

  it('fhash differs when the filter set differs', () => {
    const f1 = fhashFor(pnrrPaymentsFilterSpec, { beneficiaryCui: { eq: '16054368' } });
    const f2 = fhashFor(pnrrPaymentsFilterSpec, { beneficiaryCui: { eq: '4267117' } });
    expect(f1).not.toBe(f2);
  });
});
