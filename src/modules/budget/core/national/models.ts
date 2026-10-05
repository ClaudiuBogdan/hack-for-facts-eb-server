/**
 * National budget — read models exchanged between the read ports and core.
 *
 * These mirror the v3 SDL output objects. Amounts are `Decimal` (exact) and
 * become strings only at the wire edge. Provisional where the column-level
 * source contract is a P0 check; adapters map rows into these shapes.
 */

import type {
  ApprovedForm,
  ApprovedMeasure,
  CoverageKind,
  CreditType,
  ExecutionFamily,
  ExecutionInput,
  ExecutionInputSourceId,
  ExecutionMeasure,
  ExecutionSection,
  ExecutionStatus,
  FamilyPresence,
  Finality,
  ObservationDisposition,
  PeriodRole,
  RowRole,
  ValueBasis,
} from './vocabulary.js';
import type { Decimal } from 'decimal.js';

export interface DateInterval {
  readonly start: string | null;
  readonly end: string | null;
}

/** `url: null` means SOURCE LINK PENDING (law rows) — never a guessed URL. */
export interface SourceDocument {
  readonly url: string | null;
  readonly sha256: string;
  readonly bytes: number | null;
}

export interface CellEvidence {
  readonly sheet: string | null;
  readonly cell: string | null;
  readonly text: string;
}

export interface SourceLocator {
  readonly kind: string;
  readonly sheet: string | null;
  readonly cell: string | null;
  readonly page: number | null;
  readonly table: string | null;
  readonly row: number | null;
  readonly column: number | null;
}

// ── law ──────────────────────────────────────────────────────────────────────

export interface ApprovedAuthority {
  readonly key: string;
  readonly code: string;
  readonly name: string;
}

export interface ApprovedCodes {
  readonly capitol: string;
  readonly subcapitol: string;
  readonly paragraf: string;
  readonly grupa: string | null;
  readonly titlu: string | null;
  readonly articol: string;
  readonly alineat: string;
}

export interface ApprovedLineRef {
  readonly lineId: string;
  readonly interpretationId: string;
  readonly recordIndex: number;
  readonly field: string;
  readonly annex: string;
  readonly token: string;
  readonly sourceFileId: string;
  readonly document: SourceDocument;
}

export interface ApprovedDescriptorMatch {
  readonly recordIndex: number;
  readonly rowRole: RowRole;
  readonly codes: ApprovedCodes;
  readonly label: string;
  readonly contextRecordIndex: number | null;
  readonly contextLabel: string | null;
}

/** Adapter payload of a descriptor candidate (see `DescriptorCandidate.ref`). */
export interface ApprovedCandidateRef {
  readonly descriptor: ApprovedDescriptorMatch;
  readonly authority: ApprovedAuthority | null;
  /** Line reference of each stored slot, by slot field. */
  readonly lines: ReadonlyMap<string, ApprovedLineRef>;
}

/** Native slot value of a faithful record; null = no stored number, zero is a number. */
export interface ApprovedRecordValue {
  readonly field: string;
  readonly measure: ApprovedMeasure;
  readonly measureYear: number;
  readonly value: Decimal | null;
  readonly token: string | null;
  readonly lineId: string | null;
}

export interface ApprovedRecord {
  /** `(interpretationId, recordIndex)`; values are always native THOUSAND_LEI. */
  readonly id: string;
  readonly recordIndex: number;
  readonly interpretationId: string;
  readonly edition: EditionRef;
  readonly form: ApprovedForm;
  readonly annex: string;
  readonly reportTitle: string;
  readonly authority: ApprovedAuthority;
  readonly codes: ApprovedCodes;
  readonly label: string;
  readonly rowRole: RowRole;
  readonly creditType: CreditType | null;
  readonly contextRecordIndex: number | null;
  readonly contextLabel: string | null;
  readonly values: readonly ApprovedRecordValue[];
  readonly sourceFileId: string;
  readonly document: SourceDocument;
}

export interface EditionRef {
  readonly id: string;
  readonly budgetYear: number;
  readonly publication: string;
}

