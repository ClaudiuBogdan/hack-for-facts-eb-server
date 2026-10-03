import { describe, expect, it } from 'vitest';

import {
  validateApprovedSeriesInput,
  validateApprovedTotalsInput,
} from '@/modules/budget/core/national/approved-inputs.js';
import {
  classifyCandidates,
  planApprovedSeries,
  planTotals,
  seriesDescriptorGroups,
  totalsDescriptorGroups,
  type SeriesPeriodPlan,
} from '@/modules/budget/core/national/approved-plan.js';
import {
  projectApprovedSeries,
  projectTotalCell,
  type ApprovedClassification,
} from '@/modules/budget/core/national/approved-projection.js';
import { toWireDataSeries, toWireDecimal } from '@/modules/budget/core/national/values.js';

import { LAW_EVIDENCE } from '../../fixtures/national-budget/evidence.js';
import {
  ALL_FORMS,
  authority,
  candidate,
  editionRef,
  INVENTORY,
  inventoryEdition,
  loadedForms,
  slotsFor,
  target,
} from '../../fixtures/national-budget/inventory.js';

const E = (year: number): string => editionRef(year).id;
const years = (start: string, end: string) => ({
  type: 'YEAR',
  selection: { interval: { start, end } },
});
const seriesInput = (overrides: Record<string, unknown>) =>
  validateApprovedSeriesInput({
    fund: 'STATE_BUDGET',
    total: 'EXPENDITURE_5001_STATE_BUDGET',
    creditType: 'BUDGET_CREDITS',
    period: years('2022', '2025'),
    axis: { editionsForTarget: { targetYear: 2025 } },
    ...overrides,
  })._unsafeUnwrap();

const summary = (plans: readonly SeriesPeriodPlan[]) =>
  plans.map((p) =>
    p.kind === 'READ'
      ? `${p.date}:READ:${p.edition.id}:${String(p.slot.measureYear)}:${p.slot.measure}`
      : `${p.date}:${p.status}`
  );

