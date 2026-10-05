/**
 * National budget — law lane reader over `budget.approved_budget_lines`.
 *
 * Three statements, all fully qualified and parameterised:
 *
 * - inventory: two grouped scans (slots; forms with interpretations, sources
 *   and authorities) — the lane token, catalog and planning inputs;
 * - descriptor candidates: ONE statement for every requested group (rules come
 *   from the core descriptor registry); candidate records are chosen first,
 *   then joined back by primary key so ALL their stored slots are returned;
 * - records page: source-order keyset `(interpretation_id COLLATE "C",
 *   record_index)` over the resolved interpretations, then every slot of the
 *   paged records.
 *
 * Amounts leave SQL as `amount::text` and are parsed by the core exact parser;
 * the native `thousand_lei` unit is never converted here. Storage columns
 * (`object_key`, `object_version_id`, `run_id`, `loaded_at`) are never read.
 */

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sql } from 'kysely';

import {
  guardedRead,
  NationalSourceContractError,
  type NationalRun,
} from './national-read-port.js';
import { descriptorGroupKey, type DescriptorGroup } from '../../core/national/approved-plan.js';
import { TOTAL_DEFINITIONS } from '../../core/national/descriptors.js';
import { editionIdValue } from '../../core/national/input-rules.js';
import { parseSourceDecimal } from '../../core/national/values.js';
import {
  AUTHORITY_DETAIL_FORM,
  FORM_FUND,
  REVENUE_HOLDER_AUTHORITY_CODE,
  type ApprovedForm,
  type ApprovedMeasure,
  type BudgetFund,
  type CreditType,
  type RowRole,
} from '../../core/national/vocabulary.js';

import type { ApprovedRecordsQuery } from '../../core/national/approved-inputs.js';
import type {
  ApprovedAuthority,
  ApprovedCatalogEdition,
  ApprovedFormSummary,
  ApprovedSlot,
  ApprovedStoredRecord,
  ApprovedStoredSlot,
  ApprovedUnrecognizedGroup,
  EditionRef,
} from '../../core/national/models.js';
import type {
  ApprovedInventory,
  ApprovedRecordsPageRequest,
  NationalApprovedReader,
} from '../../core/national/ports.js';
import type { ApprovedInventoryKey } from '../../core/national/snapshot.js';

// ── reviewed source vocabulary (stored literal ↔ public enum) ────────────────

export const FUND_LITERAL: Readonly<Record<BudgetFund, string>> = {
  STATE_BUDGET: 'state_budget',
  STATE_SOCIAL_INSURANCE: 'state_social_insurance',
  HEALTH_INSURANCE: 'health_insurance',
  UNEMPLOYMENT_INSURANCE: 'unemployment_insurance',
};

export const FORM_LITERAL: Readonly<Record<ApprovedForm, string>> = {
  STATE_BUDGET_SYNTHESIS: 'state_budget_synthesis',
  STATE_BUDGET_AUTHORITY_DETAIL: 'state_budget_authority_detail',
  STATE_SOCIAL_INSURANCE_SYNTHESIS: 'state_social_insurance_synthesis',
  HEALTH_INSURANCE_SYNTHESIS: 'health_insurance_synthesis',
  UNEMPLOYMENT_INSURANCE_SYNTHESIS: 'unemployment_insurance_synthesis',
};

const MEASURE_LITERAL: Readonly<Record<ApprovedMeasure, string>> = {
  APPROVED: 'approved',
  FORECAST: 'forecast',
};

export const CREDIT_LITERAL: Readonly<Record<CreditType, string>> = {
  BUDGET_CREDITS: 'budget_credits',
  COMMITMENT_CREDITS: 'commitment_credits',
};

export const ROW_ROLE_LITERAL: Readonly<Record<RowRole, string>> = {
  DESCRIPTOR: 'descriptor',
  CREDIT: 'credit',
};

const reverse = <T extends string>(map: Readonly<Record<T, string>>): ReadonlyMap<string, T> =>
  new Map((Object.keys(map) as T[]).map((key) => [map[key], key]));

const FUNDS = reverse(FUND_LITERAL);
const FORMS = reverse(FORM_LITERAL);
const MEASURES = reverse(MEASURE_LITERAL);
const CREDITS = reverse(CREDIT_LITERAL);
const ROW_ROLES = reverse(ROW_ROLE_LITERAL);

const known = <T>(map: ReadonlyMap<string, T>, value: string, what: string): T => {
  const mapped = map.get(value);
  if (mapped === undefined) throw new NationalSourceContractError(`unknown ${what} '${value}'`);
  return mapped;
};

