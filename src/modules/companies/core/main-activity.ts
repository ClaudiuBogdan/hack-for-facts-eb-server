/**
 * Companies module — the ANAF-ASSUMED main activity (scrapper migration
 * 20261013T220000; policy `anaf-assumed-main-caen-v1`). Pure: the served
 * vocabulary, the no-source shape, the scope gate, the class-flag attachment,
 * the witness a fresh recheck compares and the history cursor.
 *
 * What it is: the ANAF fiscal `cod_CAEN` of the company's current public
 * fiscal row, ASSUMED to be its main activity (a product assumption, never an
 * ONRC principal flag), matched as leading-zero-free digit TEXT to the
 * company's qualified ONRC CLASS keys of ONE pinned edition; the latest known
 * matching revision wins. ANAF's own revision stays unknown. Dates are
 * source / retrieval / derivation times, never legal effective dates.
 *
 * Read only from the four public views (`main_caen_current_assignments`,
 * `main_caen_class_flags`, `main_caen_public_resolutions`,
 * `main_caen_public_supports`). They decide currentness and source /
 * edition withdrawal at read time; this module never re-derives a main key,
 * never reads the 500-row observation list for it and never borrows a label.
 * On top of the views it applies the response's registry scope: ONRC-derived
 * fields only under a PUBLISHED scope, flags only for the pinned edition.
 */

import { serviceUnavailable, type ApiError, type BigIntString } from '@/modules/shared/index.js';

import { ONRC_TRIM_CODE_POINTS, isPublished, type CompanyRegistryEnvelope } from './registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary (the views' values; anything else fails closed)
// ─────────────────────────────────────────────────────────────────────────────

export const MAIN_ACTIVITY_CURRENTNESS = [
  'current',
  'pending_refresh',
  'source_withdrawn',
  'onrc_unavailable',
] as const;
export type CompanyMainActivityCurrentness = (typeof MAIN_ACTIVITY_CURRENTNESS)[number];

/** The class-flag view's currentness adds `no_assignment`. */
export const MAIN_FLAG_CURRENTNESS = [...MAIN_ACTIVITY_CURRENTNESS, 'no_assignment'] as const;
export type CompanyMainFlagCurrentness = (typeof MAIN_FLAG_CURRENTNESS)[number];

/** Served statuses (`out_of_scope` is never served by the public views). */
export const MAIN_ACTIVITY_STATUSES = [
  'resolved',
  'resolved_latest_revision',
  'no_onrc_match',
  'unresolved_token_form',
  'token_placeholder',
  'token_invalid',
  'source_missing',
  'source_unbound',
  'corrected',
  'correction_withheld',
] as const;
export type CompanyMainActivityStatus = (typeof MAIN_ACTIVITY_STATUSES)[number];

/** The statuses that carry a selected exact ONRC class key. */
export const MAIN_ACTIVITY_SELECTING_STATUSES: readonly CompanyMainActivityStatus[] = [
  'resolved',
  'resolved_latest_revision',
  'corrected',
];

export const MAIN_ACTIVITY_ROLE_BASES = ['anaf_assumed_main'] as const;
export type CompanyMainActivityRoleBasis = (typeof MAIN_ACTIVITY_ROLE_BASES)[number];

export const MAIN_ACTIVITY_MATCH_BASES = ['exact', 'leading_zero_match'] as const;
export type CompanyMainActivityMatchBasis = (typeof MAIN_ACTIVITY_MATCH_BASES)[number];

export const MAIN_ACTIVITY_REVISION_BASES = [
  'unique_onrc_match',
  'latest_matching_onrc_revision',
  'reviewed_correction',
] as const;
export type CompanyMainActivityRevisionBasis = (typeof MAIN_ACTIVITY_REVISION_BASES)[number];