/** One numeric slot of an edition: a source field holding one target year. */
export interface ApprovedSlot {
  readonly field: string;
  readonly measure: ApprovedMeasure;
  readonly measureYear: number;
}

/**
 * A loaded form of an edition with its interpretation IDs. More than one
 * interpretation is a form-level conflict: every named result read from that
 * form is AMBIGUOUS, whatever the matching candidates are.
 */
export interface ApprovedFormInventory {
  readonly form: ApprovedForm;
  readonly interpretationIds: readonly string[];
}

/** Loaded inventory of one edition, read in the lane snapshot. */
export interface ApprovedEditionInventory {
  readonly edition: EditionRef;
  /** Ascending by measureYear. */
  readonly slots: readonly ApprovedSlot[];
  readonly forms: readonly ApprovedFormInventory[];
  /** Authorities of the authority detail as loaded (including code 999). */
  readonly authorities: readonly ApprovedAuthority[];
}

export interface ApprovedSourceFile {
  readonly sourceFileId: string;
  readonly document: SourceDocument;
}

export interface ApprovedFormSummary extends ApprovedFormInventory {
  readonly sources: readonly ApprovedSourceFile[];
  readonly recordCount: number;
  readonly lineCount: number;
  readonly creditTypes: readonly CreditType[];
  readonly authorityCount: number | null;
}

/** Catalog view of an edition; also satisfies the planning inventory. */
export interface ApprovedCatalogEdition extends ApprovedEditionInventory {
  readonly forms: readonly ApprovedFormSummary[];
  readonly slotLineCounts: ReadonlyMap<string, number>;
  readonly lineCount: number;
  readonly hasConflictingInterpretations: boolean;
}

/** A loaded fund/form group outside the reviewed vocabulary: counted, never mapped. */
export interface ApprovedUnrecognizedGroup {
  readonly budgetYear: number;
  readonly publication: string;
  readonly fund: string;
  readonly form: string;
  readonly lineCount: number;
}

// ── execution ────────────────────────────────────────────────────────────────

export interface ExecutionItem {
  readonly itemId: string;
  readonly section: ExecutionSection;
  readonly sourceLabel: string;
  readonly relatedScopeItemId: string | null;
  readonly mappingVersion: string;
}

export interface ExecutionFamilyStatus {
  readonly family: ExecutionFamily;
  readonly presence: FamilyPresence;
  readonly role: string | null;
  readonly reason: string | null;
  readonly sourceFormat: string | null;
  readonly document: SourceDocument | null;
  readonly reportCoverage: DateInterval | null;
}

export interface ExecutionRelease {
  readonly releaseId: string;
  readonly month: string;
  readonly calendarPeriod: DateInterval;
  readonly policyVersion: string;
  readonly publicationScope: string | null;
  readonly families: readonly ExecutionFamilyStatus[];
  readonly factCount: number;
}

export interface ExecutionSelection {
  readonly selectionId: string;
  readonly previousSelectionId: string | null;
  readonly chainPosition: number;
  readonly reason: string;
  readonly sealSha256: string;
  readonly release: ExecutionRelease;
}

/** Immutable source observation: node `(releaseId, input, observationKey)`. */
export interface ExecutionObservation {
  readonly id: string;
  readonly releaseId: string;
  readonly month: string;
  readonly input: ExecutionInput;
  readonly observationKey: string;
  readonly disposition: ObservationDisposition;
  readonly sourceState: string;
  readonly catalogItem: ExecutionItem | null;
  readonly section: ExecutionSection | null;
  readonly lineItem: string | null;
  readonly component: string | null;
  readonly periodRole: PeriodRole | null;
  readonly measure: ExecutionMeasure | null;
  readonly coverageKind: CoverageKind | null;
  readonly fiscalPeriod: DateInterval | null;
  readonly comparisonPeriod: DateInterval | null;
  readonly reportPeriod: DateInterval | null;
  readonly referenceYear: number | null;
  readonly executionStatus: ExecutionStatus | null;
  readonly finality: Finality | null;
  readonly value: Decimal | null;
  readonly unit: 'RON' | 'FRACTION' | null;
  readonly sourceToken: string | null;
  readonly reason: string | null;
  readonly locator: SourceLocator | null;
  readonly labelEvidence: CellEvidence | null;
  readonly document: SourceDocument;
}