const editionOf = (budgetYear: number, publication: string): EditionRef => ({
  id: `${String(budgetYear)}:${publication}`,
  budgetYear,
  publication,
});

/** Our own edition ID format, parsed back for the descriptor statement. */
const splitEditionId = (editionId: string): { budgetYear: number; publication: string } => {
  const separator = editionId.indexOf(':');
  const budgetYear = Number.parseInt(editionId.slice(0, separator), 10);
  if (separator < 0 || !Number.isInteger(budgetYear)) {
    throw new NationalSourceContractError(`malformed edition id '${editionId}'`);
  }
  return { budgetYear, publication: editionId.slice(separator + 1) };
};

// ── inventory ────────────────────────────────────────────────────────────────

interface SlotRow {
  budget_year: number;
  publication: string;
  fund: string;
  form: string;
  interpretation_id: string;
  field: string;
  measure: string;
  measure_year: number;
  line_count: number;
}

interface FormRow {
  budget_year: number;
  publication: string;
  fund: string;
  form: string;
  interpretation_id: string;
  line_count: number;
  record_count: number;
  credit_types: string[];
  sources: unknown;
  authorities: unknown;
}

const SourcesSchema = Type.Array(
  Type.Object(
    { sourceFileId: Type.String(), sha256: Type.String() },
    { additionalProperties: false }
  )
);
const AuthoritiesSchema = Type.Array(Type.Tuple([Type.String(), Type.String()]));

const inventorySlotsSql = sql<SlotRow>`
  /* budget.national:approved_inventory_slots */
  select l.budget_year, l.publication, l.fund, l.form, l.interpretation_id,
    l.field, l.measure, l.measure_year, count(*)::int as line_count
  from budget.approved_budget_lines l
  group by l.budget_year, l.publication, l.fund, l.form, l.interpretation_id,
    l.field, l.measure, l.measure_year
  order by l.budget_year, l.publication, l.form, l.interpretation_id, l.measure_year
`;

const inventoryFormsSql = sql<FormRow>`
  /* budget.national:approved_inventory_forms */
  select l.budget_year, l.publication, l.fund, l.form, l.interpretation_id,
    count(*)::int as line_count,
    count(distinct l.record_index)::int as record_count,
    coalesce(array_agg(distinct l.credit_type) filter (where l.credit_type is not null), '{}'::text[]) as credit_types,
    jsonb_agg(distinct jsonb_build_object('sourceFileId', l.source_file_id, 'sha256', l.content_sha256)) as sources,
    coalesce(jsonb_agg(distinct jsonb_build_array(l.authority_code, l.authority_name))
      filter (where l.form = ${FORM_LITERAL[AUTHORITY_DETAIL_FORM]}), '[]'::jsonb) as authorities
  from budget.approved_budget_lines l
  group by l.budget_year, l.publication, l.fund, l.form, l.interpretation_id
  order by l.budget_year, l.publication, l.form, l.interpretation_id
`;

interface FormAccumulator {
  form: ApprovedForm;
  interpretationIds: string[];
  sources: Map<string, { sourceFileId: string; sha256: string }>;
  recordCount: number;
  lineCount: number;
  creditTypes: Set<CreditType>;
  authorityCodes: Set<string>;
}

interface EditionAccumulator {
  edition: EditionRef;
  slots: Map<string, ApprovedSlot>;
  slotLineCounts: Map<string, number>;
  forms: Map<ApprovedForm, FormAccumulator>;
  authorities: Map<string, ApprovedAuthority>;
}

/** A recognised (fund, form) pair of the reviewed vocabulary, or null. */
const recognised = (fund: string, form: string): ApprovedForm | null => {
  const mappedForm = FORMS.get(form);
  const mappedFund = FUNDS.get(fund);
  return mappedForm !== undefined &&
    mappedFund !== undefined &&
    FORM_FUND[mappedForm] === mappedFund
    ? mappedForm
    : null;
};

const servedEdition = (budgetYear: number, publication: string): EditionRef | null => {
  const edition = editionOf(budgetYear, publication);
  return editionIdValue(edition.id, 'edition').isOk() ? edition : null;
};