export const MAIN_ACTIVITY_TOKEN_FORMS = [
  'four_digit',
  'other_digit_form',
  'zero_placeholder',
  'placeholder_9999',
  'invalid',
  'absent',
] as const;
export type CompanyMainActivityTokenForm = (typeof MAIN_ACTIVITY_TOKEN_FORMS)[number];

export const MAIN_ACTIVITY_JSON_TYPES = [
  'string',
  'number',
  'null',
  'absent',
  'boolean',
  'object',
  'array',
] as const;
export type CompanyMainActivityJsonType = (typeof MAIN_ACTIVITY_JSON_TYPES)[number];

export const MAIN_ACTIVITY_EVIDENCE_CUSTODIES = [
  'archived_exchange',
  'retained_custody',
  'pointer_bound_at_derivation',
  'unbound_at_derivation',
] as const;
export type CompanyMainActivityEvidenceCustody = (typeof MAIN_ACTIVITY_EVIDENCE_CUSTODIES)[number];

/** The v3 form diagnoses `anaf_v3_form` may carry; any other text is never served. */
export const MAIN_ACTIVITY_V3_FORMS: readonly string[] = [
  'four_digit',
  'three_digit',
  'short',
  'missing',
  'invalid',
  'unbound',
  'unqualified',
];

const TRIM_CLASS = ONRC_TRIM_CODE_POINTS.map((cp) => `\\u{${cp.toString(16)}}`).join('');
const TRIM_EDGES = new RegExp(`^[${TRIM_CLASS}]+|[${TRIM_CLASS}]+$`, 'gu');
const ASCII_DIGITS = /^[0-9]+$/u;
/** The public token's length bound (the data projection's `main_caen_public_token`). */
export const MAIN_PUBLIC_TOKEN_MAX_LENGTH = 32;

/**
 * The PUBLIC projection of an original ANAF token, the API's own defense
 * mirroring the data view (`main_caen_public_token`): the token only when it
 * is an economic-code digit form — a JSON string or number whose ECMAScript-
 * trimmed text is ASCII digits with at most four significant digits, at most
 * 32 characters (610, 0610, 000610, 9999, 0000) — else null. Anything else
 * (an object, an array, contact-like text, a phone-like number) is never
 * served; its JSON type and token form stay as diagnostics. Never logged.
 */
export const publicMainToken = (jsonType: string | null, token: string | null): string | null => {
  if (token === null || (jsonType !== 'string' && jsonType !== 'number')) return null;
  if (token.length > MAIN_PUBLIC_TOKEN_MAX_LENGTH) return null;
  const trimmed = token.replace(TRIM_EDGES, '');
  if (!ASCII_DIGITS.test(trimmed)) return null;
  return trimmed.replace(/^0+/u, '').length <= 4 ? token : null;
};

/** The main policy this reader serves; any other is refused (never reinterpreted). */
export const MAIN_ACTIVITY_POLICY_V1 = 'anaf-assumed-main-caen-v1';
export const MAIN_ACTIVITY_POLICIES = [MAIN_ACTIVITY_POLICY_V1] as const;
export type CompanyMainActivityPolicy = (typeof MAIN_ACTIVITY_POLICIES)[number];

/**
 * Null when visible evidence WITHOUT a fiscal source (no source snapshot) is
 * exactly the no-source shape — every other exposed ANAF field null: the
 * locators and dates, raw capture / custody ids, custody, token and JSON type
 * (and, on the current read, token form, digits, assumed code and v3 form) —
 * else which fields a partial shape carries.
 * Never judged from the outcome status: SOURCE_MISSING also names a real
 * fiscal row with an absent token, and a reviewed correction or an ONRC mask
 * may stand without fiscal evidence. Names only, never values.
 */
export const absentEvidenceProblem = (fields: Readonly<Record<string, unknown>>): string | null => {
  const carried = Object.keys(fields).filter((name) => fields[name] !== null);
  return carried.length === 0 ? null : `absent fiscal source carrying ${carried.join(', ')}`;
};

