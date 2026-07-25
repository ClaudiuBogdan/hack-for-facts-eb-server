/**
 * The answer envelope (design §3.4) + quad-surface parity: the SDL scope input,
 * the MCP Zod shape, the kernel fhash spec, and the core scope fields must all
 * declare the SAME field names — one scope, four surfaces, zero drift.
 */

import {
  parse,
  Kind,
  type EnumTypeDefinitionNode,
  type InputObjectTypeDefinitionNode,
  type ObjectTypeDefinitionNode,
  type ObjectTypeExtensionNode,
} from 'graphql';
import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_SCOPE_SPEC,
  SCOPE_FIELDS,
  canonicalScopeEcho,
  parseAnalysisScope,
  scopeToFilterInput,
} from '@/modules/procurement/core/analysis-scope.js';
import { MEASURE_IDS } from '@/modules/procurement/core/constants.js';
import { buildEnvelope } from '@/modules/procurement/core/envelope.js';
import { ANSWERABILITY_REASONS } from '@/modules/procurement/core/gate-v2.js';
import { POLICY_TABLE, anchorPolicy } from '@/modules/procurement/core/policy.js';
import { procurementTypeDefs } from '@/modules/procurement/shell/graphql/typedefs.js';
import { ANALYSIS_SCOPE_ZOD_SHAPE } from '@/modules/procurement/shell/mcp/tools.js';

const reads = {
  rows: '100',
  withValue: '80',
  undatedCount: '5',
  undatedValueRon: '50.00',
};

