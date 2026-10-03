/**
 * National budget — an in-memory source world for the real SQL read port.
 *
 * `respond(sql, parameters)` answers each tagged national statement
 * (`/* budget.national:<name> *\/`) with rows shaped exactly as PostgreSQL
 * returns them for that statement. Values marked P0 come from the reviewed
 * read-only P0 evidence (descriptor proof, series edges, modern cells,
 * family examples); anything else is SYNTHETIC and marked so. The responder
 * only routes rows (and applies keyset/limit where a statement pages); it
 * never re-implements the descriptor or catalog predicates, so expected values
 * in tests stay the P0 values, not mapper output.
 */

import { CATALOG_ITEMS } from './catalog-items.js';

const publication = (year: number): string => `law_${String(year)}_as_sent_to_monitorul_oficial`;

/** P0 interpretation IDs (descriptor proof); others SYNTHETIC. */
export const INTERPRETATIONS = {
  state2022: 'budget-law-approved:10f49035139b4ccbe8bb9b2d2b597dd05063ae8f3212beaae438b69241e0dc49',
  state2023: 'budget-law-approved:cf2262ae76950002ee0b41b1e2ce1517b935be4e39c2f98b247c3f52b49cb04e',
  state2024: 'budget-law-approved:df71c31865dc8b6901f1a1d70b2a58f0df0cfcf1cc820b29caa014ae39f3f820',
  state2025: 'budget-law-approved:523591c55a615569f83b3156b69132005e55ecc0bbdb1b4ea2eb1d394ad30c6c',
  health2025:
    'budget-law-approved:295ce02c287281bb210fc44a2a30572606ca65ba8f409d742f9330074341ad2f',
  authority2025: 'budget-law-approved:fixture-authority-2025',
} as const;

const SHA = (seed: string): string => seed.repeat(64).slice(0, 64);

// ── approved inventory (P0 line/record counts; SYNTHETIC sources/names) ──────

interface FormFixture {
  readonly year: number;
  readonly fund: string;
  readonly form: string;
  readonly interpretation: string;
  readonly lines: number;
  readonly records: number;
}

const FORMS: readonly FormFixture[] = [
  {
    year: 2022,
    fund: 'state_budget',
    form: 'state_budget_synthesis',
    interpretation: INTERPRETATIONS.state2022,
    lines: 3093,
    records: 904,
  },
  {
    year: 2023,
    fund: 'state_budget',
    form: 'state_budget_synthesis',
    interpretation: INTERPRETATIONS.state2023,
    lines: 3284,
    records: 984,
  },
  {
    year: 2024,
    fund: 'state_budget',
    form: 'state_budget_synthesis',
    interpretation: INTERPRETATIONS.state2024,
    lines: 3206,
    records: 965,
  },
  {
    year: 2025,
    fund: 'state_budget',
    form: 'state_budget_synthesis',
    interpretation: INTERPRETATIONS.state2025,
    lines: 3271,
    records: 974,
  },
  {
    year: 2025,
    fund: 'state_budget',
    form: 'state_budget_authority_detail',
    interpretation: INTERPRETATIONS.authority2025,
    lines: 19765,
    records: 7621,
  },
  {
    year: 2025,
    fund: 'health_insurance',
    form: 'health_insurance_synthesis',
    interpretation: INTERPRETATIONS.health2025,
    lines: 574,
    records: 153,
  },
];

/** SYNTHETIC: a loaded group outside the reviewed fund/form vocabulary. */
const UNRECOGNISED = {
  year: 2025,
  fund: 'local_budgets',
  form: 'local_budget_synthesis',
  interpretation: 'budget-law-approved:fixture-unrecognised',
  lines: 12,
  records: 4,
};

const SLOT_FIELDS = (year: number): readonly [string, string, number][] => [
  [`PROGRAM_${String(year)}`, 'approved', year],
  [`ESTIMARI${String(year + 1)}`, 'forecast', year + 1],
  [`ESTIMARI${String(year + 2)}`, 'forecast', year + 2],
  [`ESTIMARI${String(year + 3)}`, 'forecast', year + 3],
];

/** SYNTHETIC authority names (P0 shows zero name variants per code). */
export const AUTHORITY_NAMES: readonly (readonly [string, string])[] = [
  ['01', 'Administratia Prezidentiala'],
  ['02', 'Senatul Romaniei'],
  ['999', 'Titular Venituri'],
];

export const inventorySlotRows = (): Record<string, unknown>[] =>
  [...FORMS, UNRECOGNISED].flatMap((form) =>
    SLOT_FIELDS(form.year).map(([field, measure, measureYear]) => ({
      budget_year: form.year,
      publication: publication(form.year),
      fund: form.fund,
      form: form.form,
      interpretation_id: form.interpretation,
      field,
      measure,
      measure_year: measureYear,
      line_count: Math.floor(form.lines / 4),
    }))
  );

export const inventoryFormRows = (
  extra: readonly Record<string, unknown>[] = []
): Record<string, unknown>[] => [
  ...[...FORMS, UNRECOGNISED].map((form) => ({
    budget_year: form.year,
    publication: publication(form.year),
    fund: form.fund,
    form: form.form,
    interpretation_id: form.interpretation,
    line_count: form.lines,
    record_count: form.records,
    credit_types: ['budget_credits', 'commitment_credits'],
    sources: [{ sourceFileId: `fixture-file-${form.form}-${String(form.year)}`, sha256: SHA('a') }],
    authorities:
      form.form === 'state_budget_authority_detail'
        ? AUTHORITY_NAMES.map(([code, name]) => [code, name])
        : [],
  })),
  ...extra,
];

// ── descriptor candidate records (P0 descriptor proof values) ────────────────

interface CandidateFixture {
  readonly total: string;
  readonly year: number;
  readonly fund: string;
  readonly form: string;
  readonly authorityCode: string;
  readonly creditType: string | null;
  readonly interpretation: string;
  readonly recordIndex: number;
  readonly values: Readonly<Record<string, string>>;
}