/** A label is the catalog's exact label of the selected key, frozen when derived. */
export const MAIN_ACTIVITY_LABEL_SOURCE = 'frozen_at_derivation' as const;

/** `<revision>:<code>` of a known ONRC revision (the view's `candidate_keys` form). */
const MAIN_KEY_RE = /^(rev[0-3]):([0-9]{4})$/u;
const REVISION_RE = /^rev[0-3]$/u;
const CODE_RE = /^[0-9]{4}$/u;

export const isMainRevision = (value: string): boolean => REVISION_RE.test(value);
export const isMainCode = (value: string): boolean => CODE_RE.test(value);

/** One of a fixed vocabulary, else null (the caller fails closed). */
export const oneOf = <T extends string>(vocabulary: readonly T[], value: unknown): T | null =>
  typeof value === 'string' && (vocabulary as readonly string[]).includes(value)
    ? (value as T)
    : null;

// ─────────────────────────────────────────────────────────────────────────────
// Served shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface CompanyMainActivityKey {
  readonly revision: string;
  readonly code: string;
  readonly label: string;
  readonly labelSource: typeof MAIN_ACTIVITY_LABEL_SOURCE;
}

export interface CompanyMainActivityCandidateKey {
  readonly revision: string;
  readonly code: string;
}

export interface CompanyMainActivityEdition {
  readonly editionId: BigIntString;
  /** ONRC's publication date of the edition's source files (civil date). */
  readonly sourcePublishedAt: string | null;
  /** The company's ONRC CAEN coverage in that edition (diagnostic text). */
  readonly caenCoverage: string | null;
}

/** ANAF evidence of the current assignment; null as a whole under `source_withdrawn`. */
export interface CompanyMainActivityAnafEvidence {
  readonly originalToken: string | null;
  readonly jsonType: CompanyMainActivityJsonType | null;
  readonly tokenForm: CompanyMainActivityTokenForm | null;
  /** Leading-zero-free digits; null when not a digit token or all zeros. */
  readonly canonicalDigits: string | null;
  /** A bound FOUR_DIGIT original only; never a padded code. */
  readonly assumedCode: string | null;
  readonly v3Form: string | null;
  /** ANAF requested fiscal-status date. Not a legal effective date. */
  readonly statusDate: string | null;
  /** The fiscal loader's retrieval time. Not a raw capture time. */
  readonly retrievedAt: string | null;
  readonly sourceUrl: string | null;
  readonly sourceSnapshotId: string | null;
  readonly sourceHash: string | null;
  readonly rawCaptureId: BigIntString | null;
  readonly rawCustodyId: BigIntString | null;
  readonly evidenceCustody: CompanyMainActivityEvidenceCustody | null;
}

export interface CompanyMainActivity {
  readonly policy: CompanyMainActivityPolicy;
  readonly basis: CompanyMainActivityRoleBasis;
  readonly currentness: CompanyMainActivityCurrentness;
  /**
   * The company's fiscal row is no longer public: `anaf` is null as a whole,
   * also when `currentness` reports `onrc_unavailable` first.
   */
  readonly anafWithdrawn: boolean;
  /**
   * The served fiscal source is under an integrity hold (an authenticated
   * contradiction proved it corrupt): never `current` (`pending_refresh`, or
   * `onrc_unavailable` / `source_withdrawn`, which the view reports first),
   * the interpretation and the token-derived ANAF fields suppressed, no flag.
   */
  readonly integrityHeld: boolean;
  /**
   * Null under `source_withdrawn` / `onrc_unavailable`, and under
   * `pending_refresh` when the interpretation is withheld (a source
   * integrity hold): then every interpretation field is null too.
   */
  readonly status: CompanyMainActivityStatus | null;
  readonly matchBasis: CompanyMainActivityMatchBasis | null;
  readonly revisionBasis: CompanyMainActivityRevisionBasis | null;
  readonly resolved: CompanyMainActivityKey | null;
  /** Latest revision first; null when the interpretation is suppressed. */
  readonly candidates: readonly CompanyMainActivityCandidateKey[] | null;
  readonly correctionId: BigIntString | null;
  readonly anaf: CompanyMainActivityAnafEvidence | null;
  /** Null under `onrc_unavailable`. */
  readonly edition: CompanyMainActivityEdition | null;
  /** Derivation time of the outcome; never a legal effective date. */
  readonly derivedAt: string;
  /** Derivation time of the current evidence. */
  readonly evidenceAt: string;
  readonly refreshedAt: string;
  readonly resolutionId: BigIntString;
  readonly supportId: BigIntString;
  readonly refreshId: BigIntString;
  readonly contentEpoch: BigIntString;
  /** Opaque client cache identity (see `mainActivityCacheKey`). */
  readonly cacheKey: string;
}