describe('buildEnvelope', () => {
  it('carries the policy identity, answerability, reads, and canonical scope', () => {
    const envelope = buildEnvelope(
      anchorPolicy('direct_acquisition', 'valueAwardedSum'),
      { allow: true, degraded: false, caveats: [] },
      '42',
      reads,
      'authorityCui=4267117',
      true
    );
    expect(envelope).toMatchObject({
      answerability: 'served',
      policyKey: 'direct_acquisition.valueAwardedSum',
      grain: 'direct_acquisition',
      valueBasis: 'awarded',
      dateBasis: 'coalesce(finalization_date, publication_date)',
      population: 'canonical-only',
      buildId: '42',
      counts: { rows: '100', withValue: '80' },
      undatedInScope: { count: '5', valueRon: '50.00' },
      provisional: false,
      canonicalScope: 'authorityCui=4267117',
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
  it.each(['2000-01', '2100-12'])('accepts boundary calendar month %s', (value) => {
    expect(parseAnalysisScope({ from: value })._unsafeUnwrap().from).toBe(value);
  });

  it.each([
    ['from', '2024-00'],
    ['from', '2024-13'],
    ['to', '1999-12'],
    ['to', '2101-01'],
    ['from', '2024-1'],
  ])('rejects invalid calendar month %s=%s', (field, value) => {
    const result = parseAnalysisScope({ [field]: value });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('InvalidInput');
      if (result.error.type === 'InvalidInput') expect(result.error.field).toBe(field);
    }
  });

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

  it('accepts canonical CPV level codes and rejects malformed ones', () => {
    expect(parseAnalysisScope({ cpvGroup: '45200000' })._unsafeUnwrap().cpvGroup).toBe('45200000');
    expect(parseAnalysisScope({ cpvClass: '45230000' })._unsafeUnwrap().cpvClass).toBe('45230000');
    expect(parseAnalysisScope({ cpvCategory: '45233000' })._unsafeUnwrap().cpvCategory).toBe(
      '45233000'
    );
    // A zero level digit is the coarser level's own code — reject at this level.
    expect(parseAnalysisScope({ cpvGroup: '45000000' }).isErr()).toBe(true);
    expect(parseAnalysisScope({ cpvClass: '45200000' }).isErr()).toBe(true);
    expect(parseAnalysisScope({ cpvCategory: '45230000' }).isErr()).toBe(true);
    expect(parseAnalysisScope({ cpvGroup: '452' }).isErr()).toBe(true);
  });

  it('rejects more than one CPV level per scope', () => {
    const result = parseAnalysisScope({ cpvGroup: '45200000', cpvCode: '45233140' });
    expect(result._unsafeUnwrapErr().message).toContain('mutually exclusive');
    expect(parseAnalysisScope({ cpvDivision: '45', cpvClass: '45230000' }).isErr()).toBe(true);
  });

  it('validates recordKind against the closed vocabulary', () => {
    expect(
      parseAnalysisScope({ recordKind: 'framework_agreement' })._unsafeUnwrap().recordKind
    ).toBe('framework_agreement');
    expect(parseAnalysisScope({ recordKind: 'framework' }).isErr()).toBe(true);
  });

  it('bounds q length and value ranges', () => {
    expect(parseAnalysisScope({ q: 'drum' })._unsafeUnwrap().q).toBe('drum');
    expect(parseAnalysisScope({ q: 'ab' }).isErr()).toBe(true);
    expect(parseAnalysisScope({ q: 'x'.repeat(101) }).isErr()).toBe(true);
    const bounds = parseAnalysisScope({ valueMin: 1000.5, valueMax: 2000 })._unsafeUnwrap();
    expect(bounds.valueMin).toBe(1000.5);
    expect(bounds.valueMax).toBe(2000);
    expect(parseAnalysisScope({ valueMin: -1 }).isErr()).toBe(true);
    expect(parseAnalysisScope({ valueMin: 2000, valueMax: 1000 }).isErr()).toBe(true);
    expect(parseAnalysisScope({ valueMax: Number.NaN }).isErr()).toBe(true);
    // Whole bani only: sub-bani decimals reject; binary-float 2-decimals pass.
    expect(parseAnalysisScope({ valueMin: 1.005 }).isErr()).toBe(true);
    expect(parseAnalysisScope({ valueMin: 1.05 })._unsafeUnwrap().valueMin).toBe(1.05);
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

  // The scope-field parity above does NOT cover measures: MEASURE_IDS, the SDL
  // enum and the policy table drifted independently until this test existed
  // (codex review, 2026-07-25). A measure the SDL omits is unrequestable; one
  // the policy omits routes to a confusing failure instead of a named rejection.
  it('all measure surfaces agree: MEASURE_IDS == SDL enum == policy declarations', () => {
    const doc = parse(procurementTypeDefs);
    const sdlMeasures = doc.definitions
      .filter(
        (node): node is EnumTypeDefinitionNode =>
          node.kind === Kind.ENUM_TYPE_DEFINITION &&
          node.name.value === 'ProcurementAnalysisMeasure'
      )
      .flatMap((node) => (node.values ?? []).map((value) => value.name.value));
    expect([...sdlMeasures].sort()).toEqual([...MEASURE_IDS].sort());

    const declared = new Set(POLICY_TABLE.map((entry) => entry.measure));
    for (const measure of MEASURE_IDS) {
      expect(declared.has(measure), `no policy entry declares '${measure}'`).toBe(true);
    }
  });

  it('types answerability states and reasons as closed GraphQL enums', () => {
    const doc = parse(procurementTypeDefs);
    const enumValues = (name: string): readonly string[] => {
      const definition = doc.definitions.find(
        (node): node is EnumTypeDefinitionNode =>
          node.kind === Kind.ENUM_TYPE_DEFINITION && node.name.value === name
      );
      return (definition?.values ?? []).map((value) => value.name.value);
    };

    expect(enumValues('ProcurementAnswerability')).toEqual(['served', 'degraded', 'abstained']);
    // Pinned to the core union's runtime list: every reason gate-v2 can emit
    // must serialize over GraphQL (SPEND_SERVED_DISCLOSED was missing until 2026-07-24).
    expect(enumValues('ProcurementAnswerabilityReason')).toEqual([...ANSWERABILITY_REASONS]);
  });

  it('the fhash spec is all-virtual — it never compiles to SQL', () => {
    for (const field of ANALYSIS_SCOPE_SPEC.fields) {
      expect(field.virtual).toBe(true);
    }
  });

  it('removes the deprecated aggregate fields and Entity contributor', () => {
    const doc = parse(procurementTypeDefs);
    const query = doc.definitions.find(
      (d): d is ObjectTypeExtensionNode =>
        d.kind === Kind.OBJECT_TYPE_EXTENSION && d.name.value === 'Query'
    );
    const queryFields = (query?.fields ?? []).map((field) => field.name.value);
    expect(queryFields).not.toEqual(
      expect.arrayContaining([
        'procurementGrainQuality',
        'procurementRepeatedPairs',
        'procurementAuthorityCpvSpend',
        'procurementTopSuppliersByRegionCpv',
        'procurementSameDayCandidates',
      ])
    );
    const entity = doc.definitions.find(
      (d): d is ObjectTypeExtensionNode =>
        d.kind === Kind.OBJECT_TYPE_EXTENSION && d.name.value === 'Entity'
    );
    expect(entity).toBeUndefined();
    for (const typeName of [
      'ProcurementProcedureDetail',
      'ProcurementContractDetail',
      'ProcurementDirectAcquisitionDetail',
    ]) {
      const type = doc.definitions.find(
        (d): d is ObjectTypeDefinitionNode =>
          d.kind === Kind.OBJECT_TYPE_DEFINITION && d.name.value === typeName
      );
      expect((type?.fields ?? []).map((field) => field.name.value)).not.toContain('gate');
    }
  });
});