/**
 * Selection occurrence edge. Ordered and paged by
 * `(periodEnd, selectionId, input source id, observationKey COLLATE "C")`, so a
 * rollback R1→R2→R1 yields three occurrences of two physical nodes.
 */
export interface ObservationOccurrence {
  readonly occurrenceId: string;
  readonly selectionId: string;
  /** `YYYY-MM-DD` end of the selection's calendar month (first sort key). */
  readonly periodEnd: string;
  /** Stored input id (`bgc` / `sinteza`), the third sort key. */
  readonly inputSourceId: ExecutionInputSourceId;
  readonly node: ExecutionObservation;
}

export interface SeriesOperand {
  readonly month: string;
  readonly selectionId: string | null;
  readonly releaseId: string | null;
  readonly observationKey: string | null;
  readonly sourceState: string | null;
  readonly document: SourceDocument | null;
  readonly coverage: DateInterval | null;
  readonly executionStatus: ExecutionStatus | null;
  readonly finality: Finality | null;
  readonly label: CellEvidence | null;
  readonly headers: readonly CellEvidence[];
}

/** One row of `budget.execution_national_budget_series_v1`, mapped unchanged. */
export interface NationalSeriesViewRow {
  readonly itemId: string;
  /** Grid label (`YYYY-MM`, `YYYY-QN`, `YYYY`): the display date only. */
  readonly date: string;
  /**
   * The view's `period_start` / `period_end`: the interval the VALUE covers
   * (YTD and full year from 1 January; differences from the period start).
   */
  readonly periodStart: string;
  readonly periodEnd: string;
  /** The view's raw reason code; `available` marks availability. */
  readonly reason: string;
  readonly value: Decimal | null;
  readonly valueBasis: ValueBasis | null;
  readonly endpoint: SeriesOperand | null;
  readonly predecessor: SeriesOperand | null;
}

// ── adapter rows (typed source reads; core builds the public shapes) ──────────

/** One stored numeric slot of a law record (a `approved_budget_lines` row). */
export interface ApprovedStoredSlot {
  readonly field: string;
  readonly measure: ApprovedMeasure;
  readonly measureYear: number;
  /** Exact native thousand-lei amount (`amount::text` parsed by core). */
  readonly value: Decimal;
  readonly token: string;
}

/**
 * One faithful law record `(interpretationId, recordIndex)` with ALL of its
 * stored slots (never filtered to a target year before classification).
 */
export interface ApprovedStoredRecord {
  readonly interpretationId: string;
  readonly recordIndex: number;
  readonly edition: EditionRef;
  readonly form: ApprovedForm;
  readonly annex: string;
  readonly reportTitle: string;
  readonly authorityCode: string;
  readonly authorityName: string;
  readonly codes: ApprovedCodes;
  readonly label: string;
  readonly rowRole: RowRole;
  readonly creditType: CreditType | null;
  readonly contextRecordIndex: number | null;
  readonly contextLabel: string | null;
  readonly sourceFileId: string;
  /** `content_sha256` of the source file. */
  readonly contentSha256: string;
  /** Ascending by measureYear. */
  readonly slots: readonly ApprovedStoredSlot[];
}

/** Current chain leaf of a calendar month. */
export interface ExecutionLeafRow {
  readonly month: string;
  readonly periodEnd: string;
  /** Canonical lowercase UUID. */
  readonly selectionId: string;
  readonly releaseId: string;
}

/** A month's chain: total length and its newest selections (leaf first). */
export interface ExecutionChain {
  readonly month: string;
  /** Selections in the month's predecessor chain (bounded walk). */
  readonly length: number;
  /** Leaf first, at most the requested revisions; `chainPosition` 1 = chain root. */
  readonly newest: readonly ExecutionSelection[];
}