describe('approved totals planning', () => {
  it('intersects requested targets with each edition horizon (no cell outside it)', () => {
    const query = validateApprovedTotalsInput({
      totals: ['EXPENDITURE_5001_STATE_BUDGET'],
      creditTypes: ['BUDGET_CREDITS'],
      measureYears: [2025, 2029],
      editionIds: [E(2022), E(2025)],
    })._unsafeUnwrap();
    const plan = planTotals(query, INVENTORY)._unsafeUnwrap();
    expect(
      plan.cells.map((c) => `${c.edition.id}:${String(c.slot.measureYear)}:${c.slot.measure}`)
    ).toEqual([`${E(2022)}:2025:FORECAST`, `${E(2025)}:2025:APPROVED`]);
    expect(plan.unloadedEditionIds).toEqual([]);
  });

  it('reports unloaded editions and missing authorities instead of inventing cells', () => {
    const query = validateApprovedTotalsInput({
      totals: ['AUTHORITY_EXPENDITURE_5001'],
      creditTypes: ['BUDGET_CREDITS'],
      editionIds: [E(2025), E(2030)],
      measureYears: [2025],
      authorityCodes: ['01', '77'],
    })._unsafeUnwrap();
    const plan = planTotals(query, INVENTORY)._unsafeUnwrap();
    expect(plan.unloadedEditionIds).toEqual([E(2030)]);
    expect(plan.missingAuthorities).toEqual([{ editionId: E(2025), code: '77' }]);
    expect(plan.cells.map((c) => c.authority?.code)).toEqual(['01']);
  });

  it('defaults authority totals to every loaded authority except the 999 revenue holder', () => {
    const query = validateApprovedTotalsInput({
      totals: ['AUTHORITY_EXPENDITURE_5001'],
      creditTypes: ['BUDGET_CREDITS'],
      editionIds: [E(2025)],
      measureYears: [2025],
    })._unsafeUnwrap();
    const plan = planTotals(query, INVENTORY)._unsafeUnwrap();
    expect(plan.cells.map((c) => c.authority?.code)).toEqual(['01', '02']);
  });

  it('never picks one of several printed names sharing an authority code', () => {
    const inventory = [
      inventoryEdition(2025, {
        authorities: [authority('01', 'Old name'), authority('01', 'New name'), authority('02')],
      }),
    ];
    const query = validateApprovedTotalsInput({
      totals: ['AUTHORITY_EXPENDITURE_5001'],
      creditTypes: ['BUDGET_CREDITS'],
      measureYears: [2025],
    })._unsafeUnwrap();
    const plan = planTotals(query, inventory)._unsafeUnwrap();
    expect(plan.cells.map((c) => [c.authorityCode, c.authority?.name ?? null])).toEqual([
      ['01', null],
      ['02', 'Authority 02'],
    ]);
    expect(totalsDescriptorGroups(plan).map((g) => g.authorityCode)).toEqual(['01', '02']);
    const own = authority('01', 'New name');
    const classification = classifyCandidates(
      [candidate({ approved: '5' }, { authority: own })],
      plan.cells[0]!
    );
    const cell = projectTotalCell(plan.cells[0]!, classification, 'THOUSAND_LEI')._unsafeUnwrap();
    expect(cell.authority).toEqual(own);
  });

  it('counts cells before any read and refuses more than 100', () => {
    const query = validateApprovedTotalsInput({
      totals: [
        'REVENUE_TOTAL',
        'EXPENDITURE_5000_TOTAL_GENERAL',
        'EXPENDITURE_5001_STATE_BUDGET',
        'EXPENDITURE_5005_CHELTUIELI_TOTAL',
      ],
      creditTypes: ['BUDGET_CREDITS', 'COMMITMENT_CREDITS'],
    })._unsafeUnwrap();
    const refused = planTotals(query, INVENTORY);
    expect(refused._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'input' });
    const narrowed = planTotals(
      { ...query, editionIds: [{ id: E(2025), budgetYear: 2025 }] },
      INVENTORY
    );
    expect(narrowed._unsafeUnwrap().cells.length).toBeLessThanOrEqual(100);
  });

  it('keeps named totals separate per fund and marks a missing form explicitly', () => {
    const inventory = [
      inventoryEdition(2025, {
        forms: loadedForms(ALL_FORMS.filter((f) => f !== 'HEALTH_INSURANCE_SYNTHESIS')),
      }),
    ];
    const query = validateApprovedTotalsInput({
      totals: ['EXPENDITURE_5000_TOTAL_GENERAL', 'EXPENDITURE_5005_CHELTUIELI_TOTAL'],
      creditTypes: ['BUDGET_CREDITS'],
      funds: ['HEALTH_INSURANCE'],
      measureYears: [2025],
    })._unsafeUnwrap();
    const plan = planTotals(query, inventory)._unsafeUnwrap();
    expect(plan.cells.map((c) => `${c.total}:${String(c.formLoaded)}`)).toEqual([
      'EXPENDITURE_5000_TOTAL_GENERAL:false',
      'EXPENDITURE_5005_CHELTUIELI_TOTAL:false',
    ]);
    expect(totalsDescriptorGroups(plan)).toEqual([]);
    const cell = projectTotalCell(plan.cells[0]!, null, 'THOUSAND_LEI')._unsafeUnwrap();
    expect(cell).toMatchObject({
      status: 'FORM_NOT_LOADED',
      matchCount: 0,
      value: null,
      authorityCode: null,
      authority: null,
    });
  });

  it('keeps each explicitly requested authority code when the authority form is missing', () => {
    const inventory = [
      inventoryEdition(2025, {
        forms: loadedForms(ALL_FORMS.filter((f) => f !== 'STATE_BUDGET_AUTHORITY_DETAIL')),
      }),
    ];
    const explicit = validateApprovedTotalsInput({
      totals: ['AUTHORITY_EXPENDITURE_5001'],
      creditTypes: ['BUDGET_CREDITS'],
      measureYears: [2025],
      authorityCodes: ['02', '01'],
    })._unsafeUnwrap();
    const plan = planTotals(explicit, inventory)._unsafeUnwrap();
    expect(plan.cells.map((c) => [c.authorityCode, c.authority, c.formLoaded])).toEqual([
      ['01', null, false],
      ['02', null, false],
    ]);
    expect(plan.missingAuthorities).toEqual([]);
    expect(totalsDescriptorGroups(plan)).toEqual([]);
    const cells = plan.cells.map((c) => projectTotalCell(c, null, 'THOUSAND_LEI')._unsafeUnwrap());
    expect(cells.map((c) => [c.authorityCode, c.authority, c.status])).toEqual([
      ['01', null, 'FORM_NOT_LOADED'],
      ['02', null, 'FORM_NOT_LOADED'],
    ]);
    // Unfiltered: one explicit null-code summary per slot, never invented authorities.
    const unfiltered = planTotals({ ...explicit, authorityCodes: null }, inventory)._unsafeUnwrap();
    expect(unfiltered.cells.map((c) => [c.authorityCode, c.authority])).toEqual([[null, null]]);
  });

  it('echoes the authority code on loaded authority cells and null on fund-scope cells', () => {
    const query = validateApprovedTotalsInput({
      totals: ['AUTHORITY_EXPENDITURE_5001', 'EXPENDITURE_5001_STATE_BUDGET'],
      creditTypes: ['BUDGET_CREDITS'],
      editionIds: [E(2025)],
      measureYears: [2025],
      authorityCodes: ['01'],
    })._unsafeUnwrap();
    const plan = planTotals(query, INVENTORY)._unsafeUnwrap();
    const cells = plan.cells.map((c) =>
      projectTotalCell(c, classifyCandidates([], c), 'THOUSAND_LEI')._unsafeUnwrap()
    );
    expect(
      cells.map((c) => [c.total, c.authorityCode, c.authority?.name ?? null, c.status])
    ).toEqual([
      ['EXPENDITURE_5001_STATE_BUDGET', null, null, 'NO_MATCHING_RECORD'],
      ['AUTHORITY_EXPENDITURE_5001', '01', 'Administratia Prezidentiala', 'NO_MATCHING_RECORD'],
    ]);
  });

  it('reads each descriptor group once with all slots, then picks per-cell targets', () => {
    const query = validateApprovedTotalsInput({
      totals: ['EXPENDITURE_5001_STATE_BUDGET'],
      creditTypes: ['BUDGET_CREDITS'],
      editionIds: [E(2025)],
    })._unsafeUnwrap();
    const plan = planTotals(query, INVENTORY)._unsafeUnwrap();
    expect(plan.cells).toHaveLength(4);
    expect(totalsDescriptorGroups(plan)).toEqual([
      {
        editionId: E(2025),
        form: 'STATE_BUDGET_SYNTHESIS',
        total: 'EXPENDITURE_5001_STATE_BUDGET',
        creditType: 'BUDGET_CREDITS',
        authorityCode: null,
      },
    ]);
  });
});