export const CANDIDATES: readonly CandidateFixture[] = [
  {
    total: 'EXPENDITURE_5001_STATE_BUDGET',
    year: 2022,
    fund: 'state_budget',
    form: 'state_budget_synthesis',
    authorityCode: '00',
    creditType: 'budget_credits',
    interpretation: INTERPRETATIONS.state2022,
    recordIndex: 138,
    values: {
      PROGRAM_2022: '301729851',
      ESTIMARI2023: '313511116',
      ESTIMARI2024: '330277935',
      ESTIMARI2025: '346134145',
    },
  },
  {
    total: 'EXPENDITURE_5001_STATE_BUDGET',
    year: 2023,
    fund: 'state_budget',
    form: 'state_budget_synthesis',
    authorityCode: '00',
    creditType: 'budget_credits',
    interpretation: INTERPRETATIONS.state2023,
    recordIndex: 138,
    values: {
      PROGRAM_2023: '353314447',
      ESTIMARI2024: '347387005',
      ESTIMARI2025: '375444061',
      ESTIMARI2026: '401876338',
    },
  },
  {
    total: 'EXPENDITURE_5001_STATE_BUDGET',
    year: 2024,
    fund: 'state_budget',
    form: 'state_budget_synthesis',
    authorityCode: '00',
    creditType: 'budget_credits',
    interpretation: INTERPRETATIONS.state2024,
    recordIndex: 138,
    values: {
      PROGRAM_2024: '404238052',
      ESTIMARI2025: '415039725',
      ESTIMARI2026: '438203451',
      ESTIMARI2027: '426573313',
    },
  },
  {
    total: 'EXPENDITURE_5001_STATE_BUDGET',
    year: 2025,
    fund: 'state_budget',
    form: 'state_budget_synthesis',
    authorityCode: '00',
    creditType: 'budget_credits',
    interpretation: INTERPRETATIONS.state2025,
    recordIndex: 141,
    values: {
      PROGRAM_2025: '499582980',
      ESTIMARI2026: '486466732',
      ESTIMARI2027: '487383426',
      ESTIMARI2028: '500083194',
    },
  },
  {
    total: 'REVENUE_TOTAL',
    year: 2025,
    fund: 'state_budget',
    form: 'state_budget_synthesis',
    authorityCode: '00',
    creditType: null,
    interpretation: INTERPRETATIONS.state2025,
    recordIndex: 0,
    values: {
      PROGRAM_2025: '357353033',
      ESTIMARI2026: '349169360',
      ESTIMARI2027: '349399128',
      ESTIMARI2028: '367798364',
    },
  },
  {
    total: 'EXPENDITURE_5000_TOTAL_GENERAL',
    year: 2025,
    fund: 'health_insurance',
    form: 'health_insurance_synthesis',
    authorityCode: '01',
    creditType: 'budget_credits',
    interpretation: INTERPRETATIONS.health2025,
    recordIndex: 42,
    values: {
      PROGRAM_2025: '77224741',
      ESTIMARI2026: '79312302',
      ESTIMARI2027: '80398602',
      ESTIMARI2028: '82924442',
    },
  },
  {
    total: 'EXPENDITURE_5005_CHELTUIELI_TOTAL',
    year: 2025,
    fund: 'health_insurance',
    form: 'health_insurance_synthesis',
    authorityCode: '01',
    creditType: 'budget_credits',
    interpretation: INTERPRETATIONS.health2025,
    recordIndex: 78,
    values: {
      PROGRAM_2025: '77220381',
      ESTIMARI2026: '79309691',
      ESTIMARI2027: '80396581',
      ESTIMARI2028: '82924442',
    },
  },
  {
    total: 'REVENUE_TOTAL',
    year: 2025,
    fund: 'health_insurance',
    form: 'health_insurance_synthesis',
    authorityCode: '01',
    creditType: null,
    interpretation: INTERPRETATIONS.health2025,
    recordIndex: 0,
    values: {
      PROGRAM_2025: '77220381',
      ESTIMARI2026: '79309691',
      ESTIMARI2027: '84489423',
      ESTIMARI2028: '90210560',
    },
  },
  // SYNTHETIC authority row (P0 proves one candidate per authority; values not sampled).
  {
    total: 'AUTHORITY_EXPENDITURE_5001',
    year: 2025,
    fund: 'state_budget',
    form: 'state_budget_authority_detail',
    authorityCode: '01',
    creditType: 'budget_credits',
    interpretation: INTERPRETATIONS.authority2025,
    recordIndex: 11,
    values: { PROGRAM_2025: '1250000.5', ESTIMARI2026: '0' },
  },
];

const RULE_OF: Readonly<Record<string, { role: string; capitol: string; label: string }>> = {
  REVENUE_TOTAL: { role: 'descriptor', capitol: '0001', label: 'VENITURI - TOTAL' },
  EXPENDITURE_5000_TOTAL_GENERAL: { role: 'credit', capitol: '5000', label: 'TOTAL GENERAL' },
  EXPENDITURE_5001_STATE_BUDGET: {
    role: 'credit',
    capitol: '5001',
    label: 'CHELTUIELI - BUGET DE STAT',
  },
  EXPENDITURE_5005_CHELTUIELI_TOTAL: {
    role: 'credit',
    capitol: '5005',
    label: 'CHELTUIELI - TOTAL',
  },
  AUTHORITY_EXPENDITURE_5001: {
    role: 'credit',
    capitol: '5001',
    label: 'CHELTUIELI - BUGET DE STAT',
  },
};

const authorityName = (code: string): string =>
  AUTHORITY_NAMES.find(([c]) => c === code)?.[1] ?? `Fixture authority ${code}`;

/** Line rows of one stored record, as `RECORD_COLUMNS` returns them. */
const lineRows = (record: {
  year: number;
  fund: string;
  form: string;
  interpretation: string;
  recordIndex: number;
  authorityCode: string;
  role: string;
  capitol: string;
  label: string;
  contextLabel: string | null;
  creditType: string | null;
  values: Readonly<Record<string, string>>;
}): Record<string, unknown>[] =>
  SLOT_FIELDS(record.year)
    .filter(([field]) => record.values[field] !== undefined)
    .map(([field, measure, measureYear]) => ({
      interpretation_id: record.interpretation,
      record_index: record.recordIndex,
      budget_year: record.year,
      publication: publication(record.year),
      fund: record.fund,
      form: record.form,
      annex: '1',
      report_title: 'SYNTHETIC report title',
      authority_code: record.authorityCode,
      authority_name: authorityName(record.authorityCode),
      capitol: record.capitol,
      subcapitol: '',
      paragraf: '',
      grupa: '',
      titlu: null,
      articol: '',
      alineat: '',
      label: record.label,
      row_role: record.role,
      credit_type: record.creditType,
      context_record_index: record.role === 'credit' ? record.recordIndex - 1 : null,
      context_label: record.contextLabel,
      source_file_id: `fixture-file-${record.form}-${String(record.year)}`,
      content_sha256: SHA('b'),
      field,
      measure,
      measure_year: measureYear,
      amount: record.values[field],
      token: record.values[field],
    }));