export type CompanyMainActivityAvailability = 'assigned' | 'no_assignment' | 'unavailable';

export type CompanyMainActivityRead =
  | {
      readonly availability: 'assigned';
      readonly reason: null;
      readonly activity: CompanyMainActivity;
    }
  | {
      readonly availability: 'no_assignment' | 'unavailable';
      readonly reason: string;
      readonly activity: null;
    };

export const MAIN_ACTIVITY_NO_ASSIGNMENT_REASON =
  'no ANAF-assumed main activity has been derived for this company yet; this is not "no main activity"';

export const MAIN_ACTIVITY_UNAVAILABLE_REASON =
  'the main-activity surfaces are not readable by this runtime (not deployed or not granted); nothing is inferred';

export const MAIN_ACTIVITY_MOVED_MESSAGE = 'the main activity changed during the request; retry';

export const mainActivityMoved = (): ApiError => serviceUnavailable(MAIN_ACTIVITY_MOVED_MESSAGE);

/** One authorized ONRC class key of the ACTIVE edition, as the flag view states it. */
export interface CompanyMainClassFlag {
  readonly revision: string;
  readonly code: string;
  readonly isMainCaen: boolean | null;
  readonly matchesAssumedMainCode: boolean | null;
  readonly currentness: CompanyMainFlagCurrentness;
  readonly resolutionId: BigIntString | null;
  readonly editionId: BigIntString;
}

/**
 * The company's assignment as the view states it (before the response's
 * scope gate). `witness` is the digest of the WHOLE public row: any change
 * of what the view serves — ids, epoch, currentness, a source withdrawal or
 * an integrity masking — changes it. `unavailable` = this runtime cannot
 * read the assignment view.
 */
export type CompanyMainAssignmentRead =
  | { readonly state: 'unavailable' }
  | { readonly state: 'none' }
  | {
      readonly state: 'row';
      readonly activity: CompanyMainActivity;
      readonly witness: string;
    };

/**
 * The company's class flags, read only when a flag was selected, in the
 * same statement (snapshot) as the assignment. Their availability is
 * independent of the assignment's: a missing / denied flag view or a list
 * past its bound leaves every flag null (unknown) and the main activity
 * itself served.
 */
export type CompanyMainFlagsRead =
  | { readonly state: 'not_requested' | 'unavailable' | 'overflow' }
  | { readonly state: 'read'; readonly flags: readonly CompanyMainClassFlag[] };

export interface CompanyMainActivityEvidence {
  readonly assignment: CompanyMainAssignmentRead;
  readonly flags: CompanyMainFlagsRead;
}

/** The class-key bound of one company's flag read (the activity aggregate's bound). */
export const MAIN_CLASS_FLAG_BOUND = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// Witness and cache key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a fresh recheck compares: the assignment read's state and, for a row,
 * the digest of the whole public row (`unavailable` | `none` | `a:<digest>`).
 * Flag availability is deliberately not part of it: a flag view this runtime
 * cannot read is not a movement of the main activity. Equal witnesses = the
 * served main facts still hold (the flags derive from the same row and the
 * edition the registry recheck already guards).
 */