describe('descriptor candidate classification', () => {
  const approved = slotsFor(2025)[0]!;
  const forecast = slotsFor(2025)[1]!;

  it('distinguishes no record, a blank target slot, ambiguity and a value', () => {
    expect(classifyCandidates([], target(approved))).toMatchObject({
      status: 'NO_MATCHING_RECORD',
      matchCount: 0,
      value: null,
    });
    // The record stores its approved value but not the requested forecast slot:
    // reading all slots first keeps it SLOT_WITHOUT_VALUE, not NO_MATCHING_RECORD.
    const onlyApproved = [candidate({ approved: LAW_EVIDENCE.state5001Approved2025 })];
    expect(classifyCandidates(onlyApproved, target(forecast))).toMatchObject({
      status: 'SLOT_WITHOUT_VALUE',
      matchCount: 1,
      value: null,
    });
    // Two matching records where only one stores the target: still AMBIGUOUS.
    const two = [
      candidate({ approved: '1', forecast_1: '2' }, { recordIndex: 10 }),
      candidate({ approved: '3' }, { recordIndex: 11 }),
    ];
    expect(classifyCandidates(two, target(forecast))).toMatchObject({
      status: 'AMBIGUOUS',
      matchCount: 2,
      value: null,
      match: null,
    });
    const conflicting = [
      candidate({ approved: '1' }, { interpretationId: 'a' }),
      candidate({ approved: '1' }, { interpretationId: 'b' }),
    ];
    expect(classifyCandidates(conflicting, target(approved, ['a', 'b'])).status).toBe('AMBIGUOUS');
    const one = classifyCandidates([candidate({ approved: '0' })], target(approved));
    expect(one.status).toBe('AVAILABLE');
    expect(one.value === null ? null : toWireDecimal(one.value)).toBe('0');
  });

  it('projects an available cell exactly in RON with its line reference', () => {
    const query = validateApprovedTotalsInput({
      totals: ['EXPENDITURE_5001_STATE_BUDGET'],
      creditTypes: ['BUDGET_CREDITS'],
      editionIds: [E(2025)],
      measureYears: [2025],
      unit: 'RON',
    })._unsafeUnwrap();
    const plan = planTotals(query, INVENTORY)._unsafeUnwrap();
    const classification = classifyCandidates(
      [candidate({ approved: LAW_EVIDENCE.state5001Approved2025 })],
      plan.cells[0]!
    );
    const cell = projectTotalCell(plan.cells[0]!, classification, query.unit)._unsafeUnwrap();
    expect(cell.status).toBe('AVAILABLE');
    expect(cell.unit).toBe('RON');
    expect(cell.value === null ? null : toWireDecimal(cell.value)).toBe(
      LAW_EVIDENCE.state5001Approved2025Ron
    );
    expect(cell.line?.field).toBe('approved');
    expect(cell.candidates).toHaveLength(1);
  });
});