export const buildInventory = (
  slotRows: readonly SlotRow[],
  formRows: readonly FormRow[]
): ApprovedInventory => {
  const editions = new Map<string, EditionAccumulator>();
  const unrecognized = new Map<string, ApprovedUnrecognizedGroup>();
  const snapshotRows: ApprovedInventoryKey[] = [];

  const editionFor = (edition: EditionRef): EditionAccumulator => {
    const existing = editions.get(edition.id);
    if (existing !== undefined) return existing;
    const created: EditionAccumulator = {
      edition,
      slots: new Map(),
      slotLineCounts: new Map(),
      forms: new Map(),
      authorities: new Map(),
    };
    editions.set(edition.id, created);
    return created;
  };

  for (const row of formRows) {
    snapshotRows.push({
      editionId: `${String(row.budget_year)}:${row.publication}`,
      form: row.form,
      interpretationId: row.interpretation_id,
      lineCount: row.line_count,
    });
    const form = recognised(row.fund, row.form);
    const edition = servedEdition(row.budget_year, row.publication);
    if (form === null || edition === null) {
      const key = JSON.stringify([row.budget_year, row.publication, row.fund, row.form]);
      const group = unrecognized.get(key);
      unrecognized.set(key, {
        budgetYear: row.budget_year,
        publication: row.publication,
        fund: row.fund,
        form: row.form,
        lineCount: (group?.lineCount ?? 0) + row.line_count,
      });
      continue;
    }
    if (
      !Value.Check(SourcesSchema, row.sources) ||
      !Value.Check(AuthoritiesSchema, row.authorities)
    ) {
      throw new NationalSourceContractError('inventory sources/authorities are malformed');
    }
    const entry = editionFor(edition);
    const summary: FormAccumulator = entry.forms.get(form) ?? {
      form,
      interpretationIds: [],
      sources: new Map(),
      recordCount: 0,
      lineCount: 0,
      creditTypes: new Set(),
      authorityCodes: new Set(),
    };
    summary.interpretationIds.push(row.interpretation_id);
    summary.recordCount += row.record_count;
    summary.lineCount += row.line_count;
    for (const credit of row.credit_types)
      summary.creditTypes.add(known(CREDITS, credit, 'credit type'));
    for (const source of row.sources)
      summary.sources.set(`${source.sourceFileId} ${source.sha256}`, source);
    for (const [code, name] of row.authorities) {
      if (code !== REVENUE_HOLDER_AUTHORITY_CODE) summary.authorityCodes.add(code);
      entry.authorities.set(JSON.stringify([code, name]), {
        key: `${edition.id}:${code}`,
        code,
        name,
      });
    }
    entry.forms.set(form, summary);
  }

  for (const row of slotRows) {
    const form = recognised(row.fund, row.form);
    const edition = servedEdition(row.budget_year, row.publication);
    if (form === null || edition === null) continue;
    const entry = editionFor(edition);
    entry.slots.set(row.field, {
      field: row.field,
      measure: known(MEASURES, row.measure, 'measure'),
      measureYear: row.measure_year,
    });
    entry.slotLineCounts.set(
      row.field,
      (entry.slotLineCounts.get(row.field) ?? 0) + row.line_count
    );
  }

  const catalog: ApprovedCatalogEdition[] = [...editions.values()]
    .sort((a, b) =>
      a.edition.budgetYear === b.edition.budgetYear
        ? a.edition.publication < b.edition.publication
          ? -1
          : 1
        : a.edition.budgetYear - b.edition.budgetYear
    )
    .map((entry) => {
      const forms: ApprovedFormSummary[] = [...entry.forms.values()]
        .sort((a, b) => (FORM_LITERAL[a.form] < FORM_LITERAL[b.form] ? -1 : 1))
        .map((form) => ({
          form: form.form,
          interpretationIds: [...form.interpretationIds].sort(),
          sources: [...form.sources.values()].map((source) => ({
            sourceFileId: source.sourceFileId,
            document: { url: null, sha256: source.sha256, bytes: null },
          })),
          recordCount: form.recordCount,
          lineCount: form.lineCount,
          creditTypes: (['BUDGET_CREDITS', 'COMMITMENT_CREDITS'] as const).filter((credit) =>
            form.creditTypes.has(credit)
          ),
          authorityCount: form.form === AUTHORITY_DETAIL_FORM ? form.authorityCodes.size : null,
        }));
      return {
        edition: entry.edition,
        slots: [...entry.slots.values()].sort((a, b) => a.measureYear - b.measureYear),
        forms,
        authorities: [...entry.authorities.values()].sort((a, b) =>
          a.code === b.code ? (a.name < b.name ? -1 : 1) : a.code < b.code ? -1 : 1
        ),
        slotLineCounts: entry.slotLineCounts,
        lineCount: forms.reduce((sum, form) => sum + form.lineCount, 0),
        hasConflictingInterpretations: forms.some((form) => form.interpretationIds.length > 1),
      };
    });

  return { snapshotRows, editions: catalog, unrecognized: [...unrecognized.values()] };
};

