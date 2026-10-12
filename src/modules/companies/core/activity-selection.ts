/**
 * Companies module — the derived activity selection of one company (CAEN
 * contract §B, identical to the scrapper's analytics export). Pure.
 *
 * Inputs are the pinned edition's EXACT per-(revision, code, class state)
 * aggregate of the CUI's public ONRC CAEN observations (never the bounded
 * 500-row display list), the public ANAF fiscal row with the form its
 * qualification receipt proves (`companies_v2.anaf_fiscal_caen_form`, never
 * parsed here), its usability under the current form policy
 * (`anaf_fiscal_caen_usable`) and its catalog membership
 * (`caen_code_is_catalogued`), all decided by the database (one definition
 * shared with the export; no usable set or catalog test is hard-coded here),
 * and the current catalog candidates of the codes involved (display only).
 *
 * The answer is a DERIVED selection, never a published principal activity:
 *  - `onrc_single_class`: the only classified ONRC observation of the edition
 *    (not an exclusive authorization: see coverage and unqualified rows);
 *  - `onrc_class_anaf_numeric_match`: one of several classified ONRC keys,
 *    the only one whose code has the same digits as a usable ANAF code;
 *  - `onrc_multiple_classes`: several classified keys, none selected;
 *  - `anaf_fiscal_code` / `anaf_fiscal_uncatalogued`: no classified ONRC key,
 *    a usable ANAF code with / without a nonblank catalog label in any
 *    revision (the latter is a source observation, not a classified sector);
 *  - `no_qualified_selection`: nothing qualifies (never "no activity").
 * ANAF never supplies a revision. A selected ONRC key keeps its exact catalog
 * label; an ANAF code only gets catalog candidates (CONSENSUS, CONFLICT or
 * MISSING). Coverage is reported as computed, never upgraded by ANAF.
 */

import { err, ok, type Result } from 'neverthrow';

import { databaseError, serviceUnavailable, type ApiError } from '@/modules/shared/index.js';

import {
  resolveCaenDescriptions,
  type CaenCatalogDescription,
  type CaenDescriptionStatus,
} from './caen-descriptions.js';
import { isCompanyCaenClassState, type CompanyRegistryCoverage } from './registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary (the serving view and function values; GraphQL maps them to enums)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ANAF fiscal CAEN form (CAEN contract §A2, revised) as this API serves
 * it. `absent` = no public fiscal row. Which forms are usable is the
 * database policy's decision (`anaf_fiscal_caen_usable`), never this list's.
 */
export const COMPANY_ANAF_CAEN_FORMS = [
  'four_digit',
  'three_digit',
  'short',
  'missing',
  'invalid',
  'unbound',
  'unqualified',
  'absent',
] as const;
export type CompanyAnafCaenForm = (typeof COMPANY_ANAF_CAEN_FORMS)[number];

export const COMPANY_ANAF_ONRC_AGREEMENTS = [
  'match_one_key',
  'match_multiple_revisions',
  'differs',
  'no_class_key',
  'anaf_missing',
  'anaf_placeholder',
  'anaf_not_usable',
] as const;
export type CompanyAnafOnrcAgreement = (typeof COMPANY_ANAF_ONRC_AGREEMENTS)[number];

export const COMPANY_ACTIVITY_BASES = [
  'onrc_single_class',
  'onrc_class_anaf_numeric_match',
  'onrc_multiple_classes',
  'anaf_fiscal_code',
  'anaf_fiscal_uncatalogued',
  'no_qualified_selection',
] as const;
export type CompanyActivityBasis = (typeof COMPANY_ACTIVITY_BASES)[number];

/** ANAF placeholder codes: never usable (measured in the 2026-10-12 audit). */
export const ANAF_PLACEHOLDER_CAEN_CODES: readonly string[] = ['0000', '9999'];

/** More (revision, code, class state) groups than this is refused, never truncated. */
export const ACTIVITY_AGGREGATE_GROUP_BOUND = 2000;

export const ACTIVITY_AGGREGATE_BOUND_MESSAGE = `the company has more than ${String(ACTIVITY_AGGREGATE_GROUP_BOUND)} distinct ONRC CAEN observation groups in the pinned edition; no activity selection is derived from a truncated aggregate`;

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/** One row of the bounded exact aggregate (`group by revision, code, class state`). */
export interface CaenClassStateGroup {
  readonly revision: string | null;
  readonly code: string | null;
  readonly classState: string;
  readonly rows: number;
}