describe('form-level interpretation conflict', () => {
  const approved = slotsFor(2025)[0]!;
  const forecast = slotsFor(2025)[1]!;
  const conflict = ['interp-a', 'interp-b'];

  it('is AMBIGUOUS when the other interpretation has no matching descriptor', () => {
    const onlyA = [candidate({ approved: '10' }, { interpretationId: 'interp-a' })];
    expect(classifyCandidates(onlyA, target(approved, conflict))).toMatchObject({
      status: 'AMBIGUOUS',
      matchCount: 1,
      value: null,
      match: null,
    });
  });

  it('is AMBIGUOUS (not SLOT_WITHOUT_VALUE) when the matched target slot is blank', () => {
    const blankTarget = [candidate({ approved: '10' }, { interpretationId: 'interp-a' })];
    expect(classifyCandidates(blankTarget, target(forecast, conflict)).status).toBe('AMBIGUOUS');
    expect(classifyCandidates([], target(forecast, conflict)).status).toBe('AMBIGUOUS');
  });

  it('applies per form in totals: other forms of the same edition stay unaffected', () => {
    const inventory = [
      inventoryEdition(2025, {
        forms: loadedForms(ALL_FORMS, { STATE_BUDGET_SYNTHESIS: conflict }),
      }),
    ];
    const query = validateApprovedTotalsInput({
      totals: ['REVENUE_TOTAL'],
      funds: ['STATE_BUDGET', 'HEALTH_INSURANCE'],
      measureYears: [2025],
    })._unsafeUnwrap();
    const plan = planTotals(query, inventory)._unsafeUnwrap();
    // A conflicting form is still read (candidate evidence), but never valued.
    expect(totalsDescriptorGroups(plan).map((g) => g.form)).toEqual([
      'STATE_BUDGET_SYNTHESIS',
      'HEALTH_INSURANCE_SYNTHESIS',
    ]);
    const cells = plan.cells.map((c) => {
      const candidates = [
        candidate(
          { approved: '7' },
          { interpretationId: c.fund === 'STATE_BUDGET' ? 'interp-a' : 'interp-1' }
        ),
      ];
      return projectTotalCell(c, classifyCandidates(candidates, c), query.unit)._unsafeUnwrap();
    });
    expect(
      cells.map((c) => [c.fund, c.status, c.value === null ? null : toWireDecimal(c.value)])
    ).toEqual([
      ['STATE_BUDGET', 'AMBIGUOUS', null],
      ['HEALTH_INSURANCE', 'AVAILABLE', '7'],
    ]);
  });

  it('applies to series periods through the same classification guard', () => {
    const inventory = [
      inventoryEdition(2025, {
        forms: loadedForms(ALL_FORMS, { STATE_BUDGET_SYNTHESIS: conflict }),
      }),
    ];
    const query = seriesInput({ axis: { ownYearApprovals: {} }, period: years('2025', '2025') });
    const plans = planApprovedSeries(query, inventory);
    const read = plans[0];
    expect(read?.kind === 'READ' ? read.formInterpretationIds : []).toEqual(conflict);
    const classifications = new Map<string, ApprovedClassification>();
    if (read?.kind === 'READ') {
      classifications.set(
        read.date,
        classifyCandidates([candidate({ approved: '9' }, { interpretationId: 'interp-a' })], read)
      );
    }
    const projection = projectApprovedSeries(query, plans, classifications)._unsafeUnwrap();
    expect(projection.series.data).toEqual([]);
    expect(projection.periods.map((p) => [p.status, p.matchCount])).toEqual([['AMBIGUOUS', 1]]);
  });
});