const candidateLines = (candidate: CandidateFixture): Record<string, unknown>[] => {
  const rule = RULE_OF[candidate.total];
  if (rule === undefined) return [];
  return lineRows({
    year: candidate.year,
    fund: candidate.fund,
    form: candidate.form,
    interpretation: candidate.interpretation,
    recordIndex: candidate.recordIndex,
    authorityCode: candidate.authorityCode,
    role: rule.role,
    capitol: rule.capitol,
    label: rule.role === 'credit' ? 'Credite bugetare' : rule.label,
    contextLabel: rule.role === 'credit' ? rule.label : null,
    creditType: candidate.creditType,
    values: candidate.values,
  });
};

// ── records page (SYNTHETIC rows of the 2025 authority detail) ───────────────

export const AUTHORITY_RECORDS = [
  {
    recordIndex: 10,
    authorityCode: '01',
    role: 'descriptor',
    capitol: '5001',
    label: 'CHELTUIELI - BUGET DE STAT',
    contextLabel: null,
    creditType: null,
    values: { PROGRAM_2025: '0' },
  },
  {
    recordIndex: 11,
    authorityCode: '01',
    role: 'credit',
    capitol: '5001',
    label: 'Credite bugetare',
    contextLabel: 'CHELTUIELI - BUGET DE STAT',
    creditType: 'budget_credits',
    values: { PROGRAM_2025: '1250000.5', ESTIMARI2026: '0' },
  },
  {
    recordIndex: 12,
    authorityCode: '01',
    role: 'credit',
    capitol: '5001',
    label: 'Credite de angajament',
    contextLabel: 'CHELTUIELI - BUGET DE STAT',
    creditType: 'commitment_credits',
    values: { PROGRAM_2025: '27546712048.55000178213231265544891357421875' },
  },
  {
    recordIndex: 13,
    authorityCode: '02',
    role: 'descriptor',
    capitol: '5001',
    label: 'CHELTUIELI - BUGET DE STAT',
    contextLabel: null,
    creditType: null,
    values: { PROGRAM_2025: '42', ESTIMARI2026: '43', ESTIMARI2027: '44', ESTIMARI2028: '45' },
  },
] as const;

const authorityRecordLines = (): Record<string, unknown>[] =>
  AUTHORITY_RECORDS.flatMap((record) =>
    lineRows({
      year: 2025,
      fund: 'state_budget',
      form: 'state_budget_authority_detail',
      interpretation: INTERPRETATIONS.authority2025,
      ...record,
    })
  );

// ── execution: selections, releases, families (P0 IDs/URLs where noted) ──────

/** P0 selection IDs (series edges); others SYNTHETIC. */
export const SELECTIONS = {
  june2006: 'a04cc2ef-5100-4fb0-8000-000000000606',
  july2006: '4fe38180-00c8-599f-a53c-b5ddccb05ffc',
  march2025: '3a3a3a3a-0000-4000-8000-000000002503',
  april2025: '4b4b4b4b-0000-4000-8000-000000002504',
  june2025Root: 'c1c1c1c1-0000-4000-8000-000000002506',
  june2025Rollforward: 'c2c2c2c2-0000-4000-8000-000000002506',
  june2025: '0cda5d3a-09d1-4c3a-b794-455670ae0ec2',
  september2025: '9f9f9f9f-0000-4000-8000-000000002509',
  november2025: '8e8e8e8e-0000-4000-8000-000000002511',
  december2025: '6110a784-1f51-4bee-8add-cf8bacf8455a',
  july2026: '7d7d7d7d-0000-4000-8000-000000002607',
} as const;

/** SYNTHETIC release IDs. R1 is re-selected after R2 (rollback). */
export const RELEASES = {
  june2006: 'e0060600-0000-4000-8000-000000000001',
  july2006: 'e0060700-0000-4000-8000-000000000001',
  march2025: 'e0250300-0000-4000-8000-000000000001',
  april2025: 'e0250400-0000-4000-8000-000000000001',
  june2025R1: 'e0250600-0000-4000-8000-000000000001',
  june2025R2: 'e0250600-0000-4000-8000-000000000002',
  september2025: 'e0250900-0000-4000-8000-000000000001',
  november2025: 'e0251100-0000-4000-8000-000000000001',
  december2025: 'e0251200-0000-4000-8000-000000000001',
  july2026: 'e0260700-0000-4000-8000-000000000001',
} as const;

interface SelectionFixture {
  readonly selection: string;
  readonly periodEnd: string;
  readonly release: string;
  readonly previous: string | null;
  readonly reason: string;
}

const CHAIN_REASON =
  'Monthly MFin job: unique complete report set; exact source replay and output audit.';

export const SELECTION_ROWS: readonly SelectionFixture[] = [
  {
    selection: SELECTIONS.june2006,
    periodEnd: '2006-06-30',
    release: RELEASES.june2006,
    previous: null,
    reason: CHAIN_REASON,
  },
  {
    selection: SELECTIONS.july2006,
    periodEnd: '2006-07-31',
    release: RELEASES.july2006,
    previous: null,
    reason:
      'Historical MFin current-BGC release from the reviewed cohort: exact source replay and output audit.',
  },
  {
    selection: SELECTIONS.march2025,
    periodEnd: '2025-03-31',
    release: RELEASES.march2025,
    previous: null,
    reason: CHAIN_REASON,
  },
  {
    selection: SELECTIONS.april2025,
    periodEnd: '2025-04-30',
    release: RELEASES.april2025,
    previous: null,
    reason: CHAIN_REASON,
  },
  {
    selection: SELECTIONS.june2025Root,
    periodEnd: '2025-06-30',
    release: RELEASES.june2025R1,
    previous: null,
    reason: CHAIN_REASON,
  },
  {
    selection: SELECTIONS.june2025Rollforward,
    periodEnd: '2025-06-30',
    release: RELEASES.june2025R2,
    previous: SELECTIONS.june2025Root,
    reason: CHAIN_REASON,
  },
  {
    selection: SELECTIONS.june2025,
    periodEnd: '2025-06-30',
    release: RELEASES.june2025R1,
    previous: SELECTIONS.june2025Rollforward,
    reason: CHAIN_REASON,
  },
  {
    selection: SELECTIONS.september2025,
    periodEnd: '2025-09-30',
    release: RELEASES.september2025,
    previous: null,
    reason: CHAIN_REASON,
  },
  {
    selection: SELECTIONS.november2025,
    periodEnd: '2025-11-30',
    release: RELEASES.november2025,
    previous: null,
    reason: CHAIN_REASON,
  },
  {
    selection: SELECTIONS.december2025,
    periodEnd: '2025-12-31',
    release: RELEASES.december2025,
    previous: null,
    reason: 'User-authorized initial national budget source load; faithful-source-observations-v1',
  },
  {
    selection: SELECTIONS.july2026,
    periodEnd: '2026-07-31',
    release: RELEASES.july2026,
    previous: null,
    reason: CHAIN_REASON,
  },
];