/** The public ANAF fiscal row as the selection reads it (every decision DB-made). */
export interface ActivityFiscalObservation {
  /** `fiscal_status.main_caen_code` (the serving value, padded by the loader). */
  readonly code: string | null;
  /** `anaf_fiscal_caen_form(...)`. */
  readonly form: string | null;
  /** `anaf_fiscal_caen_usable(form)`: only `true` is usable (fail closed). */
  readonly usable: boolean | null;
  /** `anaf_fiscal_caen_form_policy()`, e.g. `anaf-caen-form-policy-v1`. */
  readonly policy: string | null;
  /** `caen_code_is_catalogued(main_caen_code)`: only `true` is catalogued. */
  readonly catalogued: boolean | null;
  /** ANAF's state date (`status_date`, YYYY-MM-DD); null when unknown. */
  readonly statusDate: string | null;
}

/** What the repository reads for one CUI under the pinned edition. */
export interface CompanyActivityEvidence {
  /** At most ACTIVITY_AGGREGATE_GROUP_BOUND + 1 groups (the extra one proves the overflow). */
  readonly groups: readonly CaenClassStateGroup[];
  /** null = no public fiscal row. */
  readonly fiscal: ActivityFiscalObservation | null;
  /** Catalog candidates by code (every revision), for every code the selection may name. */
  readonly catalog: ReadonlyMap<string, readonly CaenCatalogDescription[]>;
}

export interface ActivitySelectionInput extends CompanyActivityEvidence {
  readonly caenCoverage: CompanyRegistryCoverage;
  readonly editionId: string;
  readonly editionSourceDate: string | null;
}

export type CompanyActivitySource = 'ONRC' | 'ANAF';

/** `Company.activitySelection`: one derived selection with its evidence and both source dates. */
export interface CompanyActivitySelection {
  readonly basis: CompanyActivityBasis;
  /** null for the multiple-classes and no-selection bases. */
  readonly source: CompanyActivitySource | null;
  readonly code: string | null;
  /** ONRC only; never set for ANAF. */
  readonly revision: string | null;
  /** ONRC: the exact catalog label of (revision, code). ANAF: a CONSENSUS label or null. */
  readonly label: string | null;
  readonly descriptionStatus: CaenDescriptionStatus | null;
  readonly descriptions: readonly CaenCatalogDescription[];
  /** Always true: a derived selection, never a published principal activity. */
  readonly derived: true;
  readonly classKeyCount: number;
  readonly unqualifiedObservationCount: number;
  /** Exact number of public observation rows of the CUI (the aggregate, not the display list). */
  readonly observationCount: number;
  readonly caenCoverage: CompanyRegistryCoverage;
  readonly editionId: string;
  readonly editionSourceDate: string | null;
  readonly anafCode: string | null;
  readonly anafCodeForm: CompanyAnafCaenForm;
  /**
   * The CODE is usable: its form is admitted under `anafCaenFormPolicy` (the
   * database decides) AND it is not a placeholder (0000/9999). A placeholder
   * is never usable whatever its form (contract B.1).
   */
  readonly anafCodeUsable: boolean;
  readonly anafCaenFormPolicy: string | null;
  readonly anafStatusDate: string | null;
  readonly agreement: CompanyAnafOnrcAgreement;
}

// ─────────────────────────────────────────────────────────────────────────────
// The rule
// ─────────────────────────────────────────────────────────────────────────────

const ONRC_REVISION_RE = /^rev[0-3]$/u;
const CAEN_CODE_RE = /^[0-9]{4}$/u;

interface ClassKey {
  readonly revision: string;
  readonly code: string;
}

const invariant = (message: string): ApiError =>
  databaseError(`companies activity selection invariant violated: ${message}`);

/**
 * The served form of the function's text: `absent` without a fiscal row; a
 * value this API does not know is `unqualified` (fail closed). The form is
 * evidence only: usability is the database policy's `usable` flag.
 */
export const servedAnafForm = (fiscal: ActivityFiscalObservation | null): CompanyAnafCaenForm => {
  if (fiscal === null) return 'absent';
  const form = fiscal.form;
  if (form === null || form === 'absent') return 'unqualified';
  return (COMPANY_ANAF_CAEN_FORMS as readonly string[]).includes(form)
    ? (form as CompanyAnafCaenForm)
    : 'unqualified';
};

/** B.1: the ANAF / ONRC agreement, in contract order. */
export const anafOnrcAgreement = (
  keys: readonly ClassKey[],
  code: string | null,
  usable: boolean,
  hasFiscalRow: boolean
): CompanyAnafOnrcAgreement => {
  if (!hasFiscalRow || code === null) return 'anaf_missing';
  if (!usable) return 'anaf_not_usable';
  if (ANAF_PLACEHOLDER_CAEN_CODES.includes(code)) return 'anaf_placeholder';
  if (keys.length === 0) return 'no_class_key';
  const matches = keys.filter((key) => key.code === code).length;
  if (matches === 1) return 'match_one_key';
  return matches > 1 ? 'match_multiple_revisions' : 'differs';
};

/**
 * Derive the selection. Refused (typed ServiceUnavailable with
 * `ACTIVITY_AGGREGATE_BOUND_MESSAGE`) past the group bound; a value outside
 * the serving vocabulary is a release invariant (Database), never guessed.
 */