export const mainActivityWitness = (evidence: CompanyMainActivityEvidence): string =>
  evidence.assignment.state === 'row' ? evidence.assignment.witness : evidence.assignment.state;

/**
 * The client cache identity of served main facts: the whole-row digest
 * (content epoch, resolution, support, currentness, refresh, edition AND
 * every visibility masking, e.g. a source withdrawal under ONRC_UNAVAILABLE
 * or an integrity hold), plus the response's own scope gate.
 */
export const mainActivityCacheKey = (rowWitness: string, gate: string | null = null): string =>
  gate === null ? `main-v2:${rowWitness}` : `main-v2:${rowWitness}:${gate}`;

// ─────────────────────────────────────────────────────────────────────────────
// Scope gate and flags
// ─────────────────────────────────────────────────────────────────────────────

/** The interpretation and ONRC fields suppressed, ANAF evidence kept. */
const withoutOnrc = (
  a: CompanyMainActivity,
  currentness: CompanyMainActivityCurrentness
): CompanyMainActivity => ({
  ...a,
  currentness,
  status: null,
  matchBasis: null,
  revisionBasis: null,
  resolved: null,
  candidates: null,
  correctionId: null,
  edition: null,
  cacheKey: `${a.cacheKey}:scope-${currentness}`,
});

/**
 * The served main activity under the response's registry scope:
 *  - not PUBLISHED: no ONRC-derived field (the profile serves no ONRC fact
 *    either); `onrc_unavailable` unless the view already withdrew the source;
 *  - `current` only when the assignment's edition IS the pinned edition (a
 *    publication that moved between the pin and the read is never current
 *    here; the registry recheck refuses or re-pins it anyway).
 */
export const gateMainActivity = (
  evidence: CompanyMainActivityEvidence,
  scope: CompanyRegistryEnvelope
): CompanyMainActivityRead => {
  const assignment = evidence.assignment;
  if (assignment.state === 'unavailable') {
    return {
      availability: 'unavailable',
      reason: MAIN_ACTIVITY_UNAVAILABLE_REASON,
      activity: null,
    };
  }
  if (assignment.state === 'none') {
    return {
      availability: 'no_assignment',
      reason: MAIN_ACTIVITY_NO_ASSIGNMENT_REASON,
      activity: null,
    };
  }
  const a = assignment.activity;
  if (!isPublished(scope)) {
    const activity =
      a.currentness === 'source_withdrawn'
        ? withoutOnrc(a, 'source_withdrawn')
        : withoutOnrc(a, 'onrc_unavailable');
    return { availability: 'assigned', reason: null, activity };
  }
  if (a.currentness === 'current' && a.edition?.editionId !== scope.editionId) {
    return {
      availability: 'assigned',
      reason: null,
      activity: {
        ...a,
        currentness: 'pending_refresh',
        cacheKey: `${a.cacheKey}:scope-pending_refresh`,
      },
    };
  }
  return { availability: 'assigned', reason: null, activity: a };
};

/** The two main flags of a served activity row. */
export interface CompanyMainActivityFlags {
  readonly isMainCaen: boolean | null;
  readonly matchesAssumedMainCode: boolean | null;
}

/** What a flag attachment needs of an activity row (`CompanyCaenActivity`). */
export interface MainFlaggableActivity {
  readonly code: string;
  readonly rev: string | null;
  readonly source: string;
  readonly classState: string | null;
}

/**
 * Attach the flags to the profile's activity rows. A flag is non-null only
 * on an ONRC `class` row of the PINNED edition, while the gated assignment
 * is `current` and the flag row belongs to the same resolution and edition;
 * `isMainCaen` true only on the selected exact key. The ANAF row, a short
 * token, an unknown revision or an unlabeled key never carries one, also
 * when its digits match. A class row the flag view does not list stays
 * null (unknown), never false.
 */
