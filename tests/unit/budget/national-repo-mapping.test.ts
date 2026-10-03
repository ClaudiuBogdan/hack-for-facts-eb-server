import { describe, expect, it } from 'vitest';

import { toWireDecimal } from '@/modules/budget/core/national/values.js';
import {
  buildInventory,
  recordsFromLines,
} from '@/modules/budget/shell/repo/national-approved-repo.js';
import {
  chainsFromRows,
  occurrenceFromRow,
  seriesFromRows,
} from '@/modules/budget/shell/repo/national-execution-repo.js';
import { NationalSourceContractError } from '@/modules/budget/shell/repo/national-read-port.js';

import { makeSourceWorld, SERIES_ROWS } from '../../fixtures/national-budget/source-world.js';

const world = makeSourceWorld();
const rows = (tag: string, parameters: readonly unknown[] = []): Record<string, unknown>[] =>
  world.respond(`/* budget.national:${tag} */`, parameters) as Record<string, unknown>[];

type Arg<F> = F extends (...args: infer A) => unknown ? A : never;

describe('law row mapping', () => {
  it('counts unrecognised fund/form groups and unservable publications instead of guessing', () => {
    const slots = rows('approved_inventory_slots');
    const forms = rows('approved_inventory_forms');
    const odd = [
      { ...forms[0], fund: 'health_insurance' }, // state synthesis under the wrong fund
      { ...forms[0], publication: 'law 2022 / with spaces', interpretation_id: 'x' },
    ];
    const inventory = buildInventory(
      slots as unknown as Arg<typeof buildInventory>[0],
      [...forms, ...odd] as unknown as Arg<typeof buildInventory>[1]
    );
    expect(inventory.unrecognized.map((g) => [g.fund, g.form, g.publication])).toEqual([
      ['local_budgets', 'local_budget_synthesis', 'law_2025_as_sent_to_monitorul_oficial'],
      ['health_insurance', 'state_budget_synthesis', 'law_2022_as_sent_to_monitorul_oficial'],
      ['state_budget', 'state_budget_synthesis', 'law 2022 / with spaces'],
    ]);
    // Every inventory row still feeds the lane token.
    expect(inventory.snapshotRows).toHaveLength(forms.length + odd.length);
  });

  it('flags a form with two interpretations as conflicting', () => {
    const forms = rows('approved_inventory_forms');
    const second = { ...forms[3], interpretation_id: 'budget-law-approved:second' };
    const inventory = buildInventory(
      rows('approved_inventory_slots') as unknown as Arg<typeof buildInventory>[0],
      [...forms, second] as unknown as Arg<typeof buildInventory>[1]
    );
    const e2025 = inventory.editions.find((e) => e.edition.budgetYear === 2025);
    expect(e2025?.hasConflictingInterpretations).toBe(true);
    expect(
      e2025?.forms.find((f) => f.form === 'STATE_BUDGET_SYNTHESIS')?.interpretationIds
    ).toHaveLength(2);
  });

  it('keeps exact amounts and refuses unknown literals or non-numeric amounts', () => {
    const lines = rows('approved_records_page', [
      ['budget-law-approved:fixture-authority-2025'],
      50,
    ]);
    const records = recordsFromLines(lines as unknown as Arg<typeof recordsFromLines>[0]);
    expect(records.map((r) => r.recordIndex)).toEqual([10, 11, 12, 13]);
    expect(toWireDecimal(records[2]?.slots[0]?.value ?? records[0]!.slots[0]!.value)).toBe(
      '27546712048.55000178213231265544891357421875'
    );
    const first = lines[0]!;
    expect(() =>
      recordsFromLines([{ ...first, measure: 'estimate' }] as unknown as Arg<
        typeof recordsFromLines
      >[0])
    ).toThrow(NationalSourceContractError);
    expect(() =>
      recordsFromLines([{ ...first, amount: '1e5' }] as unknown as Arg<typeof recordsFromLines>[0])
    ).toThrow(NationalSourceContractError);
  });
});

