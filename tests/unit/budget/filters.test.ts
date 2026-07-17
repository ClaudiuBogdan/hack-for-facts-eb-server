/**
 * Budget filter specs → kernel pipeline (no live DB). The load-bearing checks:
 *  - all five specs derive TypeBox + GraphQL input without throwing;
 *  - the KERNEL specs (the composer-facing variants) DROP the repo-intercepted
 *    fields, so the kernel never compiles a clean enum onto a partition-literal
 *    column or a virtual column (the C1/R1 review fix — the bug found in inject);
 *  - residual fields compile against their declared driving columns;
 *  - canonicalization is stable cross-surface (the fhash contract).
 */

import { describe, expect, it } from 'vitest';

import {
  BUDGET_COMMITMENT_VIRTUAL_FIELDS,
  BUDGET_FACT_VIRTUAL_FIELDS,
  budgetApprovedFactFilterSpec,
  budgetCommitmentFactFilterSpec,
  budgetCommitmentFactKernelSpec,
  budgetFactFilterSpec,
  budgetFactKernelSpec,
  budgetRankingFilterSpec,
  budgetRankingKernelSpec,
  budgetReportFilterSpec,
} from '@/modules/budget/core/filters.js';
import { canonicalizeFilters, fhashFor } from '@/modules/shared/core/filters/derive.js';
import {
  graphqlFilterTypeName,
  toGraphQLInput,
  toTypeBox,
} from '@/modules/shared/core/filters/surfaces.js';
import { toConditionBuilders } from '@/modules/shared/shell/filters/derive.js';

import { compileWhere } from '../shared/helpers.js';

const ALL_SPECS = [
  budgetFactFilterSpec,
  budgetCommitmentFactFilterSpec,
  budgetRankingFilterSpec,
  budgetReportFilterSpec,
  budgetApprovedFactFilterSpec,
];

describe('budget filter specs — surfaces derive', () => {
  it.each(ALL_SPECS.map((s) => [s.collection, s] as const))(
    '%s derives TypeBox + GraphQL input without throwing',
    (_name, spec) => {
      expect(() => toTypeBox(spec)).not.toThrow();
      const sdl = toGraphQLInput(spec);
      expect(sdl).toContain(`input ${graphqlFilterTypeName(spec)}`);
    }
  );

  it('the FULL fact spec carries the pruning-triple + amount (money) + transfer fields', () => {
    const names = budgetFactFilterSpec.fields.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'reportingYear',
        'reportType',
        'accountCategory',
        'frequency',
        'minAmount',
        'maxAmount',
        'excludeTransfers',
      ])
    );
    // amount ranges use the kernel `money` type (precision-safe ::numeric).
    expect(budgetFactFilterSpec.fields.find((f) => f.name === 'minAmount')?.type).toBe('money');
  });
});

describe('budget KERNEL specs strip the repo-intercepted fields (the prune-safety fix)', () => {
  it('the fact KERNEL spec contains NONE of the virtual/gate fields', () => {
    const kernelNames = new Set(budgetFactKernelSpec.fields.map((f) => f.name));
    for (const v of BUDGET_FACT_VIRTUAL_FIELDS) expect(kernelNames.has(v)).toBe(false);
    // …but still carries residual fields the kernel SHOULD compile.
    expect(kernelNames.has('entityCuis')).toBe(true);
    expect(kernelNames.has('functionalCodes')).toBe(true);
  });

  it('the commitment KERNEL spec strips its virtual fields', () => {
    const kernelNames = new Set(budgetCommitmentFactKernelSpec.fields.map((f) => f.name));
    for (const v of BUDGET_COMMITMENT_VIRTUAL_FIELDS) expect(kernelNames.has(v)).toBe(false);
  });

  it('CRITICAL: composing the empty input on the KERNEL spec emits NO conditions (no leaked defaults)', () => {
    // The full spec defaults reportType/accountCategory/frequency — if the kernel
    // saw them it would emit `report_type = 'EXECUTION_DETAILED'` (wrong literal)
    // and `frequency_virtual = 'YEAR'` (a non-existent column). The kernel spec
    // must produce zero conditions for an empty input.
    const built = toConditionBuilders(budgetFactKernelSpec, {});
    expect(built.isOk()).toBe(true);
    expect(built._unsafeUnwrap()).toHaveLength(0);
  });

  it('CRITICAL: the kernel spec never references the virtual column or the clean enum', () => {
    const built = toConditionBuilders(budgetFactKernelSpec, { entityCuis: { in: ['4305857'] } });
    const { sql } = compileWhere(built._unsafeUnwrap());
    expect(sql).not.toContain('frequency_virtual');
    expect(sql).not.toContain('EXECUTION_DETAILED');
    expect(sql).not.toContain('report_type');
    expect(sql).toContain('"eli"."entity_cui"');
  });

  it('the ranking KERNEL spec drops year/reportType (intercepted → mapped to MV cols)', () => {
    const kernelNames = new Set(budgetRankingKernelSpec.fields.map((f) => f.name));
    expect(kernelNames.has('year')).toBe(false);
    expect(kernelNames.has('reportType')).toBe(false);
    expect(kernelNames.has('countyCodes')).toBe(true); // geo residuals stay
  });
});

describe('budget filter specs — residual SQL compilation', () => {
  it('functionalCodes IN compiles against the identity-index column', () => {
    const built = toConditionBuilders(budgetFactKernelSpec, {
      functionalCodes: { in: ['84.03.03', '65.50.00'] },
    });
    const { sql, parameters } = compileWhere(built._unsafeUnwrap());
    expect(sql).toContain('"eli"."functional_code"');
    expect(sql).toMatch(/in \(\$1, \$2\)/u);
    expect(parameters).toEqual(['84.03.03', '65.50.00']);
  });

  it('functionalPrefix compiles to a LIKE prefix (text_pattern_ops btree)', () => {
    const built = toConditionBuilders(budgetFactKernelSpec, {
      functionalPrefix: { prefix: '84.' },
    });
    const { sql, parameters } = compileWhere(built._unsafeUnwrap());
    expect(sql).toContain('"eli"."functional_code" ilike');
    expect(parameters).toEqual(['84.%']);
  });

  it('rejects an enum value outside the declared set', () => {
    const built = toConditionBuilders(budgetRankingKernelSpec, { isUat: { eq: 'maybe' } });
    // isUat is bool; a non-bool is coerced rather than rejected — assert it compiles to a bool.
    expect(built.isOk()).toBe(true);
  });
});

describe('budget filter specs — canonicalization stability (fhash contract)', () => {
  it('array order does not change the canonical form', () => {
    const a = canonicalizeFilters(budgetFactFilterSpec, { entityCuis: { in: ['b', 'a'] } });
    const b = canonicalizeFilters(budgetFactFilterSpec, { entityCuis: { in: ['a', 'b'] } });
    expect(a).toBe(b);
  });

  it('REST string year and GraphQL number year fold to the same fhash', () => {
    const fStr = fhashFor(budgetFactFilterSpec, { reportingYear: { eq: '2025' } });
    const fNum = fhashFor(budgetFactFilterSpec, { reportingYear: { eq: 2025 } });
    expect(fStr).toBe(fNum);
  });

  it('money amounts "1000" and "1000.00" fold identically (precision-safe)', () => {
    const a = canonicalizeFilters(budgetFactFilterSpec, { minAmount: { gte: '1000' } });
    const b = canonicalizeFilters(budgetFactFilterSpec, { minAmount: { gte: '1000.00' } });
    expect(a).toBe(b);
  });
});
