/**
 * National budget — public payloads (the exact GraphQL/MCP wire shapes).
 *
 * Every field is copied explicitly from a typed model; no source row or object
 * is spread, so internal storage/gate/parse attributes cannot leak. Amounts are
 * `Decimal.toFixed()` strings; dates are `YYYY-MM-DD`; enums are SDL names.
 */

import { toWireDataSeries, toWireDecimal, type WireDataSeries } from './values.js';

import type { ApprovedSeriesProjection, ApprovedTotalCell } from './approved-projection.js';
import type { ExecutionCoverage, ExecutionSeriesProjection } from './execution-projection.js';
import type {
  ApprovedAuthority,
  ApprovedCodes,
  ApprovedDescriptorMatch,
  ApprovedLineRef,
  ApprovedRecord,
  CellEvidence,
  DateInterval,
  EditionRef,
  ExecutionFamilyStatus,
  ExecutionItem,
  ExecutionObservation,
  ExecutionRelease,
  ExecutionSelection,
  ObservationOccurrence,
  SeriesOperand,
  SourceDocument,
  SourceLocator,
} from './models.js';

// ── shared pieces ────────────────────────────────────────────────────────────

export interface EditionRefDto {
  readonly id: string;
  readonly budgetYear: number;
  readonly publication: string;
}

export interface SourceDocumentDto {
  readonly url: string | null;
  readonly sha256: string;
  readonly bytes: number | null;
}

export interface DateIntervalDto {
  readonly start: string | null;
  readonly end: string | null;
}

export interface CellEvidenceDto {
  readonly sheet: string | null;
  readonly cell: string | null;
  readonly text: string;
}

export const editionRefDto = (edition: EditionRef): EditionRefDto => ({
  id: edition.id,
  budgetYear: edition.budgetYear,
  publication: edition.publication,
});

export const documentDto = (document: SourceDocument): SourceDocumentDto => ({
  url: document.url,
  sha256: document.sha256,
  bytes: document.bytes,
});

export const intervalDto = (interval: DateInterval): DateIntervalDto => ({
  start: interval.start,
  end: interval.end,
});

export const evidenceDto = (evidence: CellEvidence): CellEvidenceDto => ({
  sheet: evidence.sheet,
  cell: evidence.cell,
  text: evidence.text,
});

const nullable = <T, R>(value: T | null, map: (present: T) => R): R | null =>
  value === null ? null : map(value);

// ── law ──────────────────────────────────────────────────────────────────────

export interface AuthorityDto {
  readonly key: string;
  readonly code: string;
  readonly name: string;
}

export type CodesDto = ApprovedCodes;

export interface LineRefDto {
  readonly lineId: string;
  readonly interpretationId: string;
  readonly recordIndex: number;
  readonly field: string;
  readonly annex: string;
  readonly token: string;
  readonly sourceFileId: string;
  readonly document: SourceDocumentDto;
}

export interface DescriptorMatchDto {
  readonly recordIndex: number;
  readonly rowRole: string;
  readonly codes: CodesDto;
  readonly label: string;
  readonly contextRecordIndex: number | null;
  readonly contextLabel: string | null;
}

export const authorityDto = (authority: ApprovedAuthority): AuthorityDto => ({
  key: authority.key,
  code: authority.code,
  name: authority.name,
});

export const codesDto = (codes: ApprovedCodes): CodesDto => ({
  capitol: codes.capitol,
  subcapitol: codes.subcapitol,
  paragraf: codes.paragraf,
  grupa: codes.grupa,
  titlu: codes.titlu,
  articol: codes.articol,
  alineat: codes.alineat,
});

export const lineRefDto = (line: ApprovedLineRef): LineRefDto => ({
  lineId: line.lineId,
  interpretationId: line.interpretationId,
  recordIndex: line.recordIndex,
  field: line.field,
  annex: line.annex,
  token: line.token,
  sourceFileId: line.sourceFileId,
  document: documentDto(line.document),
});