export const selectActivity = (
  input: ActivitySelectionInput
): Result<CompanyActivitySelection, ApiError> => {
  if (input.groups.length > ACTIVITY_AGGREGATE_GROUP_BOUND)
    return err(serviceUnavailable(ACTIVITY_AGGREGATE_BOUND_MESSAGE));

  const keys = new Map<string, ClassKey>();
  let observationCount = 0;
  let unqualifiedObservationCount = 0;
  for (const group of input.groups) {
    if (!isCompanyCaenClassState(group.classState))
      return err(invariant(`class state ${group.classState} is not in the serving vocabulary`));
    if (!Number.isSafeInteger(group.rows) || group.rows < 1)
      return err(invariant('an aggregate group has no rows'));
    observationCount += group.rows;
    if (group.classState !== 'class') {
      unqualifiedObservationCount += group.rows;
      continue;
    }
    const { revision, code } = group;
    if (revision === null || code === null || !ONRC_REVISION_RE.test(revision))
      return err(invariant('a class row has no known revision'));
    if (!CAEN_CODE_RE.test(code)) return err(invariant('a class row has no 4-digit code'));
    keys.set(`${revision}:${code}`, { revision, code });
  }
  const classKeys = [...keys.values()].sort((a, b) =>
    a.revision === b.revision ? (a.code < b.code ? -1 : 1) : a.revision < b.revision ? -1 : 1
  );

  const fiscal = input.fiscal;
  const anafCode = fiscal?.code ?? null;
  const form = servedAnafForm(fiscal);
  // The database policy decides the FORM; anything but an explicit true is
  // unusable. B.1 orders the agreement by that form usability; the exposed
  // CODE flag also excludes the placeholders.
  const usable = fiscal?.usable === true;
  const agreement = anafOnrcAgreement(classKeys, anafCode, usable, fiscal !== null);
  const codeUsable = usable && anafCode !== null && !ANAF_PLACEHOLDER_CAEN_CODES.includes(anafCode);
  const candidatesOf = (code: string): readonly CaenCatalogDescription[] =>
    input.catalog.get(code) ?? [];

  const evidence = {
    derived: true as const,
    classKeyCount: classKeys.length,
    unqualifiedObservationCount,
    observationCount,
    caenCoverage: input.caenCoverage,
    editionId: input.editionId,
    editionSourceDate: input.editionSourceDate,
    anafCode,
    anafCodeForm: form,
    anafCodeUsable: codeUsable,
    anafCaenFormPolicy: fiscal?.policy ?? null,
    anafStatusDate: fiscal?.statusDate ?? null,
    agreement,
  };
  const onrc = (basis: CompanyActivityBasis, key: ClassKey): CompanyActivitySelection => ({
    basis,
    source: 'ONRC',
    code: key.code,
    revision: key.revision,
    // The exact catalog row of the key's own revision; never another revision's.
    ...resolveCaenDescriptions(key.revision, candidatesOf(key.code)),
    ...evidence,
  });
  const none = (basis: CompanyActivityBasis): CompanyActivitySelection => ({
    basis,
    source: null,
    code: null,
    revision: null,
    label: null,
    descriptionStatus: null,
    descriptions: [],
    ...evidence,
  });

  const [single] = classKeys;
  if (classKeys.length === 1 && single !== undefined) return ok(onrc('onrc_single_class', single));
  if (classKeys.length >= 2) {
    const matched = classKeys.find((key) => key.code === anafCode);
    return ok(
      agreement === 'match_one_key' && matched !== undefined
        ? onrc('onrc_class_anaf_numeric_match', matched)
        : none('onrc_multiple_classes')
    );
  }
  if (agreement === 'no_class_key' && anafCode !== null) {
    // Catalogued is the database's one definition; the candidates are display
    // evidence only. ANAF publishes no revision: candidates, never an exact
    // label. An uncatalogued code is a source observation: never labelled.
    const catalogued = fiscal?.catalogued === true;
    return ok({
      basis: catalogued ? 'anaf_fiscal_code' : 'anaf_fiscal_uncatalogued',
      source: 'ANAF',
      code: anafCode,
      revision: null,
      ...(catalogued
        ? resolveCaenDescriptions(null, candidatesOf(anafCode))
        : { label: null, descriptionStatus: null, descriptions: [] }),
      ...evidence,
    });
  }
  return ok(none('no_qualified_selection'));
};

/** Every code whose catalog candidates `selectActivity` may need: the class codes and the ANAF code. */
export const activityCatalogCodes = (
  groups: readonly CaenClassStateGroup[],
  anafCode: string | null
): readonly string[] => {
  const codes = new Set<string>();
  for (const group of groups) {
    if (group.classState === 'class' && group.code !== null) codes.add(group.code);
  }
  if (anafCode !== null) codes.add(anafCode);
  return [...codes].sort();
};