const isLeaf = (row: SelectionFixture): boolean =>
  !SELECTION_ROWS.some((other) => other.previous === row.selection);

/** P0 family example inputs (December 2025, modern policy, no contract). */
const DECEMBER_INPUTS = [
  {
    inputId: 'bgc',
    sourceUrl: 'https://mfinante.gov.ro/static/10/Mfp/buletin/executii/bgc31122025.xlsx',
    sha256: '41f67ec6394f9cf69964a88e58a6dbf34ac4916e57ea26715c0e36574b117c5e',
    bytes: '377294',
  },
  {
    inputId: 'nota',
    sourceUrl: 'https://mfinante.gov.ro/static/10/Mfp/buletin/executii/nota_bgc31122025.pdf',
    sha256: '0b348a419266435603f2c330bc56c22c5b22058d6f7de9caa2252ead1514b682',
    bytes: '345035',
  },
  {
    inputId: 'sinteza',
    sourceUrl: 'https://mfinante.gov.ro/static/10/Mfp/buletin/executii/Anexa2_bgc31122025.xlsx',
    sha256: 'c832fdbac76a7b117717ccbbc665e73d51af1917280acaf7d8ff16ebfa0f004a',
    bytes: '367020',
  },
];

/** P0 historical family contract (July 2006), projected paths only. */
const JULY_2006_FAMILIES = [
  {
    family: 'bgc',
    presence: 'present',
    role: 'normalization_source',
    reason: null,
    sourceUrl: 'https://mfinante.gov.ro/static/10/Mfp/buget/executii/rom07_2006.zip',
    sourceFormat: 'pdf',
    originalSha256: '6b43c4d8baf3ddabfb48bf16768204a245c3e8938f5259b4656658a001a46d31',
    reportStart: '2006-01-01',
    reportEnd: '2006-07-30',
  },
  {
    family: 'nota',
    presence: 'family_unresolved',
    role: null,
    reason: 'none_identified_in_this_packet',
    sourceUrl: null,
    sourceFormat: null,
    originalSha256: null,
    reportStart: null,
    reportEnd: null,
  },
  {
    family: 'sinteza',
    presence: 'family_unresolved',
    role: null,
    reason: 'possible_family_content_identified',
    sourceUrl: null,
    sourceFormat: null,
    originalSha256: null,
    reportStart: null,
    reportEnd: null,
  },
];
const JULY_2006_INPUTS = [
  {
    inputId: 'bgc',
    sourceUrl: 'https://mfinante.gov.ro/static/10/Mfp/buget/executii/rom07_2006.zip',
    sha256: '6b43c4d8baf3ddabfb48bf16768204a245c3e8938f5259b4656658a001a46d31',
    bytes: '106523',
  },
];

const syntheticInputs = (release: string) => [
  {
    inputId: 'bgc',
    sourceUrl: `https://example.invalid/${release}/bgc.xlsx`,
    sha256: SHA('c'),
    bytes: '1000',
  },
  {
    inputId: 'nota',
    sourceUrl: `https://example.invalid/${release}/nota.pdf`,
    sha256: SHA('d'),
    bytes: '1000',
  },
  {
    inputId: 'sinteza',
    sourceUrl: `https://example.invalid/${release}/sinteza.xlsx`,
    sha256: SHA('e'),
    bytes: '1000',
  },
];

const releaseColumns = (release: string, periodEnd: string): Record<string, unknown> => {
  const year = periodEnd.slice(0, 4);
  if (release === RELEASES.july2006) {
    return {
      release_start: `${year}-01-01`,
      release_end: periodEnd,
      policy_version: 'historical-bgc-current-v1',
      publication_scope: 'historical-bgc-current-v1',
      has_contract: true,
      contract_families: JULY_2006_FAMILIES,
      inputs: JULY_2006_INPUTS,
      fact_count: 240,
    };
  }
  return {
    release_start: `${year}-01-01`,
    release_end: periodEnd,
    policy_version: 'faithful-source-observations-v1',
    publication_scope: null,
    has_contract: false,
    contract_families: [],
    inputs: release === RELEASES.december2025 ? DECEMBER_INPUTS : syntheticInputs(release),
    fact_count: 1500,
  };
};

const chainRows = (periodEnds: readonly string[], revisions: number): Record<string, unknown>[] => {
  const rows: Record<string, unknown>[] = [];
  for (const end of periodEnds) {
    const leaf = SELECTION_ROWS.find((row) => row.periodEnd === end && isLeaf(row));
    if (leaf === undefined) continue;
    const chain: SelectionFixture[] = [];
    let cursor: SelectionFixture | undefined = leaf;
    while (cursor !== undefined) {
      chain.push(cursor);
      const previous: string | null = cursor.previous;
      cursor =
        previous === null ? undefined : SELECTION_ROWS.find((row) => row.selection === previous);
    }
    chain.forEach((row, index) => {
      if (index + 1 > revisions) return;
      rows.push({
        period_end: row.periodEnd,
        selection_id: row.selection,
        previous_selection_id: row.previous,
        release_id: row.release,
        reason: row.reason,
        seal_sha256: SHA('f'),
        depth: index + 1,
        chain_length: chain.length,
        overflow: false,
        ...releaseColumns(row.release, row.periodEnd),
      });
    });
  }
  return rows;
};

// ── execution observations (December 2025 cells: P0 modern samples) ──────────

const BASE_OBSERVATION = {
  comparison_start: null,
  comparison_end: null,
  reason: null,
  locator_page: null,
  // Workbook cells have no table/row/column coordinates (absent → null).
  locator_table: null,
  locator_row: null,
  locator_column: null,
};

const item = (itemId: string | null) => {
  const found = CATALOG_ITEMS.find((entry) => entry.item_id === itemId);
  return found === undefined
    ? {
        item_mapping_version: null,
        item_id: null,
        item_section: null,
        item_source_label: null,
        item_related_scope_item_id: null,
      }
    : {
        item_mapping_version: found.mapping_version,
        item_id: found.item_id,
        item_section: found.section,
        item_source_label: found.source_label,
        item_related_scope_item_id: found.related_scope_item_id,
      };
};

