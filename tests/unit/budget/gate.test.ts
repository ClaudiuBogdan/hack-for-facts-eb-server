/**
 * Budget §0.3 grain gate + enum↔partition-literal map (no live DB).
 *
 * The gate is the load-bearing perf guard: every FACT query MUST carry the
 * pruning triple (year + report_type + account_category; commitments: the pair)
 * mapped to the EXACT partition literals so the planner prunes to one leaf. These
 * tests pin the literals (verified live) and assert the gate rejects unbounded
 * scans and rejects accountCategory on commitments.
 */

import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_CATEGORY_FROM_LABEL,
  ACCOUNT_CATEGORY_LABELS,
  COMMITMENT_REPORT_TYPE_FROM_LABEL,
  COMMITMENT_REPORT_TYPE_LABELS,
  EXECUTION_REPORT_TYPE_FROM_LABEL,
  EXECUTION_REPORT_TYPE_LABELS,
} from '@/modules/budget/core/constants.js';
import {
  resolveCommitmentGate,
  resolveExecutionGate,
} from '@/modules/budget/shell/repo/filter-helpers.js';

const EXEC_DEFAULTS = {
  reportType: 'EXECUTION_DETAILED',
  accountCategory: 'EXPENSE',
  frequency: 'YEAR',
} as const;
const COMMIT_DEFAULTS = { reportType: 'COMMITMENT_AGG_PRINCIPAL', frequency: 'YEAR' } as const;

describe('enum ↔ partition-literal map (verified live 2026-06-17)', () => {
  it('execution report types map to the exact partition literals', () => {
    expect(EXECUTION_REPORT_TYPE_LABELS.EXECUTION_DETAILED).toBe('Executie bugetara detaliata');
    expect(EXECUTION_REPORT_TYPE_LABELS.EXECUTION_AGG_PRINCIPAL).toBe(
      'Executie bugetara agregata la nivel de ordonator principal'
    );
    expect(EXECUTION_REPORT_TYPE_LABELS.EXECUTION_AGG_SECONDARY).toBe(
      'Executie bugetara agregata la nivel de ordonator secundar'
    );
  });

  it('commitment report types map to the exact partition literals', () => {
    expect(COMMITMENT_REPORT_TYPE_LABELS.COMMITMENT_AGG_PRINCIPAL).toBe(
      'Executie - Angajamente bugetare agregat principal'
    );
    expect(COMMITMENT_REPORT_TYPE_LABELS.COMMITMENT_DETAILED).toBe(
      'Executie - Angajamente bugetare detaliat'
    );
  });

  it('account category maps INCOME→vn / EXPENSE→ch (the L3 partition keys)', () => {
    expect(ACCOUNT_CATEGORY_LABELS.INCOME).toBe('vn');
    expect(ACCOUNT_CATEGORY_LABELS.EXPENSE).toBe('ch');
  });

  it('reverse maps round-trip every label', () => {
    for (const [enumVal, label] of Object.entries(EXECUTION_REPORT_TYPE_LABELS)) {
      expect(EXECUTION_REPORT_TYPE_FROM_LABEL.get(label)).toBe(enumVal);
    }
    for (const [enumVal, label] of Object.entries(COMMITMENT_REPORT_TYPE_LABELS)) {
      expect(COMMITMENT_REPORT_TYPE_FROM_LABEL.get(label)).toBe(enumVal);
    }
    expect(ACCOUNT_CATEGORY_FROM_LABEL.get('vn')).toBe('INCOME');
    expect(ACCOUNT_CATEGORY_FROM_LABEL.get('ch')).toBe('EXPENSE');
  });
});

describe('execution gate — pruning triple enforcement', () => {
  it('resolves the triple to partition literals when year + defaults are present', () => {
    const gate = resolveExecutionGate(
      { reportingYear: { eq: 2025 } },
      EXEC_DEFAULTS
    )._unsafeUnwrap();
    expect(gate.years.eq).toBe(2025);
    expect(gate.reportLabel).toBe('Executie bugetara detaliata'); // default → literal, NOT the enum
    expect(gate.accountLabel).toBe('ch'); // EXPENSE default → ch
    expect(gate.frequency).toBe('YEAR');
  });

  it('honors an explicit reportType + accountCategory (mapped to literals)', () => {
    const gate = resolveExecutionGate(
      {
        reportingYear: { eq: 2024 },
        reportType: { eq: 'EXECUTION_AGG_PRINCIPAL' },
        accountCategory: { eq: 'INCOME' },
      },
      EXEC_DEFAULTS
    )._unsafeUnwrap();
    expect(gate.reportLabel).toBe('Executie bugetara agregata la nivel de ordonator principal');
    expect(gate.accountLabel).toBe('vn');
  });

  it('accepts a bounded year range (between) and an IN list', () => {
    expect(
      resolveExecutionGate(
        { reportingYear: { between: { from: 2020, to: 2024 } } },
        EXEC_DEFAULTS
      ).isOk()
    ).toBe(true);
    expect(
      resolveExecutionGate({ reportingYear: { in: [2023, 2024] } }, EXEC_DEFAULTS).isOk()
    ).toBe(true);
  });

  it('REJECTS a year-less fact query (the unbounded-scan guard)', () => {
    const r = resolveExecutionGate({ entityCuis: { in: ['4305857'] } }, EXEC_DEFAULTS);
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().type).toBe('InvalidInput');
  });

  it('REJECTS an empty IN year (no real bound — the empty-array footgun)', () => {
    expect(resolveExecutionGate({ reportingYear: { in: [] } }, EXEC_DEFAULTS).isErr()).toBe(true);
  });

  it('REJECTS an unknown reportType / accountCategory', () => {
    expect(
      resolveExecutionGate(
        { reportingYear: { eq: 2025 }, reportType: { eq: 'NOPE' } },
        EXEC_DEFAULTS
      ).isErr()
    ).toBe(true);
    expect(
      resolveExecutionGate(
        { reportingYear: { eq: 2025 }, accountCategory: { eq: 'NOPE' } },
        EXEC_DEFAULTS
      ).isErr()
    ).toBe(true);
  });
});

describe('commitment gate — pair enforcement, NO account_category', () => {
  it('resolves the pair (year + report_type) with no account_category', () => {
    const gate = resolveCommitmentGate(
      { reportingYear: { eq: 2025 } },
      COMMIT_DEFAULTS
    )._unsafeUnwrap();
    expect(gate.reportLabel).toBe('Executie - Angajamente bugetare agregat principal');
    expect(gate.frequency).toBe('YEAR');
  });

  it('REJECTS accountCategory on a commitment query (single grain per row)', () => {
    const r = resolveCommitmentGate(
      { reportingYear: { eq: 2025 }, accountCategory: { eq: 'EXPENSE' } },
      COMMIT_DEFAULTS
    );
    expect(r.isErr()).toBe(true);
    const e = r._unsafeUnwrapErr();
    expect(e.type === 'InvalidInput' ? e.field : undefined).toBe('accountCategory');
  });

  it('REJECTS a year-less commitment query', () => {
    expect(
      resolveCommitmentGate({ entityCuis: { in: ['4305857'] } }, COMMIT_DEFAULTS).isErr()
    ).toBe(true);
  });
});