export const descriptorDto = (descriptor: ApprovedDescriptorMatch): DescriptorMatchDto => ({
  recordIndex: descriptor.recordIndex,
  rowRole: descriptor.rowRole,
  codes: codesDto(descriptor.codes),
  label: descriptor.label,
  contextRecordIndex: descriptor.contextRecordIndex,
  contextLabel: descriptor.contextLabel,
});

export interface TotalCellDto {
  readonly edition: EditionRefDto;
  readonly fund: string;
  readonly total: string;
  readonly authorityCode: string | null;
  readonly authority: AuthorityDto | null;
  readonly measure: string;
  readonly measureYear: number;
  readonly creditType: string | null;
  readonly status: string;
  readonly matchCount: number;
  readonly value: string | null;
  readonly unit: string;
  readonly descriptor: DescriptorMatchDto | null;
  readonly line: LineRefDto | null;
  readonly candidates: readonly LineRefDto[];
}

export const totalCellDto = (cell: ApprovedTotalCell): TotalCellDto => ({
  edition: editionRefDto(cell.edition),
  fund: cell.fund,
  total: cell.total,
  authorityCode: cell.authorityCode,
  authority: nullable(cell.authority, authorityDto),
  measure: cell.measure,
  measureYear: cell.measureYear,
  creditType: cell.creditType,
  status: cell.status,
  matchCount: cell.matchCount,
  value: nullable(cell.value, toWireDecimal),
  unit: cell.unit,
  descriptor: nullable(cell.descriptor, descriptorDto),
  line: nullable(cell.line, lineRefDto),
  candidates: cell.candidates.map(lineRefDto),
});

export interface ApprovedTotalsDto {
  readonly snapshot: string;
  readonly cells: readonly TotalCellDto[];
  readonly unloadedEditionIds: readonly string[];
  readonly missingAuthorities: readonly { readonly editionId: string; readonly code: string }[];
}

export interface ApprovedSeriesPeriodDto {
  readonly date: string;
  readonly status: string;
  readonly edition: EditionRefDto | null;
  readonly candidateEditions: readonly EditionRefDto[];
  readonly budgetYear: number | null;
  readonly measureYear: number | null;
  readonly measure: string | null;
  readonly matchCount: number | null;
  readonly descriptor: DescriptorMatchDto | null;
  readonly line: LineRefDto | null;
}

export interface ApprovedSeriesDto {
  readonly snapshot: string;
  readonly axis: string;
  readonly fund: string;
  readonly total: string;
  readonly creditType: string | null;
  readonly authority: AuthorityDto | null;
  readonly edition: EditionRefDto | null;
  readonly targetYear: number | null;
  readonly unit: string;
  readonly series: WireDataSeries;
  readonly periods: readonly ApprovedSeriesPeriodDto[];
}

export const approvedSeriesPeriodsDto = (
  projection: ApprovedSeriesProjection
): readonly ApprovedSeriesPeriodDto[] =>
  projection.periods.map((period) => ({
    date: period.date,
    status: period.status,
    edition: nullable(period.edition, editionRefDto),
    candidateEditions: period.candidateEditions.map(editionRefDto),
    budgetYear: period.budgetYear,
    measureYear: period.measureYear,
    measure: period.measure,
    matchCount: period.matchCount,
    descriptor: nullable(period.descriptor, descriptorDto),
    line: nullable(period.line, lineRefDto),
  }));

export interface ApprovedValueDto {
  readonly field: string;
  readonly measure: string;
  readonly measureYear: number;
  readonly value: string | null;
  readonly token: string | null;
  readonly lineId: string | null;
}

export interface ApprovedRecordDto {
  readonly id: string;
  readonly recordIndex: number;
  readonly interpretationId: string;
  readonly edition: EditionRefDto;
  readonly form: string;
  readonly annex: string;
  readonly reportTitle: string;
  readonly authority: AuthorityDto;
  readonly codes: CodesDto;
  readonly label: string;
  readonly rowRole: string;
  readonly creditType: string | null;
  readonly contextRecordIndex: number | null;
  readonly contextLabel: string | null;
  readonly values: readonly ApprovedValueDto[];
  readonly sourceFileId: string;
  readonly document: SourceDocumentDto;
}