export const attachMainFlags = <T extends MainFlaggableActivity>(
  activities: readonly T[],
  read: CompanyMainActivityRead | null,
  flags: readonly CompanyMainClassFlag[],
  scope: CompanyRegistryEnvelope
): readonly (T & CompanyMainActivityFlags)[] => {
  const a = read?.activity ?? null;
  const live =
    a !== null &&
    isPublished(scope) &&
    a.currentness === 'current' &&
    a.edition?.editionId === scope.editionId;
  const byKey = new Map<string, CompanyMainClassFlag>();
  if (live) {
    for (const flag of flags) {
      if (
        flag.currentness === 'current' &&
        flag.editionId === scope.editionId &&
        flag.resolutionId === a.resolutionId
      ) {
        byKey.set(`${flag.revision}:${flag.code}`, flag);
      }
    }
  }
  return activities.map((row) => {
    const flag =
      row.source === 'onrc' && row.classState === 'class' && row.rev !== null
        ? byKey.get(`${row.rev}:${row.code}`)
        : undefined;
    if (flag === undefined || a === null) {
      return { ...row, isMainCaen: null, matchesAssumedMainCode: null };
    }
    const selected =
      a.resolved !== null && a.resolved.revision === flag.revision && a.resolved.code === flag.code;
    return {
      ...row,
      // The view and the selected key must agree; a disagreement is unknown.
      isMainCaen: flag.isMainCaen === null || flag.isMainCaen !== selected ? null : selected,
      matchesAssumedMainCode: flag.matchesAssumedMainCode,
    };
  });
};