const decemberDocument = (input: 'bgc' | 'sinteza') => {
  const found = DECEMBER_INPUTS.find((entry) => entry.inputId === input);
  return {
    source_url: found?.sourceUrl,
    original_sha256: found?.sha256,
    original_bytes: found?.bytes,
  };
};

const evidence = (sheetCell: string, labelCell: string, label: string) => ({
  locator_kind: 'cell',
  locator_sheet: 'xl/worksheets/sheet1.xml',
  locator_cell: sheetCell,
  label_sheet: 'xl/worksheets/sheet1.xml',
  label_cell: labelCell,
  label_text: label,
});

/** December 2025 single-selection rows, in occurrence order. */
export const DECEMBER_OBSERVATIONS: readonly Record<string, unknown>[] = [
  // SYNTHETIC key; P0 value: BGC national revenue total, Dec 2025 YTD = full year.
  {
    ...BASE_OBSERVATION,
    observation_key: 'xl/worksheets/sheet1.xml!C12',
    input_id: 'bgc',
    disposition: 'fact',
    section: 'revenue',
    line_item: 'venituri totale',
    component: 'general_consolidated_budget',
    period_role: 'current',
    measure: 'amount',
    coverage_kind: 'report_period',
    fiscal_start: '2025-01-01',
    fiscal_end: '2025-12-31',
    report_start: '2025-01-01',
    report_end: '2025-12-31',
    reference_year: '2025',
    execution_status: 'actual',
    finality: 'unknown',
    source_token: '662698.17310134997',
    value_text: '662698173101.34997',
    unit: 'RON',
    source_state: 'number',
    ...evidence('C12', 'B12', 'VENITURI TOTALE'),
    ...decemberDocument('bgc'),
    ...item('mfin.bgc.revenue.total'),
  },
  // P0 R67: classified BLANK (national loans), never a zero.
  {
    ...BASE_OBSERVATION,
    observation_key: 'xl/worksheets/sheet1.xml!R67',
    input_id: 'bgc',
    disposition: 'blank',
    section: 'expenditure',
    line_item: 'imprumuturi',
    component: 'general_consolidated_budget',
    period_role: 'current',
    measure: 'amount',
    coverage_kind: 'report_period',
    fiscal_start: '2025-01-01',
    fiscal_end: '2025-12-31',
    report_start: null,
    report_end: null,
    reference_year: '2025',
    execution_status: 'actual',
    finality: 'unknown',
    source_token: null,
    value_text: null,
    unit: 'RON',
    source_state: 'blank',
    ...evidence('R67', 'B67', 'Imprumuturi'),
    ...decemberDocument('bgc'),
    ...item('mfin.bgc.expenditure.loans'),
  },
  // P0 R68: printed RON zero.
  {
    ...BASE_OBSERVATION,
    observation_key: 'xl/worksheets/sheet1.xml!R68',
    input_id: 'bgc',
    disposition: 'fact',
    section: 'expenditure',
    line_item: 'rambursari de credite',
    component: 'general_consolidated_budget',
    period_role: 'current',
    measure: 'amount',
    coverage_kind: 'report_period',
    fiscal_start: '2025-01-01',
    fiscal_end: '2025-12-31',
    report_start: '2025-01-01',
    report_end: '2025-12-31',
    reference_year: '2025',
    execution_status: 'actual',
    finality: 'unknown',
    source_token: '0',
    value_text: '0',
    unit: 'RON',
    source_state: 'number',
    ...evidence('R68', 'B68', 'Rambursari de credite'),
    ...decemberDocument('bgc'),
    ...item('mfin.bgc.expenditure.loan_repayments'),
  },
  // P0 S67: printed fraction zero (GDP share), never mapped to an amount item.
  {
    ...BASE_OBSERVATION,
    observation_key: 'xl/worksheets/sheet1.xml!S67',
    input_id: 'bgc',
    disposition: 'fact',
    section: 'expenditure',
    line_item: 'imprumuturi',
    component: 'general_consolidated_budget',
    period_role: 'current',
    measure: 'gdp_share',
    coverage_kind: 'report_period',
    fiscal_start: '2025-01-01',
    fiscal_end: '2025-12-31',
    report_start: '2025-01-01',
    report_end: '2025-12-31',
    reference_year: '2025',
    execution_status: 'actual',
    finality: 'unknown',
    source_token: '0',
    value_text: '0',
    unit: 'fraction',
    source_state: 'number',
    ...evidence('S67', 'B67', 'Imprumuturi'),
    ...decemberDocument('bgc'),
    ...item(null),
  },
  // P0 modern stratum: Sinteza's same headline (operative) — never a BGC catalog item.
  {
    ...BASE_OBSERVATION,
    observation_key: 'xl/worksheets/sheet1.xml!B12',
    input_id: 'sinteza',
    disposition: 'fact',
    section: 'revenue',
    line_item: 'venituri totale',
    component: 'general_consolidated_budget',
    period_role: 'current',
    measure: 'amount',
    coverage_kind: 'report_period',
    fiscal_start: '2025-01-01',
    fiscal_end: '2025-12-31',
    report_start: '2025-01-01',
    report_end: '2025-12-31',
    reference_year: '2025',
    execution_status: 'actual',
    finality: 'operative',
    source_token: '662698.17310134997',
    value_text: '662698173101.34997',
    unit: 'RON',
    source_state: 'number',
    ...evidence('B12', 'A12', 'Venituri totale'),
    ...decemberDocument('sinteza'),
    ...item(null),
  },
];

/** Equal-key observations across the June rollback chain (R1 → R2 → R1). */
const juneObservation = (selection: string, release: string) => ({
  ...BASE_OBSERVATION,
  observation_key: 'xl/worksheets/sheet1.xml!C12',
  input_id: 'bgc',
  disposition: 'fact',
  section: 'revenue',
  line_item: 'venituri totale',
  component: 'general_consolidated_budget',
  period_role: 'current',
  measure: 'amount',
  coverage_kind: 'report_period',
  fiscal_start: '2025-01-01',
  fiscal_end: '2025-06-30',
  report_start: '2025-01-01',
  report_end: '2025-06-30',
  reference_year: '2025',
  execution_status: 'actual',
  finality: 'unknown',
  source_token: '310520.63993872993',
  value_text: '310520639938.72993',
  unit: 'RON',
  source_state: 'number',
  locator_kind: null,
  locator_sheet: null,
  locator_cell: null,
  label_sheet: null,
  label_cell: null,
  label_text: null,
  locator_table: null,
  locator_row: null,
  locator_column: null,
  source_url: `https://example.invalid/${release}/bgc.xlsx`,
  original_sha256: SHA('c'),
  original_bytes: '1000',
  release_id: release,
  selection_id: selection,
  period_end: '2025-06-30',
  ...item('mfin.bgc.revenue.total'),
});