// ── stored records (descriptor candidates and records page) ──────────────────

export interface RecordLineRow {
  interpretation_id: string;
  record_index: number;
  budget_year: number;
  publication: string;
  fund: string;
  form: string;
  annex: string;
  report_title: string;
  authority_code: string;
  authority_name: string;
  capitol: string;
  subcapitol: string;
  paragraf: string;
  grupa: string | null;
  titlu: string | null;
  articol: string;
  alineat: string;
  label: string;
  row_role: string;
  credit_type: string | null;
  context_record_index: number | null;
  context_label: string | null;
  source_file_id: string;
  content_sha256: string;
  field: string;
  measure: string;
  measure_year: number;
  amount: string;
  token: string;
}

/** The record columns every stored-record read returns (never storage columns). */
const RECORD_COLUMNS = sql`
  l.interpretation_id, l.record_index, l.budget_year, l.publication, l.fund, l.form,
  l.annex, l.report_title, l.authority_code, l.authority_name,
  l.capitol, l.subcapitol, l.paragraf, l.grupa, l.titlu, l.articol, l.alineat,
  l.label, l.row_role, l.credit_type, l.context_record_index, l.context_label,
  l.source_file_id, l.content_sha256,
  l.field, l.measure, l.measure_year, l.amount::text as amount, l.token
`;

const storedSlot = (row: RecordLineRow): ApprovedStoredSlot => {
  const value = parseSourceDecimal(row.amount);
  if (value.isErr()) {
    throw new NationalSourceContractError(
      `amount of ${row.interpretation_id}:${String(row.record_index)} is not numeric text`
    );
  }
  return {
    field: row.field,
    measure: known(MEASURES, row.measure, 'measure'),
    measureYear: row.measure_year,
    value: value.value,
    token: row.token,
  };
};

/** Group ordered line rows into records (rows of one record are adjacent). */
export const recordsFromLines = (rows: readonly RecordLineRow[]): ApprovedStoredRecord[] => {
  const records: ApprovedStoredRecord[] = [];
  let current: { head: RecordLineRow; slots: ApprovedStoredSlot[] } | null = null;
  const flush = (): void => {
    if (current === null) return;
    const { head, slots } = current;
    const form = known(FORMS, head.form, 'form');
    records.push({
      interpretationId: head.interpretation_id,
      recordIndex: head.record_index,
      edition: editionOf(head.budget_year, head.publication),
      form,
      annex: head.annex,
      reportTitle: head.report_title,
      authorityCode: head.authority_code,
      authorityName: head.authority_name,
      codes: {
        capitol: head.capitol,
        subcapitol: head.subcapitol,
        paragraf: head.paragraf,
        grupa: head.grupa,
        titlu: head.titlu,
        articol: head.articol,
        alineat: head.alineat,
      },
      label: head.label,
      rowRole: known(ROW_ROLES, head.row_role, 'row role'),
      creditType:
        head.credit_type === null ? null : known(CREDITS, head.credit_type, 'credit type'),
      contextRecordIndex: head.context_record_index,
      contextLabel: head.context_label,
      sourceFileId: head.source_file_id,
      contentSha256: head.content_sha256,
      slots: [...slots].sort((a, b) => a.measureYear - b.measureYear),
    });
  };
  for (const row of rows) {
    if (
      current?.head.interpretation_id !== row.interpretation_id ||
      current.head.record_index !== row.record_index
    ) {
      flush();
      current = { head: row, slots: [] };
    }
    current.slots.push(storedSlot(row));
  }
  flush();
  return records;
};

interface CandidateLineRow extends RecordLineRow {
  group_key: string;
}

/** Group parameters: one JSON array, rules taken from the core registry. */
export const descriptorGroupsJson = (groups: readonly DescriptorGroup[]): string =>
  JSON.stringify(
    groups.map((group) => {
      const definition = TOTAL_DEFINITIONS[group.total];
      const { budgetYear, publication } = splitEditionId(group.editionId);
      return {
        group_key: descriptorGroupKey(group),
        budget_year: budgetYear,
        publication,
        fund: FUND_LITERAL[FORM_FUND[group.form]],
        form: FORM_LITERAL[group.form],
        row_role: ROW_ROLE_LITERAL[definition.rowRole],
        capitol: definition.capitol,
        label: definition.label,
        credit_type: group.creditType === null ? null : CREDIT_LITERAL[group.creditType],
        authority_code: group.authorityCode,
      };
    })
  );

