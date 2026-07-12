/**
 * The answer envelope (design §3.4) + quad-surface parity: the SDL scope input,
 * the MCP Zod shape, the kernel fhash spec, and the core scope fields must all
 * declare the SAME field names — one scope, four surfaces, zero drift.
 */

import { parse, Kind, type InputObjectTypeDefinitionNode } from 'graphql';
import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_SCOPE_SPEC,
  SCOPE_FIELDS,
  canonicalScopeEcho,
  parseAnalysisScope,
  scopeToFilterInput,
} from '@/modules/procurement/core/analysis-scope.js';
import { buildEnvelope } from '@/modules/procurement/core/envelope.js';
import { anchorPolicy } from '@/modules/procurement/core/policy.js';
import { procurementTypeDefs } from '@/modules/procurement/shell/graphql/typedefs.js';
import { ANALYSIS_SCOPE_ZOD_SHAPE } from '@/modules/procurement/shell/mcp/tools.js';

const reads = {
  rows: '100',
  withValue: '80',
  undatedCount: '5',
  undatedValueRon: '50.00',
};

describe('buildEnvelope', () => {
  it('carries the policy identity, the read counts, and the link', () => {
    const envelope = buildEnvelope(
      anchorPolicy('direct_acquisition', 'valueAwardedSum'),
      { allow: true, degraded: false, caveats: [] },
      '42',
      reads,
      'authorityCui=4267117',
      true
    );
    expect(envelope).toMatchObject({
      policyKey: 'direct_acquisition.valueAwardedSum',
      grain: 'direct_acquisition',
      valueBasis: 'awarded',
      dateBasis: 'coalesce(finalization_date, publication_date)',
      population: 'canonical-only',
      buildId: '42',
      counts: { rows: '100', withValue: '80' },
      undatedInScope: { count: '5', valueRon: '50.00' },
      provisional: false,
      link: 'authorityCui=4267117',
    });
  });

  it('contract-grain money is ALWAYS provisional (no terminality signal)', () => {
    const money = buildEnvelope(
      anchorPolicy('contract', 'valueAwardedSum'),
      { allow: true, degraded: false, caveats: [] },
      '42',
      reads,
      '',
      true
    );
    expect(money.provisional).toBe(true);
    // …but a pure count on the same grain is not money and not provisional.
    const count = buildEnvelope(
      anchorPolicy('contract', 'recordCount'),
      { allow: true, degraded: false, caveats: [] },
      '42',
      reads,
      '',
      true
    );
    expect(count.provisional).toBe(false);
  });

  it('nulls the undated bucket money when spend is not allowed (never zeroes)', () => {
    const envelope = buildEnvelope(
      anchorPolicy('contract', 'valueAwardedSum'),
      { allow: false, degraded: false, caveats: ['spend abstains'] },
      '42',
      reads,
      '',
      false
    );
    expect(envelope.undatedInScope).toEqual({ count: '5', valueRon: null });
    expect(envelope.caveats).toContain('spend abstains');
  });

  it('merges gate caveats with extra policy caveats in order', () => {
    const envelope = buildEnvelope(
      anchorPolicy('direct_acquisition', 'recordCount'),
      { allow: true, degraded: true, caveats: ['gate'] },
      '42',
      reads,
      '',
      true,
      ['policy']
    );
    expect(envelope.caveats).toEqual(['gate', 'policy']);
  });
});

describe('canonical scope echo + fhash input', () => {
  it('is stable and order-independent', () => {
    const a = parseAnalysisScope({ supplierCui: '11805367', from: '2024-01' })._unsafeUnwrap();
    const b = parseAnalysisScope({ from: '2024-01', supplierCui: '11805367' })._unsafeUnwrap();
    expect(canonicalScopeEcho(a)).toBe(canonicalScopeEcho(b));
    expect(canonicalScopeEcho(a)).toBe('supplierCui=11805367&from=2024-01');
  });

  it('projects every set field into the kernel FilterInput for fhash', () => {
    const scope = parseAnalysisScope({
      authorityCui: '4267117',
      grain: 'contract',
      year: 2024,
    })._unsafeUnwrap();
    expect(scopeToFilterInput(scope)).toEqual({
      authorityCui: { eq: '4267117' },
      grain: { eq: 'contract' },
      year: { eq: 2024 },
    });
  });
});

describe('surface parity: SDL == Zod == kernel spec == core fields', () => {
  const sdlFields = (): readonly string[] => {
    const doc = parse(procurementTypeDefs);
    const input = doc.definitions.find(
      (d): d is InputObjectTypeDefinitionNode =>
        d.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION &&
        d.name.value === 'ProcurementAnalysisScopeInput'
    );
    return (input?.fields ?? []).map((f) => f.name.value);
  };

  it('all four surfaces declare exactly the same scope fields', () => {
    const core = [...SCOPE_FIELDS];
    expect(sdlFields()).toEqual(core);
    expect(Object.keys(ANALYSIS_SCOPE_ZOD_SHAPE)).toEqual(core);
    expect(ANALYSIS_SCOPE_SPEC.fields.map((f) => f.name)).toEqual(core);
  });

  it('the fhash spec is all-virtual — it never compiles to SQL', () => {
    for (const field of ANALYSIS_SCOPE_SPEC.fields) {
      expect(field.virtual).toBe(true);
    }
  });
});