/**
 * July 2006 single-selection cells: P0 `sampleClassifiedCells` (historical PDF
 * coordinates, dispositions, classifications). The national:0001 amount is the
 * packet's printed BGC revenue 59990.9 million lei (P0 family contract value
 * corroboration), normalised to RON.
 */
const july2006Document = {
  source_url: 'https://mfinante.gov.ro/static/10/Mfp/buget/executii/rom07_2006.zip',
  original_sha256: '6b43c4d8baf3ddabfb48bf16768204a245c3e8938f5259b4656658a001a46d31',
  original_bytes: '106523',
};

const pdfCell = (row: number, page: number) => ({
  locator_kind: 'pdf_cell',
  locator_sheet: null,
  locator_cell: null,
  locator_page: String(page),
  locator_table: 'bgc_national_current_amount',
  locator_row: String(row),
  locator_column: '0',
  label_sheet: null,
  label_cell: null,
  label_text: null,
});

const julyCell = {
  comparison_start: null,
  comparison_end: null,
  reason: null,
  component: 'general_consolidated_budget',
  period_role: 'current',
  measure: 'amount',
  coverage_kind: 'report_period',
  fiscal_start: '2006-01-01',
  fiscal_end: '2006-07-30',
  reference_year: null,
  execution_status: 'actual',
  finality: 'unknown',
  ...july2006Document,
  release_id: RELEASES.july2006,
  selection_id: SELECTIONS.july2006,
  period_end: '2006-07-31',
};

export const JULY_2006_OBSERVATIONS: readonly Record<string, unknown>[] = [
  {
    ...julyCell,
    observation_key: 'national:0001',
    input_id: 'bgc',
    disposition: 'fact',
    section: 'revenue',
    line_item: 'venituri totale',
    report_start: '2006-01-01',
    report_end: '2006-07-30',
    source_token: '59990.9',
    value_text: '59990900000',
    unit: 'RON',
    source_state: 'number',
    ...pdfCell(1, 1),
    ...item('mfin.bgc.revenue.total'),
  },
  {
    ...julyCell,
    observation_key: 'national:0018',
    input_id: 'bgc',
    disposition: 'blank',
    section: 'revenue',
    line_item: 'subventii',
    report_start: null,
    report_end: null,
    source_token: null,
    value_text: null,
    unit: 'RON',
    source_state: 'blank',
    ...pdfCell(18, 1),
    ...item('mfin.bgc.revenue.subsidies'),
  },
  {
    ...julyCell,
    observation_key: 'national:0036',
    input_id: 'bgc',
    disposition: 'blank',
    section: 'expenditure',
    line_item: 'rambursari de credite',
    report_start: null,
    report_end: null,
    source_token: null,
    value_text: null,
    unit: 'RON',
    source_state: 'blank',
    ...pdfCell(36, 2),
    ...item('mfin.bgc.expenditure.loan_repayments'),
  },
];

const observationRows = (): Record<string, unknown>[] => [
  ...JULY_2006_OBSERVATIONS,
  ...DECEMBER_OBSERVATIONS.map((row) => ({
    ...row,
    release_id: RELEASES.december2025,
    selection_id: SELECTIONS.december2025,
    period_end: '2025-12-31',
  })),
  juneObservation(SELECTIONS.june2025Root, RELEASES.june2025R1),
  juneObservation(SELECTIONS.june2025Rollforward, RELEASES.june2025R2),
  juneObservation(SELECTIONS.june2025, RELEASES.june2025R1),
];

// ── national series view rows (P0 series edges + SYNTHETIC expenditure) ──────

const labelEvidence = { sheet: 'xl/worksheets/sheet1.xml', cell: 'B12', text: 'VENITURI TOTALE' };

interface OperandFixture {
  readonly selection: string | null;
  readonly release: string | null;
  readonly key: string | null;
  readonly state: string | null;
  readonly start: string | null;
  readonly end: string | null;
  readonly finality?: string;
  readonly url?: string | null;
  readonly sha?: string | null;
  readonly bytes?: string | null;
}

const operand = (
  side: 'endpoint' | 'predecessor',
  values: OperandFixture | null
): Record<string, unknown> => {
  const present = values?.key != null;
  const released = values?.release != null;
  return {
    [`${side}_selection_id`]: values?.selection ?? null,
    [`${side}_release_id`]: values?.release ?? null,
    [`${side}_observation_key`]: values?.key ?? null,
    [`${side}_source_url`]:
      values?.url ??
      (released ? `https://example.invalid/${values?.release ?? ''}/bgc.xlsx` : null),
    [`${side}_source_state`]: values?.state ?? null,
    [`${side}_coverage_start`]: values?.start ?? null,
    [`${side}_coverage_end`]: values?.end ?? null,
    [`${side}_execution_status`]: present ? 'actual' : null,
    [`${side}_finality`]: present ? (values?.finality ?? 'unknown') : null,
    [`${side}_label`]: present ? labelEvidence : null,
    [`${side}_headers`]: present ? [labelEvidence] : null,
    [`${side}_sha256`]: values?.sha ?? (released ? SHA('c') : null),
    [`${side}_bytes`]: values?.bytes ?? (released ? '1000' : null),
  };
};

const seriesRow = (row: {
  item: string;
  basis: string;
  start: string;
  end: string;
  predecessorEnd: string | null;
  value: string | null;
  reason: string;
  valueBasis: string;
  endpoint: OperandFixture | null;
  predecessor: OperandFixture | null;
}): Record<string, unknown> => ({
  item_id: row.item,
  period_basis: row.basis,
  period_start: row.start,
  period_end: row.end,
  predecessor_end: row.predecessorEnd,
  value_ron: row.value,
  availability_reason: row.reason,
  value_basis: row.valueBasis,
  derivation_version: 'bgc-selected-cumulative-difference-v1',
  component: 'general_consolidated_budget',
  ...operand('endpoint', row.endpoint),
  ...operand('predecessor', row.predecessor),
});