export const descriptorCandidatesSql = (groupsJson: string) => sql<CandidateLineRow>`
  /* budget.national:approved_descriptor_candidates */
  with groups as (
    select * from jsonb_to_recordset(${groupsJson}::jsonb) as g(
      group_key text, budget_year int, publication text, fund text, form text,
      row_role text, capitol text, label text, credit_type text, authority_code text)
  ), candidates as (
    select distinct g.group_key, l.interpretation_id, l.record_index
    from groups g
    join budget.approved_budget_lines l
      on l.budget_year = g.budget_year and l.publication = g.publication
      and l.fund = g.fund and l.form = g.form and l.row_role = g.row_role
      and btrim(l.capitol) = g.capitol
      and btrim(case when l.row_role = 'credit' then l.context_label else l.label end) = g.label
      and btrim(l.paragraf) = '' and btrim(coalesce(l.grupa, l.titlu)) = ''
      and btrim(l.articol) = '' and btrim(l.alineat) = ''
      and (l.row_role = 'descriptor' or btrim(l.subcapitol) = '')
      and l.credit_type is not distinct from g.credit_type
      and (g.authority_code is null or l.authority_code = g.authority_code)
  )
  select c.group_key, ${RECORD_COLUMNS}
  from candidates c
  join budget.approved_budget_lines l
    on l.interpretation_id = c.interpretation_id and l.record_index = c.record_index
  order by c.group_key, l.interpretation_id collate "C", l.record_index, l.measure_year
`;

export const recordsPageSql = (request: ApprovedRecordsPageRequest) => {
  const query: ApprovedRecordsQuery = request.query;
  const filters = [sql`l.interpretation_id = any(${[...request.interpretationIds]}::text[])`];
  if (query.authorityCode !== null) filters.push(sql`l.authority_code = ${query.authorityCode}`);
  if (query.rowRoles !== null) {
    filters.push(
      sql`l.row_role = any(${query.rowRoles.map((role) => ROW_ROLE_LITERAL[role])}::text[])`
    );
  }
  if (query.creditTypes !== null) {
    filters.push(
      sql`l.credit_type = any(${query.creditTypes.map((credit) => CREDIT_LITERAL[credit])}::text[])`
    );
  }
  if (query.capitols !== null) {
    filters.push(sql`btrim(l.capitol) = any(${[...query.capitols]}::text[])`);
  }
  if (request.after !== null) {
    filters.push(sql`(l.interpretation_id collate "C" > ${request.after.interpretationId}
      or (l.interpretation_id = ${request.after.interpretationId}
        and l.record_index > ${request.after.recordIndex}::int))`);
  }
  return sql<RecordLineRow>`
    /* budget.national:approved_records_page */
    with page as (
      select l.interpretation_id, l.record_index
      from budget.approved_budget_lines l
      where ${sql.join(filters, sql` and `)}
      group by l.interpretation_id, l.record_index
      order by l.interpretation_id collate "C", l.record_index
      limit ${request.limit}
    )
    select ${RECORD_COLUMNS}
    from page p
    join budget.approved_budget_lines l
      on l.interpretation_id = p.interpretation_id and l.record_index = p.record_index
    order by l.interpretation_id collate "C", l.record_index, l.measure_year
  `;
};

export const makeNationalApprovedReader = (run: NationalRun): NationalApprovedReader => ({
  inventory: () =>
    guardedRead('approved inventory', async () => {
      const slots = await run(inventorySlotsSql);
      const forms = await run(inventoryFormsSql);
      return buildInventory(slots.rows, forms.rows);
    }),

  descriptorCandidates: (groups) =>
    guardedRead('approved descriptor candidates', async () => {
      const { rows } = await run(descriptorCandidatesSql(descriptorGroupsJson(groups)));
      const byGroup = new Map<string, CandidateLineRow[]>();
      for (const row of rows) {
        const list = byGroup.get(row.group_key) ?? [];
        list.push(row);
        byGroup.set(row.group_key, list);
      }
      return new Map(
        [...byGroup.entries()].map(([key, lines]) => [key, recordsFromLines(lines)] as const)
      );
    }),

  records: (request) =>
    guardedRead('approved records page', async () => {
      const { rows } = await run(recordsPageSql(request));
      return recordsFromLines(rows);
    }),
});
