/**
 * National budget — in-memory law inventory and candidate builders for pure
 * core tests (no mocking library, no database).
 */

import { NationalDecimal } from '@/modules/budget/core/national/values.js';

import type {
  ClassificationTarget,
  DescriptorCandidate,
} from '@/modules/budget/core/national/approved-plan.js';
import type {
  ApprovedAuthority,
  ApprovedCandidateRef,
  ApprovedEditionInventory,
  ApprovedFormInventory,
  ApprovedLineRef,
  ApprovedSlot,
  EditionRef,
} from '@/modules/budget/core/national/models.js';
import type { ApprovedForm } from '@/modules/budget/core/national/vocabulary.js';

export const PUBLICATION = 'law_as_sent_to_monitorul_oficial';

export const editionRef = (budgetYear: number, publication = PUBLICATION): EditionRef => ({
  id: `${String(budgetYear)}:${publication}`,
  budgetYear,
  publication,
});

/** Own year approved plus three forecast years (the reviewed 2018+ shape). */
export const slotsFor = (budgetYear: number): readonly ApprovedSlot[] => [
  { field: 'approved', measure: 'APPROVED', measureYear: budgetYear },
  { field: 'forecast_1', measure: 'FORECAST', measureYear: budgetYear + 1 },
  { field: 'forecast_2', measure: 'FORECAST', measureYear: budgetYear + 2 },
  { field: 'forecast_3', measure: 'FORECAST', measureYear: budgetYear + 3 },
];

export const ALL_FORMS: readonly ApprovedForm[] = [
  'STATE_BUDGET_SYNTHESIS',
  'STATE_BUDGET_AUTHORITY_DETAIL',
  'STATE_SOCIAL_INSURANCE_SYNTHESIS',
  'HEALTH_INSURANCE_SYNTHESIS',
  'UNEMPLOYMENT_INSURANCE_SYNTHESIS',
];

/**
 * Fixture simplification: every loaded form has the single interpretation
 * `interp-1` (the candidates' default), unless a test adds a conflict.
 */
export const DEFAULT_INTERPRETATION = 'interp-1';

export const loadedForms = (
  forms: readonly ApprovedForm[] = ALL_FORMS,
  interpretations: Partial<Record<ApprovedForm, readonly string[]>> = {}
): readonly ApprovedFormInventory[] =>
  forms.map((form) => ({
    form,
    interpretationIds: interpretations[form] ?? [DEFAULT_INTERPRETATION],
  }));

/** Classification target of a slot in a form with the given interpretations. */
export const target = (
  slot: ApprovedSlot,
  formInterpretationIds: readonly string[] = [DEFAULT_INTERPRETATION]
): ClassificationTarget => ({ slot, formInterpretationIds });

export const authority = (code: string, name = `Authority ${code}`): ApprovedAuthority => ({
  key: `auth:${code}`,
  code,
  name,
});

export const AUTHORITIES: readonly ApprovedAuthority[] = [
  authority('01', 'Administratia Prezidentiala'),
  authority('02', 'Senatul Romaniei'),
  authority('999', 'Titular Venituri'),
];

export const inventoryEdition = (
  budgetYear: number,
  overrides: Partial<ApprovedEditionInventory> = {}
): ApprovedEditionInventory => ({
  edition: editionRef(budgetYear),
  slots: slotsFor(budgetYear),
  forms: loadedForms(),
  authorities: AUTHORITIES,
  ...overrides,
});

/** 2022–2025 loaded, one publication each. */
export const INVENTORY: readonly ApprovedEditionInventory[] = [2022, 2023, 2024, 2025].map((year) =>
  inventoryEdition(year)
);

const lineRef = (
  interpretationId: string,
  recordIndex: number,
  field: string
): ApprovedLineRef => ({
  lineId: `${interpretationId}:${String(recordIndex)}:${field}`,
  interpretationId,
  recordIndex,
  field,
  annex: '1',
  token: 'token',
  sourceFileId: 'source-file',
  document: { url: null, sha256: 'a'.repeat(64), bytes: null },
});

/** A descriptor candidate with the given stored slot values (thousand lei text). */
export const candidate = (
  slotValues: Readonly<Record<string, string>>,
  options: { interpretationId?: string; recordIndex?: number; authority?: ApprovedAuthority } = {}
): DescriptorCandidate<ApprovedCandidateRef> => {
  const interpretationId = options.interpretationId ?? DEFAULT_INTERPRETATION;
  const recordIndex = options.recordIndex ?? 10;
  const fields = Object.keys(slotValues);
  return {
    interpretationId,
    recordIndex,
    slotValues: new Map(
      fields.map((field) => [field, new NationalDecimal(slotValues[field] ?? '0')])
    ),
    ref: {
      descriptor: {
        recordIndex,
        rowRole: 'CREDIT',
        codes: {
          capitol: '5001',
          subcapitol: '',
          paragraf: '',
          grupa: null,
          titlu: null,
          articol: '',
          alineat: '',
        },
        label: 'CHELTUIELI - BUGET DE STAT',
        contextRecordIndex: null,
        contextLabel: 'CHELTUIELI - BUGET DE STAT',
      },
      authority: options.authority ?? null,
      lines: new Map(fields.map((field) => [field, lineRef(interpretationId, recordIndex, field)])),
    },
  };
};