const KEY = 'xl/worksheets/sheet1.xml!C12';
const june = {
  selection: SELECTIONS.june2025,
  release: RELEASES.june2025R1,
  key: KEY,
  state: 'number',
  start: '2025-01-01',
  end: '2025-06-30',
};
const march = {
  selection: SELECTIONS.march2025,
  release: RELEASES.march2025,
  key: KEY,
  state: 'number',
  start: '2025-01-01',
  end: '2025-03-31',
};
const december = {
  selection: SELECTIONS.december2025,
  release: RELEASES.december2025,
  key: KEY,
  state: 'number',
  start: '2025-01-01',
  end: '2025-12-31',
  url: DECEMBER_INPUTS[0]?.sourceUrl ?? null,
  sha: DECEMBER_INPUTS[0]?.sha256 ?? null,
  bytes: DECEMBER_INPUTS[0]?.bytes ?? null,
};

export const SERIES_ROWS: readonly Record<string, unknown>[] = [
  // P0 edges, mfin.bgc.revenue.total.
  seriesRow({
    item: 'mfin.bgc.revenue.total',
    basis: 'month',
    start: '2025-05-01',
    end: '2025-05-31',
    predecessorEnd: '2025-04-30',
    value: null,
    reason: 'missing_endpoint_release',
    valueBasis: 'derived_change_between_selected_reports',
    endpoint: { selection: null, release: null, key: null, state: null, start: null, end: null },
    predecessor: {
      selection: SELECTIONS.april2025,
      release: RELEASES.april2025,
      key: KEY,
      state: 'number',
      start: '2025-01-01',
      end: '2025-04-30',
    },
  }),
  seriesRow({
    item: 'mfin.bgc.revenue.total',
    basis: 'ytd',
    start: '2025-01-01',
    end: '2025-05-31',
    predecessorEnd: null,
    value: null,
    reason: 'missing_endpoint_release',
    valueBasis: 'reported_cumulative',
    endpoint: { selection: null, release: null, key: null, state: null, start: null, end: null },
    predecessor: null,
  }),
  seriesRow({
    item: 'mfin.bgc.revenue.total',
    basis: 'month',
    start: '2025-06-01',
    end: '2025-06-30',
    predecessorEnd: '2025-05-31',
    value: null,
    reason: 'missing_predecessor_release',
    valueBasis: 'derived_change_between_selected_reports',
    endpoint: june,
    predecessor: { selection: null, release: null, key: null, state: null, start: null, end: null },
  }),
  seriesRow({
    item: 'mfin.bgc.revenue.total',
    basis: 'quarter',
    start: '2025-04-01',
    end: '2025-06-30',
    predecessorEnd: '2025-03-31',
    value: '169195939317.60994',
    reason: 'available',
    valueBasis: 'derived_change_between_selected_reports',
    endpoint: june,
    predecessor: march,
  }),
  seriesRow({
    item: 'mfin.bgc.revenue.total',
    basis: 'ytd',
    start: '2025-01-01',
    end: '2025-06-30',
    predecessorEnd: null,
    value: '310520639938.72993',
    reason: 'available',
    valueBasis: 'reported_cumulative',
    endpoint: june,
    predecessor: null,
  }),
  seriesRow({
    item: 'mfin.bgc.revenue.total',
    basis: 'full_year',
    start: '2025-01-01',
    end: '2025-12-31',
    predecessorEnd: null,
    value: '662698173101.34997',
    reason: 'available',
    valueBasis: 'reported_cumulative',
    endpoint: december,
    predecessor: null,
  }),
  seriesRow({
    item: 'mfin.bgc.revenue.total',
    basis: 'month',
    start: '2025-12-01',
    end: '2025-12-31',
    predecessorEnd: '2025-11-30',
    value: '70789094792.50003',
    reason: 'available',
    valueBasis: 'derived_change_between_selected_reports',
    endpoint: december,
    predecessor: {
      selection: SELECTIONS.november2025,
      release: RELEASES.november2025,
      key: KEY,
      state: 'number',
      start: '2025-01-01',
      end: '2025-11-30',
    },
  }),
  seriesRow({
    item: 'mfin.bgc.revenue.total',
    basis: 'quarter',
    start: '2025-10-01',
    end: '2025-12-31',
    predecessorEnd: '2025-09-30',
    value: '195746159574.50995',
    reason: 'available',
    valueBasis: 'derived_change_between_selected_reports',
    endpoint: december,
    predecessor: {
      selection: SELECTIONS.september2025,
      release: RELEASES.september2025,
      key: KEY,
      state: 'number',
      start: '2025-01-01',
      end: '2025-09-30',
    },
  }),
  seriesRow({
    item: 'mfin.bgc.revenue.total',
    basis: 'month',
    start: '2006-07-01',
    end: '2006-07-31',
    predecessorEnd: '2006-06-30',
    value: null,
    reason: 'incompatible_endpoint_coverage',
    valueBasis: 'derived_change_between_selected_reports',
    endpoint: {
      selection: SELECTIONS.july2006,
      release: RELEASES.july2006,
      key: 'p1!t1!r1!c3',
      state: 'number',
      start: '2006-01-01',
      end: '2006-07-30',
      url: JULY_2006_INPUTS[0]?.sourceUrl ?? null,
      sha: JULY_2006_INPUTS[0]?.sha256 ?? null,
      bytes: JULY_2006_INPUTS[0]?.bytes ?? null,
    },
    predecessor: {
      selection: SELECTIONS.june2006,
      release: RELEASES.june2006,
      key: 'p1!t1!r1!c3',
      state: 'number',
      start: '2006-01-01',
      end: '2006-06-30',
    },
  }),
  // SYNTHETIC expenditure total, only for the requested-order test.
  seriesRow({
    item: 'mfin.bgc.expenditure.total',
    basis: 'quarter',
    start: '2025-04-01',
    end: '2025-06-30',
    predecessorEnd: '2025-03-31',
    value: '-12.5',
    reason: 'available',
    valueBasis: 'derived_change_between_selected_reports',
    endpoint: june,
    predecessor: march,
  }),
];

// ── the responder ────────────────────────────────────────────────────────────

const tagOf = (sql: string): string | null =>
  /\/\* budget\.national:([a-z_]+) \*\//u.exec(sql)?.[1] ?? null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const compare = (a: string, b: string): number => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return Buffer.compare(left, right);
};

const occurrenceOrder = (a: Record<string, unknown>, b: Record<string, unknown>): number => {
  for (const key of ['period_end', 'selection_id', 'input_id', 'observation_key']) {
    const order = compare(String(a[key]), String(b[key]));
    if (order !== 0) return order;
  }
  return 0;
};