describe('approved series axes keep budget year and target year distinct', () => {
  it('editionsForTarget: date = edition year, measureYear = the fixed target', () => {
    const query = seriesInput({});
    const plans = planApprovedSeries(query, INVENTORY);
    expect(summary(plans)).toEqual([
      `2022:READ:${E(2022)}:2025:FORECAST`,
      `2023:READ:${E(2023)}:2025:FORECAST`,
      `2024:READ:${E(2024)}:2025:FORECAST`,
      `2025:READ:${E(2025)}:2025:APPROVED`,
    ]);
    const forecasts = LAW_EVIDENCE.state5001ForecastFor2025;
    const classifications = new Map<string, ApprovedClassification>();
    for (const plan of plans) {
      if (plan.kind !== 'READ') continue;
      const value =
        plan.date === '2025'
          ? LAW_EVIDENCE.state5001Approved2025
          : forecasts[Number(plan.date) as keyof typeof forecasts];
      classifications.set(
        plan.date,
        classifyCandidates([candidate({ [plan.slot.field]: value })], plan)
      );
    }
    const projection = projectApprovedSeries(query, plans, classifications)._unsafeUnwrap();
    expect(toWireDataSeries(projection.series)).toEqual({
      frequency: 'YEAR',
      data: [
        { date: '2022', value: '346134145' },
        { date: '2023', value: '375444061' },
        { date: '2024', value: '415039725' },
        { date: '2025', value: '499582980' },
      ],
    });
    expect(projection.periods.map((p) => [p.date, p.budgetYear, p.measureYear, p.measure])).toEqual(
      [
        ['2022', 2022, 2025, 'FORECAST'],
        ['2023', 2023, 2025, 'FORECAST'],
        ['2024', 2024, 2025, 'FORECAST'],
        ['2025', 2025, 2025, 'APPROVED'],
      ]
    );
    expect(seriesDescriptorGroups(query, plans)).toHaveLength(4);
  });

  it('editionsForTarget: a past or beyond-horizon target is NOT_IN_EDITION', () => {
    const query = seriesInput({ axis: { editionsForTarget: { targetYear: 2023 } } });
    const statuses = summary(planApprovedSeries(query, INVENTORY));
    expect(statuses).toEqual([
      `2022:READ:${E(2022)}:2023:FORECAST`,
      `2023:READ:${E(2023)}:2023:APPROVED`,
      '2024:NOT_IN_EDITION',
      '2025:NOT_IN_EDITION',
    ]);
    const beyond = seriesInput({ axis: { editionsForTarget: { targetYear: 2026 } } });
    expect(summary(planApprovedSeries(beyond, INVENTORY))[0]).toBe('2022:NOT_IN_EDITION');
  });

  it('targetYearsOfEdition: date = target year inside one fixed law', () => {
    const query = seriesInput({
      axis: { targetYearsOfEdition: E(2025) },
      period: years('2024', '2029'),
    });
    expect(summary(planApprovedSeries(query, INVENTORY))).toEqual([
      '2024:NOT_IN_EDITION',
      `2025:READ:${E(2025)}:2025:APPROVED`,
      `2026:READ:${E(2025)}:2026:FORECAST`,
      `2027:READ:${E(2025)}:2027:FORECAST`,
      `2028:READ:${E(2025)}:2028:FORECAST`,
      '2029:NOT_IN_EDITION',
    ]);
    const unloaded = seriesInput({ axis: { targetYearsOfEdition: E(2030) } });
    expect(
      new Set(summary(planApprovedSeries(unloaded, INVENTORY)).map((s) => s.split(':')[1]))
    ).toEqual(new Set(['EDITION_NOT_LOADED']));
  });

  it('ownYearApprovals: each law own approved year; ambiguity and gaps stay explicit', () => {
    const inventory = [
      ...INVENTORY,
      inventoryEdition(2024, { edition: editionRef(2024, 'rectified_law') }),
    ];
    const query = seriesInput({ axis: { ownYearApprovals: {} }, period: years('2021', '2025') });
    const plans = planApprovedSeries(query, inventory);
    expect(summary(plans)).toEqual([
      '2021:EDITION_NOT_LOADED',
      `2022:READ:${E(2022)}:2022:APPROVED`,
      `2023:READ:${E(2023)}:2023:APPROVED`,
      '2024:MULTIPLE_EDITIONS',
      `2025:READ:${E(2025)}:2025:APPROVED`,
    ]);
    const multiple = plans[3];
    expect(multiple?.kind === 'STATUS' ? multiple.candidateEditions.map((e) => e.id) : []).toEqual([
      E(2024),
      editionRef(2024, 'rectified_law').id,
    ]);
    const restricted = seriesInput({
      axis: { ownYearApprovals: { editionIds: [E(2024)] } },
      period: years('2024', '2025'),
    });
    expect(summary(planApprovedSeries(restricted, inventory))).toEqual([
      `2024:READ:${E(2024)}:2024:APPROVED`,
      '2025:EDITION_NOT_LOADED',
    ]);
  });

  it('marks a missing form and a duplicated target slot explicitly', () => {
    const noState = [
      inventoryEdition(2025, { forms: loadedForms(['HEALTH_INSURANCE_SYNTHESIS']) }),
    ];
    const query = seriesInput({ axis: { ownYearApprovals: {} }, period: years('2025', '2025') });
    expect(summary(planApprovedSeries(query, noState))).toEqual(['2025:FORM_NOT_LOADED']);
    const duplicated = [
      inventoryEdition(2025, {
        slots: [
          ...slotsFor(2025),
          { field: 'approved_bis', measure: 'APPROVED', measureYear: 2025 },
        ],
      }),
    ];
    expect(summary(planApprovedSeries(query, duplicated))).toEqual(['2025:AMBIGUOUS']);
  });

  it('never emits numbers for non-available periods and refuses a missing read', () => {
    const query = seriesInput({ axis: { ownYearApprovals: {} }, period: years('2024', '2025') });
    const plans = planApprovedSeries(query, INVENTORY);
    const blank = new Map<string, ApprovedClassification>([
      ['2024', classifyCandidates([candidate({ forecast_1: '1' })], target(slotsFor(2024)[0]!))],
      ['2025', classifyCandidates([], target(slotsFor(2025)[0]!))],
    ]);
    const projection = projectApprovedSeries(query, plans, blank)._unsafeUnwrap();
    expect(projection.series.data).toEqual([]);
    expect(projection.periods.map((p) => p.status)).toEqual([
      'SLOT_WITHOUT_VALUE',
      'NO_MATCHING_RECORD',
    ]);
    expect(projectApprovedSeries(query, plans, new Map()).isErr()).toBe(true);
  });
});