describe('execution row mapping', () => {
  it('refuses unknown presence literals and overflowing chains', () => {
    const chain = rows('execution_release_chains', [['2006-07-31'], 1000, 1000, 1]);
    expect(
      chainsFromRows(chain as unknown as Arg<typeof chainsFromRows>[0])[0]?.newest[0]?.release
        .families
    ).toHaveLength(3);
    const head = chain[0]!;
    const families = head['contract_families'] as Record<string, unknown>[];
    expect(() =>
      chainsFromRows([
        { ...head, contract_families: [{ ...families[0], presence: 'maybe' }] },
      ] as unknown as Arg<typeof chainsFromRows>[0])
    ).toThrow(NationalSourceContractError);
    expect(() =>
      chainsFromRows([{ ...head, overflow: true }] as unknown as Arg<typeof chainsFromRows>[0])
    ).toThrow(NationalSourceContractError);
  });

  it('refuses malformed IDs and unknown dispositions in observation rows', () => {
    // A single-selection FACT statement (the responder routes on these markers).
    const page = world.respond(
      '/* budget.national:execution_observations_page */ obs as ( budget.execution_release_facts f on',
      [['6110a784-1f51-4bee-8add-cf8bacf8455a'], ['bgc', 'sinteza'], 10]
    ) as Record<string, unknown>[];
    const row = { ...page[0] };
    expect(
      occurrenceFromRow(row as unknown as Arg<typeof occurrenceFromRow>[0]).node.value?.toFixed()
    ).toBe('662698173101.34997');
    for (const bad of [
      { selection_id: 'not-a-uuid' },
      { release_id: 'E0251200-0000-4000-8000-000000000001' },
      { disposition: 'blocked' },
      { section: 'assets' },
      { reference_year: '25' },
      { value_text: 'NaN' },
    ]) {
      expect(() =>
        occurrenceFromRow({ ...row, ...bad } as unknown as Arg<typeof occurrenceFromRow>[0])
      ).toThrow(NationalSourceContractError);
    }
  });

  it('keeps every stored locator coordinate: zero is present, absent is null, malformed is refused', () => {
    const page = world.respond(
      '/* budget.national:execution_observations_page */ obs as ( budget.execution_release_facts f on',
      [['4fe38180-00c8-599f-a53c-b5ddccb05ffc'], ['bgc', 'sinteza'], 10]
    ) as Record<string, unknown>[];
    const pdf = { ...page[0] };
    const mapped = occurrenceFromRow(pdf as unknown as Arg<typeof occurrenceFromRow>[0]);
    expect(mapped.node.locator).toEqual({
      kind: 'pdf_cell',
      sheet: null,
      cell: null,
      page: 1,
      table: 'bgc_national_current_amount',
      row: 1,
      column: 0,
    });
    const absent = occurrenceFromRow({
      ...pdf,
      locator_page: null,
      locator_table: null,
      locator_row: null,
      locator_column: null,
    } as unknown as Arg<typeof occurrenceFromRow>[0]);
    expect(absent.node.locator).toMatchObject({ page: null, table: null, row: null, column: null });
    for (const bad of [
      { locator_row: 'x' },
      { locator_row: '-1' },
      { locator_column: '1.5' },
      { locator_column: '' },
      { locator_page: '01' },
      { locator_page: '9999999999' },
    ]) {
      expect(() =>
        occurrenceFromRow({ ...pdf, ...bad } as unknown as Arg<typeof occurrenceFromRow>[0])
      ).toThrow(NationalSourceContractError);
    }
  });

  it('pins the reviewed view constants and value-basis vocabulary', () => {
    const row = SERIES_ROWS[3]!;
    expect(
      seriesFromRows('QUARTER', [row] as unknown as Arg<typeof seriesFromRows>[1]).rows[0]
    ).toMatchObject({
      date: '2025-Q2',
      periodStart: '2025-04-01',
      periodEnd: '2025-06-30',
      valueBasis: 'DERIVED_DIFFERENCE_BETWEEN_REPORTS',
    });
    for (const bad of [
      { derivation_version: 'bgc-selected-cumulative-difference-v2' },
      { component: 'state_budget' },
      { value_basis: 'interpolated' },
      { availability_reason: null },
    ]) {
      expect(() =>
        seriesFromRows('QUARTER', [{ ...row, ...bad }] as unknown as Arg<typeof seriesFromRows>[1])
      ).toThrow(NationalSourceContractError);
    }
  });
});