export interface SourceWorldOptions {
  /** Extra inventory form rows (e.g. a conflicting second interpretation). */
  readonly extraFormRows?: readonly Record<string, unknown>[];
  /** Replace the current leaves (e.g. to move the execution lane). */
  readonly leaves?: () => readonly SelectionFixture[];
}

export const makeSourceWorld = (options: SourceWorldOptions = {}) => {
  const leaves = () => options.leaves?.() ?? SELECTION_ROWS.filter(isLeaf);
  const respond = (sql: string, parameters: readonly unknown[]): readonly unknown[] => {
    switch (tagOf(sql)) {
      // The read port's setup: no inherited transaction_timeout (kernel pool default).
      case 'inherited_transaction_timeout':
        return [{ setting: '0', unit: 'ms' }];
      case 'approved_inventory_slots':
        return inventorySlotRows();
      case 'approved_inventory_forms':
        return inventoryFormRows(options.extraFormRows);
      case 'approved_descriptor_candidates': {
        // eslint-disable-next-line no-restricted-syntax -- test fixture reads the JSON parameter the repo under test built
        const groups = JSON.parse(String(parameters[0])) as {
          group_key: string;
          budget_year: number;
          publication: string;
          form: string;
          capitol: string;
          row_role: string;
          credit_type: string | null;
          authority_code: string | null;
        }[];
        return groups.flatMap((group) =>
          CANDIDATES.filter((candidate) => {
            const rule = RULE_OF[candidate.total];
            return (
              rule !== undefined &&
              candidate.year === group.budget_year &&
              publication(candidate.year) === group.publication &&
              candidate.form === group.form &&
              rule.capitol === group.capitol &&
              rule.role === group.row_role &&
              candidate.creditType === group.credit_type &&
              (group.authority_code === null || candidate.authorityCode === group.authority_code)
            );
          }).flatMap((candidate) =>
            candidateLines(candidate).map((line) => ({ group_key: group.group_key, ...line }))
          )
        );
      }
      case 'approved_records_page': {
        const ids = isStringArray(parameters[0]) ? parameters[0] : [];
        const limit = Number(parameters.at(-1));
        const after = sql.includes('l.record_index >')
          ? { interpretation: String(parameters.at(-4)), index: Number(parameters.at(-2)) }
          : null;
        const authority = sql.includes('l.authority_code = $') ? String(parameters[1]) : null;
        const lines = authorityRecordLines().filter((line) =>
          ids.includes(String(line['interpretation_id']))
        );
        const records = [...new Set(lines.map((line) => Number(line['record_index'])))]
          .sort((a, b) => a - b)
          .filter((index) => after === null || index > after.index)
          .filter(
            (index) =>
              authority === null ||
              lines.some(
                (line) => line['record_index'] === index && line['authority_code'] === authority
              )
          )
          .slice(0, limit);
        return lines.filter((line) => records.includes(Number(line['record_index'])));
      }
      case 'execution_current_leaves':
        return leaves().map((row) => ({
          selection_id: row.selection,
          period_end: row.periodEnd,
          release_id: row.release,
        }));
      case 'execution_catalog_items':
        return [...CATALOG_ITEMS].sort((a, b) => compare(a.item_id, b.item_id));
      case 'execution_selections': {
        const ids = isStringArray(parameters[0]) ? parameters[0] : [];
        return SELECTION_ROWS.filter((row) => ids.includes(row.selection)).map((row) => ({
          selection_id: row.selection,
          period_end: row.periodEnd,
          release_id: row.release,
        }));
      }
      case 'execution_release_chains': {
        const ends = isStringArray(parameters[0]) ? parameters[0] : [];
        return chainRows(ends, Number(parameters.at(-1)));
      }
      case 'execution_observations_page': {
        const selectionIds = isStringArray(parameters[0]) ? parameters[0] : [];
        const single = sql.includes('obs as (');
        const inputs = parameters.find(
          (value): value is string[] =>
            isStringArray(value) &&
            value.length > 0 &&
            value.every((v) => v === 'bgc' || v === 'sinteza')
        ) ?? ['bgc', 'sinteza'];
        const nonFacts = sql.includes("o.obj->>'disposition' = any(")
          ? (parameters.find(
              (value): value is string[] =>
                isStringArray(value) &&
                value.length > 0 &&
                value.every((v) => ['blank', 'unresolved', 'nonfinancial'].includes(v))
            ) ?? [])
          : [];
        const wantsFacts = sql.includes('budget.execution_release_facts f on');
        const items = sql.includes('ci.item_id = any(')
          ? (parameters.find(
              (value): value is string[] =>
                isStringArray(value) && value.every((v) => v.startsWith('mfin.'))
            ) ?? [])
          : null;
        const limit = Number(parameters.at(-1));
        const after = sql.includes('u.period_end >')
          ? {
              period_end: String(parameters.at(-8)),
              selection_id: String(parameters.at(-6)),
              input_id: String(parameters.at(-4)),
              observation_key: String(parameters.at(-2)),
            }
          : null;
        return observationRows()
          .filter((row) => selectionIds.includes(String(row['selection_id'])))
          .filter((row) => inputs.includes(String(row['input_id'])))
          .filter((row) =>
            row['disposition'] === 'fact'
              ? wantsFacts
              : nonFacts.includes(String(row['disposition']))
          )
          .filter((row) => items === null || items.includes(String(row['item_id'])))
          .map((row) =>
            single || row['disposition'] !== 'fact'
              ? row
              : {
                  ...row,
                  source_state: 'number',
                  reason: null,
                  locator_kind: null,
                  locator_sheet: null,
                  locator_cell: null,
                  locator_page: null,
                  locator_table: null,
                  locator_row: null,
                  locator_column: null,
                  label_sheet: null,
                  label_cell: null,
                  label_text: null,
                }
          )
          .sort(occurrenceOrder)
          .filter((row) => after === null || occurrenceOrder(row, after) > 0)
          .slice(0, limit);
      }
      case 'execution_national_series': {
        const items = isStringArray(parameters[0]) ? parameters[0] : [];
        const basis = String(parameters[1]);
        const ends = isStringArray(parameters[2]) ? parameters[2] : [];
        return SERIES_ROWS.filter(
          (row) =>
            items.includes(String(row['item_id'])) &&
            row['period_basis'] === basis &&
            ends.includes(String(row['period_end']))
        );
      }
      default:
        return [];
    }
  };
  return { respond };
};