export const recordDto = (record: ApprovedRecord): ApprovedRecordDto => ({
  id: record.id,
  recordIndex: record.recordIndex,
  interpretationId: record.interpretationId,
  edition: editionRefDto(record.edition),
  form: record.form,
  annex: record.annex,
  reportTitle: record.reportTitle,
  authority: authorityDto(record.authority),
  codes: codesDto(record.codes),
  label: record.label,
  rowRole: record.rowRole,
  creditType: record.creditType,
  contextRecordIndex: record.contextRecordIndex,
  contextLabel: record.contextLabel,
  values: record.values.map((value) => ({
    field: value.field,
    measure: value.measure,
    measureYear: value.measureYear,
    value: nullable(value.value, toWireDecimal),
    token: value.token,
    lineId: value.lineId,
  })),
  sourceFileId: record.sourceFileId,
  document: documentDto(record.document),
});

export interface PageInfoDto {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface ApprovedRecordConnectionDto {
  readonly snapshot: string;
  readonly unit: 'THOUSAND_LEI';
  readonly edges: readonly { readonly node: ApprovedRecordDto; readonly cursor: string }[];
  readonly pageInfo: PageInfoDto;
}

// ── execution ────────────────────────────────────────────────────────────────

export interface ExecutionItemDto {
  readonly itemId: string;
  readonly section: string;
  readonly sourceLabel: string;
  readonly relatedScopeItemId: string | null;
  readonly mappingVersion: string;
}

export const itemDto = (item: ExecutionItem): ExecutionItemDto => ({
  itemId: item.itemId,
  section: item.section,
  sourceLabel: item.sourceLabel,
  relatedScopeItemId: item.relatedScopeItemId,
  mappingVersion: item.mappingVersion,
});

export interface CoverageDto {
  readonly firstMonth: string;
  readonly lastMonth: string;
  readonly calendarMonthCount: number;
  readonly selectedMonthCount: number;
  readonly missingMonths: readonly string[];
  readonly note: string;
}

export const coverageDto = (coverage: ExecutionCoverage): CoverageDto => ({
  firstMonth: coverage.firstMonth,
  lastMonth: coverage.lastMonth,
  calendarMonthCount: coverage.calendarMonthCount,
  selectedMonthCount: coverage.selectedMonthCount,
  missingMonths: [...coverage.missingMonths],
  note: coverage.note,
});

export interface FamilyStatusDto {
  readonly family: string;
  readonly presence: string;
  readonly role: string | null;
  readonly reason: string | null;
  readonly sourceFormat: string | null;
  readonly document: SourceDocumentDto | null;
  readonly reportCoverage: DateIntervalDto | null;
}

export interface ReleaseDto {
  readonly releaseId: string;
  readonly month: string;
  readonly calendarPeriod: DateIntervalDto;
  readonly policyVersion: string;
  readonly publicationScope: string | null;
  readonly families: readonly FamilyStatusDto[];
  readonly factCount: number;
}

export interface SelectionDto {
  readonly selectionId: string;
  readonly previousSelectionId: string | null;
  readonly chainPosition: number;
  readonly reason: string;
  readonly sealSha256: string;
  readonly release: ReleaseDto;
}

const familyDto = (family: ExecutionFamilyStatus): FamilyStatusDto => ({
  family: family.family,
  presence: family.presence,
  role: family.role,
  reason: family.reason,
  sourceFormat: family.sourceFormat,
  document: nullable(family.document, documentDto),
  reportCoverage: nullable(family.reportCoverage, intervalDto),
});

const releaseDto = (release: ExecutionRelease): ReleaseDto => ({
  releaseId: release.releaseId,
  month: release.month,
  calendarPeriod: intervalDto(release.calendarPeriod),
  policyVersion: release.policyVersion,
  publicationScope: release.publicationScope,
  families: release.families.map(familyDto),
  factCount: release.factCount,
});

export const selectionDto = (selection: ExecutionSelection): SelectionDto => ({
  selectionId: selection.selectionId,
  previousSelectionId: selection.previousSelectionId,
  chainPosition: selection.chainPosition,
  reason: selection.reason,
  sealSha256: selection.sealSha256,
  release: releaseDto(selection.release),
});

export interface ExecutionMonthDto {
  readonly month: string;
  readonly status: 'SELECTED' | 'NO_SELECTED_RELEASE';
  readonly gapReason: string | null;
  readonly current: SelectionDto | null;
  readonly revisionCount: number;
  readonly revisions: readonly SelectionDto[];
  readonly revisionsTruncated: boolean;
}

export interface ExecutionReleaseIndexDto {
  readonly snapshot: string;
  readonly coverage: CoverageDto;
  readonly months: readonly ExecutionMonthDto[];
}

export interface SourceLocatorDto {
  readonly kind: string;
  readonly sheet: string | null;
  readonly cell: string | null;
  readonly page: number | null;
  readonly table: string | null;
  readonly row: number | null;
  readonly column: number | null;
}

const locatorDto = (locator: SourceLocator): SourceLocatorDto => ({
  kind: locator.kind,
  sheet: locator.sheet,
  cell: locator.cell,
  page: locator.page,
  table: locator.table,
  row: locator.row,
  column: locator.column,
});

export interface ObservationDto {
  readonly id: string;
  readonly releaseId: string;
  readonly month: string;
  readonly input: string;
  readonly observationKey: string;
  readonly disposition: string;
  readonly sourceState: string;
  readonly catalogItem: ExecutionItemDto | null;
  readonly section: string | null;
  readonly lineItem: string | null;
  readonly component: string | null;
  readonly periodRole: string | null;
  readonly measure: string | null;
  readonly coverageKind: string | null;
  readonly fiscalPeriod: DateIntervalDto | null;
  readonly comparisonPeriod: DateIntervalDto | null;
  readonly reportPeriod: DateIntervalDto | null;
  readonly referenceYear: number | null;
  readonly executionStatus: string | null;
  readonly finality: string | null;
  readonly value: string | null;
  readonly unit: string | null;
  readonly sourceToken: string | null;
  readonly reason: string | null;
  readonly locator: SourceLocatorDto | null;
  readonly labelEvidence: CellEvidenceDto | null;
  readonly document: SourceDocumentDto;
}

export const observationDto = (node: ExecutionObservation): ObservationDto => ({
  id: node.id,
  releaseId: node.releaseId,
  month: node.month,
  input: node.input,
  observationKey: node.observationKey,
  disposition: node.disposition,
  sourceState: node.sourceState,
  catalogItem: nullable(node.catalogItem, itemDto),
  section: node.section,
  lineItem: node.lineItem,
  component: node.component,
  periodRole: node.periodRole,
  measure: node.measure,
  coverageKind: node.coverageKind,
  fiscalPeriod: nullable(node.fiscalPeriod, intervalDto),
  comparisonPeriod: nullable(node.comparisonPeriod, intervalDto),
  reportPeriod: nullable(node.reportPeriod, intervalDto),
  referenceYear: node.referenceYear,
  executionStatus: node.executionStatus,
  finality: node.finality,
  value: nullable(node.value, toWireDecimal),
  unit: node.unit,
  sourceToken: node.sourceToken,
  reason: node.reason,
  locator: nullable(node.locator, locatorDto),
  labelEvidence: nullable(node.labelEvidence, evidenceDto),
  document: documentDto(node.document),
});

export interface ObservationEdgeDto {
  readonly cursor: string;
  readonly occurrenceId: string;
  readonly selectionId: string;
  readonly node: ObservationDto;
}

export const occurrenceId = (occurrence: ObservationOccurrence): string => occurrence.occurrenceId;

export interface ObservationConnectionDto {
  readonly snapshot: string;
  readonly edges: readonly ObservationEdgeDto[];
  readonly pageInfo: PageInfoDto;
}

export interface SeriesOperandDto {
  readonly month: string;
  readonly selectionId: string | null;
  readonly releaseId: string | null;
  readonly observationKey: string | null;
  readonly sourceState: string | null;
  readonly document: SourceDocumentDto | null;
  readonly coverage: DateIntervalDto | null;
  readonly executionStatus: string | null;
  readonly finality: string | null;
  readonly label: CellEvidenceDto | null;
  readonly headers: readonly CellEvidenceDto[];
}

const operandDto = (operand: SeriesOperand): SeriesOperandDto => ({
  month: operand.month,
  selectionId: operand.selectionId,
  releaseId: operand.releaseId,
  observationKey: operand.observationKey,
  sourceState: operand.sourceState,
  document: nullable(operand.document, documentDto),
  coverage: nullable(operand.coverage, intervalDto),
  executionStatus: operand.executionStatus,
  finality: operand.finality,
  label: nullable(operand.label, evidenceDto),
  headers: operand.headers.map(evidenceDto),
});

export interface SeriesPeriodDto {
  readonly date: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: string;
  readonly reason: string | null;
  readonly valueBasis: string | null;
  readonly endpoint: SeriesOperandDto | null;
  readonly predecessor: SeriesOperandDto | null;
}

export interface NationalSeriesDto {
  readonly item: ExecutionItemDto;
  readonly component: string;
  readonly basis: string;
  readonly unit: 'RON';
  readonly series: WireDataSeries;
  readonly periods: readonly SeriesPeriodDto[];
}

export const nationalSeriesDto = (
  item: ExecutionItem,
  component: string,
  projection: ExecutionSeriesProjection
): NationalSeriesDto => ({
  item: itemDto(item),
  component,
  basis: projection.basis,
  unit: 'RON',
  series: toWireDataSeries(projection.series),
  periods: projection.periods.map((period) => ({
    date: period.date,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    status: period.status,
    reason: period.reason,
    valueBasis: period.valueBasis,
    endpoint: nullable(period.endpoint, operandDto),
    predecessor: nullable(period.predecessor, operandDto),
  })),
});

export interface NationalSeriesResultDto {
  readonly snapshot: string;
  readonly mappingVersion: string;
  readonly derivationVersion: string;
  readonly coverage: CoverageDto;
  readonly results: readonly NationalSeriesDto[];
}

// ── catalog ──────────────────────────────────────────────────────────────────

export interface CatalogSlotDto {
  readonly field: string;
  readonly measure: string;
  readonly measureYear: number;
  readonly lineCount: number;
}

export interface CatalogFormDto {
  readonly form: string;
  readonly fund: string;
  readonly interpretationIds: readonly string[];
  readonly sources: readonly {
    readonly sourceFileId: string;
    readonly document: SourceDocumentDto;
  }[];
  readonly recordCount: number;
  readonly lineCount: number;
  readonly creditTypes: readonly string[];
  readonly authorityCount: number | null;
}

export interface CatalogEditionDto extends EditionRefDto {
  readonly slots: readonly CatalogSlotDto[];
  readonly forms: readonly CatalogFormDto[];
  readonly lineCount: number;
  readonly hasConflictingInterpretations: boolean;
}

export interface TotalDefinitionDto {
  readonly key: string;
  readonly scope: string;
  readonly forms: readonly string[];
  readonly rowRole: string;
  readonly capitol: string;
  readonly label: string;
  readonly requiresCreditType: boolean;
  readonly description: string;
}

export interface NationalCatalogDto {
  readonly snapshots: { readonly approved: string; readonly execution: string };
  readonly approved: {
    readonly editions: readonly CatalogEditionDto[];
    readonly totals: readonly TotalDefinitionDto[];
    readonly unrecognized: readonly {
      readonly budgetYear: number;
      readonly publication: string;
      readonly fund: string;
      readonly form: string;
      readonly lineCount: number;
    }[];
  };
  readonly execution: {
    readonly coverage: CoverageDto;
    readonly seriesItems: readonly ExecutionItemDto[];
  };
}
