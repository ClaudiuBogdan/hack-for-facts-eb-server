/**
 * National budget — faithful law records and descriptor candidates built from
 * stored source records.
 *
 * Identities are source-derived and edition-local: a record is
 * `(interpretationId, recordIndex)`, a line is that record plus its slot field
 * (the table's primary key), and an authority key is `(edition, printed code)`.
 * An authority code is never a cross-edition identity or a CUI. Law documents
 * have no reviewed serving URL yet, so `url` is always null (SOURCE LINK
 * PENDING), never guessed.
 */

import { AUTHORITY_DETAIL_FORM, type ApprovedForm } from './vocabulary.js';

import type { ApprovedRecordSource } from './approved-inputs.js';
import type { DescriptorCandidate } from './approved-plan.js';
import type {
  ApprovedAuthority,
  ApprovedCandidateRef,
  ApprovedCatalogEdition,
  ApprovedLineRef,
  ApprovedRecord,
  ApprovedSlot,
  ApprovedStoredRecord,
  ApprovedStoredSlot,
  EditionRef,
  SourceDocument,
} from './models.js';

export interface ResolvedRecordSource {
  readonly edition: EditionRef;
  readonly form: ApprovedForm;
  readonly interpretationIds: readonly string[];
  /** The edition's loaded slots (dense record values follow them). */
  readonly slots: readonly ApprovedSlot[];
}

/**
 * Resolve a record source against the snapshot inventory. `null` means an
 * unknown interpretation or an unloaded edition/form (NOT_FOUND).
 */
export const resolveRecordSource = (
  source: ApprovedRecordSource,
  editions: readonly ApprovedCatalogEdition[]
): ResolvedRecordSource | null => {
  for (const entry of editions) {
    for (const form of entry.forms) {
      const matches =
        source.kind === 'EDITION'
          ? entry.edition.id === source.edition.id && form.form === source.form
          : form.interpretationIds.includes(source.interpretationId);
      if (!matches) continue;
      return {
        edition: entry.edition,
        form: form.form,
        interpretationIds:
          source.kind === 'EDITION' ? form.interpretationIds : [source.interpretationId],
        slots: entry.slots,
      };
    }
  }
  return null;
};

/** Whether an authority filter can apply to a resolved form. */
export const acceptsAuthorityFilter = (form: ApprovedForm): boolean =>
  form === AUTHORITY_DETAIL_FORM;

export const lawDocument = (contentSha256: string): SourceDocument => ({
  url: null,
  sha256: contentSha256,
  bytes: null,
});

export const recordId = (interpretationId: string, recordIndex: number): string =>
  `${interpretationId}:${String(recordIndex)}`;

export const authorityOf = (record: ApprovedStoredRecord): ApprovedAuthority => ({
  key: `${record.edition.id}:${record.authorityCode}`,
  code: record.authorityCode,
  name: record.authorityName,
});

const lineOf = (record: ApprovedStoredRecord, slot: ApprovedStoredSlot): ApprovedLineRef => ({
  lineId: `${recordId(record.interpretationId, record.recordIndex)}:${slot.field}`,
  interpretationId: record.interpretationId,
  recordIndex: record.recordIndex,
  field: slot.field,
  annex: record.annex,
  token: slot.token,
  sourceFileId: record.sourceFileId,
  document: lawDocument(record.contentSha256),
});

/** A descriptor candidate with every stored slot of the record. */
export const candidateFromStored = (
  record: ApprovedStoredRecord
): DescriptorCandidate<ApprovedCandidateRef> => ({
  interpretationId: record.interpretationId,
  recordIndex: record.recordIndex,
  slotValues: new Map(record.slots.map((slot) => [slot.field, slot.value])),
  ref: {
    descriptor: {
      recordIndex: record.recordIndex,
      rowRole: record.rowRole,
      codes: record.codes,
      label: record.label,
      contextRecordIndex: record.contextRecordIndex,
      contextLabel: record.contextLabel,
    },
    authority: authorityOf(record),
    lines: new Map(record.slots.map((slot) => [slot.field, lineOf(record, slot)])),
  },
});

/**
 * A faithful native record: one value per loaded edition slot, in slot order.
 * A slot without a stored number is null; zero stays a number.
 */
export const projectRecord = (
  record: ApprovedStoredRecord,
  editionSlots: readonly ApprovedSlot[]
): ApprovedRecord => {
  const stored = new Map(record.slots.map((slot) => [slot.field, slot]));
  return {
    id: recordId(record.interpretationId, record.recordIndex),
    recordIndex: record.recordIndex,
    interpretationId: record.interpretationId,
    edition: record.edition,
    form: record.form,
    annex: record.annex,
    reportTitle: record.reportTitle,
    authority: authorityOf(record),
    codes: record.codes,
    label: record.label,
    rowRole: record.rowRole,
    creditType: record.creditType,
    contextRecordIndex: record.contextRecordIndex,
    contextLabel: record.contextLabel,
    values: editionSlots.map((slot) => {
      const value = stored.get(slot.field);
      return {
        field: slot.field,
        measure: slot.measure,
        measureYear: slot.measureYear,
        value: value?.value ?? null,
        token: value?.token ?? null,
        lineId: value === undefined ? null : lineOf(record, value).lineId,
      };
    }),
    sourceFileId: record.sourceFileId,
    document: lawDocument(record.contentSha256),
  };
};