/** Parse the view's `candidate_keys` (`rev3:4711`); null on any malformed key (fail closed). */
export const parseCandidateKeys = (
  keys: readonly string[]
): readonly CompanyMainActivityCandidateKey[] | null => {
  const out: CompanyMainActivityCandidateKey[] = [];
  for (const key of keys) {
    const match = MAIN_KEY_RE.exec(key);
    if (match === null) return null;
    const [, revision, code] = match;
    if (revision === undefined || code === undefined) return null;
    out.push({ revision, code });
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────────

export type CompanyMainActivityHistoryKind = 'outcomes' | 'evidence';

export const MAIN_HISTORY_DEFAULT_PAGE = 20;
export const MAIN_HISTORY_MAX_PAGE = 50;

export const MAIN_HISTORY_NOTE =
  'Derivation and source-observation history of the ANAF-assumed main activity (newest first): when this API derived an outcome or recorded evidence, with the ANAF requested status date and the ONRC edition it was read under. Never legal effective dates.';

export interface CompanyMainActivityOutcomeAnaf {
  readonly originalToken: string | null;
  readonly jsonType: CompanyMainActivityJsonType | null;
  readonly tokenForm: CompanyMainActivityTokenForm | null;
  readonly canonicalDigits: string | null;
  readonly assumedCode: string | null;
}

export interface CompanyMainActivityOutcome {
  readonly resolutionId: BigIntString;
  readonly previousResolutionId: BigIntString | null;
  readonly refreshId: BigIntString;
  readonly reasons: readonly string[];
  readonly policy: CompanyMainActivityPolicy;
  /** Kept when ANAF is withdrawn (its evidence is what is withheld). */
  readonly basis: CompanyMainActivityRoleBasis;
  readonly status: CompanyMainActivityStatus | null;
  readonly revisionBasis: CompanyMainActivityRevisionBasis | null;
  readonly matchBasis: CompanyMainActivityMatchBasis | null;
  /** Null when `anafWithdrawn`. */
  readonly anaf: CompanyMainActivityOutcomeAnaf | null;
  readonly editionId: BigIntString | null;
  readonly candidates: readonly CompanyMainActivityCandidateKey[] | null;
  readonly resolved: CompanyMainActivityKey | null;
  readonly correctionId: BigIntString | null;
  readonly derivedAt: string;
  readonly anafWithdrawn: boolean;
  readonly onrcWithdrawn: boolean;
}

export interface CompanyMainActivityEvidenceAnaf {
  readonly sourceSnapshotId: string | null;
  readonly sourceHash: string | null;
  readonly statusDate: string | null;
  readonly retrievedAt: string | null;
  readonly sourceUrl: string | null;
  readonly rawCaptureId: BigIntString | null;
  readonly rawCustodyId: BigIntString | null;
  readonly evidenceCustody: CompanyMainActivityEvidenceCustody | null;
  readonly originalToken: string | null;
  readonly jsonType: CompanyMainActivityJsonType | null;
}

export interface CompanyMainActivityEvidenceEntry {
  readonly supportId: BigIntString;
  readonly previousSupportId: BigIntString | null;
  readonly resolutionId: BigIntString;
  readonly refreshId: BigIntString;
  readonly editionId: BigIntString | null;
  /** Null when `anafWithdrawn`. */
  readonly anaf: CompanyMainActivityEvidenceAnaf | null;
  readonly caenCoverage: string | null;
  readonly evidenceAt: string;
  readonly anafWithdrawn: boolean;
  readonly onrcWithdrawn: boolean;
}

/** One history page as the repository read it (`limit + 1` rows decide `hasNextPage`). */
export type CompanyMainActivityHistoryRows =
  | { readonly state: 'unavailable' }
  | {
      readonly state: 'read';
      readonly outcomes: readonly CompanyMainActivityOutcome[];
      readonly evidence: readonly CompanyMainActivityEvidenceEntry[];
    };

export interface CompanyMainActivityHistoryPage {
  readonly state: 'available' | 'unavailable';
  readonly reason: string | null;
  readonly kind: CompanyMainActivityHistoryKind;
  readonly outcomes: readonly CompanyMainActivityOutcome[];
  readonly evidence: readonly CompanyMainActivityEvidenceEntry[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly registry: CompanyRegistryEnvelope;
  readonly note: string;
}

/**
 * History under the response's scope: without a PUBLISHED registry scope no
 * ONRC-derived field is served (`onrcWithdrawn` true: not served in this
 * scope). The views already applied source and edition withdrawal.
 */
export const gateOutcome = (
  o: CompanyMainActivityOutcome,
  scope: CompanyRegistryEnvelope
): CompanyMainActivityOutcome =>
  isPublished(scope)
    ? o
    : {
        ...o,
        status: null,
        revisionBasis: null,
        matchBasis: null,
        editionId: null,
        candidates: null,
        resolved: null,
        correctionId: null,
        onrcWithdrawn: true,
      };

export const gateEvidenceEntry = (
  e: CompanyMainActivityEvidenceEntry,
  scope: CompanyRegistryEnvelope
): CompanyMainActivityEvidenceEntry =>
  isPublished(scope) ? e : { ...e, editionId: null, caenCoverage: null, onrcWithdrawn: true };

const CURSOR_PREFIX = 'mh1';
const CURSOR_ID_RE = /^[1-9][0-9]{0,18}$/u;

/** An opaque continuation bound to the CUI and the history kind. */
export const encodeHistoryCursor = (
  cui: string,
  kind: CompanyMainActivityHistoryKind,
  lastId: string
): string => Buffer.from(`${CURSOR_PREFIX}:${kind}:${cui}:${lastId}`, 'utf8').toString('base64url');

/** The last id of the previous page, or null for a cursor this API did not issue for (cui, kind). */
export const decodeHistoryCursor = (
  cursor: string,
  cui: string,
  kind: CompanyMainActivityHistoryKind
): string | null => {
  if (!/^[A-Za-z0-9_-]{1,200}$/u.test(cursor)) return null;
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  if (parts.length !== 4) return null;
  const [prefix, cursorKind, cursorCui, lastId] = parts as [string, string, string, string];
  if (prefix !== CURSOR_PREFIX || cursorKind !== kind || cursorCui !== cui) return null;
  if (!CURSOR_ID_RE.test(lastId) || BigInt(lastId) > 9223372036854775807n) return null;
  return lastId;
};
