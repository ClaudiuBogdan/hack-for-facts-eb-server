/**
 * Companies module — the ONRC registry edition contract as this API reads it
 * (scrapper migration 20261003T172000, public views only). Pure: types, the
 * scope key, input normalization, qualified-scalar adapters and the
 * pin-once / recheck / retry-once orchestration over the repository port.
 *
 * One operation pins ONE registry scope (`captureRegistryScope`) and binds
 * every ONRC read to its `edition_id` through the `onrc_published_*` views,
 * never through the `onrc_current_*` views, so a publication or rollback
 * between two reads cannot mix editions. Before returning, the operation
 * rechecks fresh (`confirmRegistryScope`): the publication state, edition,
 * publication epoch and access (privacy) epoch are unchanged, and no
 * returned CUI now has a non-public core organization. A moved scope is
 * retried once with a new pin, then answered as unavailable.
 *
 * States are not counts: `unpublished` (no active edition), `withdrawn` (the
 * active edition is not publicly accessible: access withdrawn or outside the
 * accepted privacy policy) and `unavailable` (this runtime cannot read the
 * publication: migration or grant missing) never read as an empty edition
 * and never fall back to legacy registry rows. A CUI without a published
 * qualified profile in the pinned edition is `not_in_edition`: no qualified
 * public profile in that edition, never "not legally registered".
 */

import { err, ok, type Result } from 'neverthrow';

import {
  serviceUnavailable,
  type ApiError,
  type BigIntString,
  type FilterInput,
  type IsoDate,
} from '@/modules/shared/index.js';

import { COMPANY_REGISTRY_FILTER_FIELDS, COMPANY_STATUS_NOMENCLATURE } from './filters.js';

// ─────────────────────────────────────────────────────────────────────────────
// Envelope and scope
// ─────────────────────────────────────────────────────────────────────────────

export type CompanyRegistryState = 'published' | 'unpublished' | 'withdrawn' | 'unavailable';

/**
 * The registry envelope every ONRC-bearing response carries, empty results
 * included. Epochs and the edition id are bigint decimal strings.
 */
export interface CompanyRegistryEnvelope {
  readonly source: 'onrc';
  readonly state: CompanyRegistryState;
  /** The pinned edition; null unless `published`. */
  readonly editionId: BigIntString | null;
  readonly sourceSnapshotId: string | null;
  /** ONRC's publication date of the edition's source files (civil date). */
  readonly sourcePublishedAt: IsoDate | null;
  readonly interpretationVersion: string | null;
  readonly dimensionPolicyVersion: string | null;
  /**
   * The legal-person eligibility policy every profile of the edition
   * carries (the seal guarantees one per edition). Read from the profiles:
   * the publication envelope view does not expose it. Null when the edition
   * shows no public profile.
   */
  readonly eligibilityPolicyVersion: string | null;
  /** `onrc_publication.epoch`: moves on every publish, rollback and access withdrawal. */
  readonly publicationEpoch: BigIntString | null;
  /** `companies_analytics.privacy_state.epoch`: every ONRC event and public-company privacy change moves it. */
  readonly accessEpoch: BigIntString | null;
  /** Fixed text when not `published`. */
  readonly reason: string | null;
}

export const REGISTRY_UNAVAILABLE_REASON =
  'the ONRC registry publication is not readable by this runtime (migration or grant missing)';

export const unavailableRegistry = (reason: string = REGISTRY_UNAVAILABLE_REASON) =>
  ({
    source: 'onrc',
    state: 'unavailable',
    editionId: null,
    sourceSnapshotId: null,
    sourcePublishedAt: null,
    interpretationVersion: null,
    dimensionPolicyVersion: null,
    eligibilityPolicyVersion: null,
    publicationEpoch: null,
    accessEpoch: null,
    reason,
  }) satisfies CompanyRegistryEnvelope;

/** The state reason the API states for each non-published view state. */
export const REGISTRY_STATE_REASON: Readonly<Record<CompanyRegistryState, string | null>> = {
  published: null,
  unpublished: 'no ONRC edition is published (not an empty registry)',
  withdrawn:
    'the active ONRC edition is not publicly accessible (access withdrawn or outside the accepted privacy policy)',
  unavailable: REGISTRY_UNAVAILABLE_REASON,
};

/**
 * Opaque, stable key of a pinned scope. Cursors, MCP page bindings and the
 * hub cache compare it; any publication or access event changes it.
 */
export const registryScopeKey = (scope: CompanyRegistryEnvelope): string =>
  [
    'onrc',
    scope.state,
    scope.editionId ?? '-',
    scope.publicationEpoch ?? '-',
    scope.accessEpoch ?? '-',
  ].join(':');

export const isPublished = (
  scope: CompanyRegistryEnvelope
): scope is CompanyRegistryEnvelope & { readonly state: 'published'; readonly editionId: string } =>
  scope.state === 'published' && scope.editionId !== null;

/** The answer to an operation whose ONRC part cannot be evaluated without a published edition. */
export const registryNotPublished = (scope: CompanyRegistryEnvelope, what: string): ApiError =>
  serviceUnavailable(
    `ONRC registry edition is ${scope.state}: ${what} cannot be evaluated (${scope.reason ?? 'no published edition'})`
  );

/** True when the input (or its exclude) carries an edition-bound field. */
export const usesRegistryFilters = (input: FilterInput): boolean => {
  const exclude = (input.exclude ?? {}) as Readonly<Record<string, unknown>>;
  return COMPANY_REGISTRY_FILTER_FIELDS.some(
    (name) => input[name] !== undefined || exclude[name] !== undefined
  );
};

/**
 * The refusal of registry criteria (an edition-bound filter field, then the
 * recorded-date sort) under a non-published scope; null when none applies.
 * The list usecase applies it before any empty shortcut and the repository
 * again before compiling SQL, with the same messages: a non-published
 * registry never answers registry criteria as a successful empty list.
 */
export const registryCriteriaRefusal = (
  input: FilterInput,
  sort: string,
  scope: CompanyRegistryEnvelope
): ApiError | null => {
  if (isPublished(scope)) return null;
  if (usesRegistryFilters(input)) return registryNotPublished(scope, 'registry filters');
  if (sort === 'registrationDate') return registryNotPublished(scope, 'recorded-date sorting');
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Recheck
// ─────────────────────────────────────────────────────────────────────────────

/** A fresh reading taken after the reads, before returning. */
export interface CompanyRegistryRecheck {
  /** The current publication; null when this runtime cannot read it (or its read footprint). */
  readonly current: Pick<
    CompanyRegistryEnvelope,
    'state' | 'editionId' | 'publicationEpoch' | 'accessEpoch'
  > | null;
  /**
   * Returned CUIs whose core organization is now known and not public. Only
   * ever a successful read: an unreadable organizations check is an error
   * (`COMPANY_ACCESS_UNREADABLE_MESSAGE`), never an empty list.
   */
  readonly privateCuis: readonly string[];
}

/**
 * The mandatory parent-privacy recheck could not be read (a missing relation,
 * column or grant on the core organizations). Unlike the optional ONRC
 * registry, it never degrades: the response is refused.
 */
export const COMPANY_ACCESS_UNREADABLE_MESSAGE =
  'company access (core organization privacy) could not be rechecked by this runtime; the response is withheld';

/**
 * A read lost the ONRC registry capability under its pin: a view, column or
 * grant of the registry read footprint became unreadable after the capture.
 * `runPinned` treats it as a moved scope: the attempt, with any partial
 * edition evidence, is discarded and the operation re-pins once (the next
 * capture probes the footprint and pins `unavailable` while it stays
 * unreadable); a second move is refused. Never served as an empty edition.
 */
export const REGISTRY_CAPABILITY_LOST_MESSAGE =
  'the ONRC registry became unreadable during the request; retry';

export const registryCapabilityLost = (): ApiError =>
  serviceUnavailable(REGISTRY_CAPABILITY_LOST_MESSAGE);

export const isRegistryCapabilityLost = (error: ApiError): boolean =>
  error.type === 'ServiceUnavailable' && error.message === REGISTRY_CAPABILITY_LOST_MESSAGE;

/** True when the reads were taken under a scope that still holds, for these CUIs. */
export const scopeStillHolds = (
  scope: CompanyRegistryEnvelope,
  recheck: CompanyRegistryRecheck
): boolean => {
  if (recheck.privateCuis.length > 0) return false;
  if (scope.state === 'unavailable') {
    // Nothing ONRC was read; a now-readable publication is the next pin's concern.
    return true;
  }
  const current = recheck.current;
  return (
    current !== null &&
    current.state === scope.state &&
    current.editionId === scope.editionId &&
    current.publicationEpoch === scope.publicationEpoch &&
    current.accessEpoch === scope.accessEpoch
  );
};

/** The repository half the orchestration needs. */
export interface CompanyRegistryScopePort {
  captureRegistryScope(): Promise<Result<CompanyRegistryEnvelope, ApiError>>;
  confirmRegistryScope(
    scope: CompanyRegistryEnvelope,
    cuis: readonly string[]
  ): Promise<Result<CompanyRegistryRecheck, ApiError>>;
}

export interface Pinned<T> {
  readonly value: T;
  readonly scope: CompanyRegistryEnvelope;
}

export const REGISTRY_MOVED_MESSAGE =
  'the ONRC registry publication or company access changed during the request; retry';

/**
 * The errors by which the registry guard refuses an operation: a scope that
 * moved (publication, rollback, withdrawal, access epoch, a returned CUI's
 * organization no longer public, a capability lost twice) or an unreadable
 * parent-privacy check. A composing response withholds what it owns on one,
 * never degrading the refusing part to "absent".
 */
export const isRegistryGuardRefusal = (error: ApiError): boolean =>
  error.type === 'ServiceUnavailable' &&
  (error.message === REGISTRY_MOVED_MESSAGE || error.message === COMPANY_ACCESS_UNREADABLE_MESSAGE);

/**
 * The final decision for facts ALREADY served under `scope` for `cuis`: ok
 * while that scope still holds and no CUI's organization turned non-public,
 * else the guard refusal. No retry: what was served cannot be re-read.
 */
export const confirmServedScope = async (
  port: CompanyRegistryScopePort,
  scope: CompanyRegistryEnvelope,
  cuis: readonly string[]
): Promise<Result<void, ApiError>> => {
  const recheck = await port.confirmRegistryScope(scope, cuis);
  if (recheck.isErr()) return err(recheck.error);
  return scopeStillHolds(scope, recheck.value)
    ? ok(undefined)
    : err(serviceUnavailable(REGISTRY_MOVED_MESSAGE));
};

/** PostgreSQL `bigint` upper bound: no captured id or epoch exceeds it. */
const PG_BIGINT_MAX = 9223372036854775807n;

/**
 * A canonical `bigint::text` of at least `min`: digits only, no sign, no
 * leading zero (`0` itself when `min` is 0), within `bigint`.
 */
const isCanonicalBigint = (text: string, min: bigint): boolean =>
  /^(?:0|[1-9][0-9]{0,18})$/u.test(text) && BigInt(text) >= min && BigInt(text) <= PG_BIGINT_MAX;

/**
 * The scope a key this API issued names: its state, edition and epochs (all a
 * recheck compares); null for any other text. Only the shapes the capture and
 * `unavailableRegistry` emit are accepted:
 *  - `onrc:unavailable:-:-:-` (nothing readable);
 *  - `onrc:published:<edition>:<publication epoch>:<access epoch>`, a positive
 *    edition id (an identity) and epochs >= 0 (the columns' CHECKs);
 *  - `onrc:unpublished|withdrawn:-:<publication epoch>:<access epoch>`, no
 *    edition and both captured epochs.
 * Every part is a canonical `bigint::text`. For facts that carry only the key
 * (a presence's attributes), never as a new pin.
 */
export const scopeFromKey = (key: string): CompanyRegistryEnvelope | null => {
  const parts = key.split(':');
  if (parts.length !== 5) return null;
  const [source, state, editionId, publicationEpoch, accessEpoch] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (source !== 'onrc') return null;
  if (state === 'unavailable') {
    return editionId === '-' && publicationEpoch === '-' && accessEpoch === '-'
      ? unavailableRegistry()
      : null;
  }
  if (state !== 'published' && state !== 'unpublished' && state !== 'withdrawn') return null;
  const editionHolds = state === 'published' ? isCanonicalBigint(editionId, 1n) : editionId === '-';
  if (
    !editionHolds ||
    !isCanonicalBigint(publicationEpoch, 0n) ||
    !isCanonicalBigint(accessEpoch, 0n)
  ) {
    return null;
  }
  return {
    ...unavailableRegistry(),
    state,
    editionId: state === 'published' ? editionId : null,
    publicationEpoch,
    accessEpoch,
    reason: REGISTRY_STATE_REASON[state],
  };
};

/**
 * Run `read` under one pinned scope and recheck before returning. A moved
 * scope (publication, rollback, withdrawal, an access epoch move, a returned
 * CUI whose organization stopped being public, or a registry capability lost
 * during the read) is retried once under a new pin; a second move is
 * `ServiceUnavailable`. The recheck runs once, after EVERY async part of
 * `read`: an operation composing several reads puts all of them inside it.
 * `expectedKey` binds a continuation (cursor page) to the scope it started
 * under: a different scope refuses with `InvalidInput` instead of mixing
 * editions.
 */
export const runPinned = async <T>(
  port: CompanyRegistryScopePort,
  read: (scope: CompanyRegistryEnvelope) => Promise<Result<T, ApiError>>,
  cuisOf: (value: T) => readonly string[],
  options: { readonly expectedKey?: string; readonly scope?: CompanyRegistryEnvelope } = {}
): Promise<Result<Pinned<T>, ApiError>> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let scope: CompanyRegistryEnvelope;
    if (options.scope !== undefined) {
      scope = options.scope;
    } else {
      const captured = await port.captureRegistryScope();
      if (captured.isErr()) return err(captured.error);
      scope = captured.value;
    }
    if (options.expectedKey !== undefined && registryScopeKey(scope) !== options.expectedKey) {
      return err({
        type: 'InvalidInput',
        message:
          'company registry scope changed (publication, rollback, withdrawal or access); restart pagination',
        field: 'cursor',
      });
    }
    const res = await read(scope);
    if (res.isErr()) {
      if (!isRegistryCapabilityLost(res.error)) return err(res.error);
      // A moved scope: nothing of this attempt is returned. A handed-in
      // scope is refused below, never re-pinned.
      if (options.scope !== undefined) break;
      continue;
    }
    const recheck = await port.confirmRegistryScope(scope, cuisOf(res.value));
    if (recheck.isErr()) return err(recheck.error);
    if (scopeStillHolds(scope, recheck.value)) return ok({ value: res.value, scope });
    // A scope handed in by the caller (a lazy field of an already pinned
    // parent) is not re-pinned: the parent's answer would mix editions.
    if (options.scope !== undefined) break;
  }
  return err(serviceUnavailable(REGISTRY_MOVED_MESSAGE));
};

// ─────────────────────────────────────────────────────────────────────────────
// Bases, coverage and evidence (the public view vocabulary)
// ─────────────────────────────────────────────────────────────────────────────

export const COMPANY_REGISTRY_BASES = [
  'single_observation',
  'consistent_observations',
  'partial_observations',
  'multiple_values',
  'missing',
  'unresolved',
] as const;
export type CompanyRegistryBasis = (typeof COMPANY_REGISTRY_BASES)[number];

export const COMPANY_REGISTRY_COVERAGES = [
  'complete',
  'complete_empty',
  'partial',
  'unresolved',
] as const;
export type CompanyRegistryCoverage = (typeof COMPANY_REGISTRY_COVERAGES)[number];

/** A CUI-level value with the basis that qualifies it; value null unless the basis admits one. */
export interface CompanyRegistryValue {
  readonly value: string | null;
  readonly basis: CompanyRegistryBasis;
}

/**
 * The pinned edition's qualified profile of one CUI. `recordedDate` is the
 * date ONRC recorded (civil date, day precision, no time zone): never a
 * founding date, an age or a legally current registration date.
 */
export interface CompanyRegistryCuiProfile {
  readonly identityObservations: number;
  readonly identifierCount: number;
  readonly unresolvedIdentifierCount: number;
  readonly unidentifiedObservations: number;
  readonly name: CompanyRegistryValue;
  readonly legalForm: CompanyRegistryValue;
  readonly recordedDate: CompanyRegistryValue;
  readonly countyCode: CompanyRegistryValue;
  /** Canonical county name from the territory hub (current presentation data, not edition evidence). */
  readonly countyName: string | null;
  readonly uatSirutaCode: CompanyRegistryValue;
  readonly uatName: string | null;
  /** Complete consensus of every resolved identifier; never a priority pick. */
  readonly statusCode: CompanyRegistryValue;
  readonly caenCoverage: CompanyRegistryCoverage;
  readonly statusCoverage: CompanyRegistryCoverage;
  readonly legalPersonEligibility: 'eligible' | 'excluded' | 'unresolved';
  readonly eligibilityReason: string | null;
  readonly eligibilityPolicyVersion: string;
}

/**
 * One public resolved identifier group (a lookup group of the normalized
 * observed registration identifier; not a legal alias and not a legal
 * registration entity). `statusCodes` is the PUBLIC code set; an original
 * public 1048 sets `hasActiveObservation`, also next to a conflicting code.
 */
export interface CompanyRegistryIdentifier {
  /** `<editionId>:<identifierKey>`. */
  readonly id: string;
  readonly identifierKey: string;
  readonly identityRowCount: number;
  readonly statusCodes: readonly string[];
  readonly hasActiveObservation: boolean;
  /** Presentation summary of ONE complete identifier; not the active filter or the CUI status. */
  readonly statusSummaryCode: string | null;
  readonly statusSummaryBasis: string;
  readonly statusObservations: number;
  readonly unparsedStatusObservations: number;
  readonly countyCodes: readonly string[];
  readonly countyBasis: string;
  readonly caenObservations: number;
  readonly unparsedCaenObservations: number;
  readonly unknownRevisionCaenObservations: number;
}

/** Safe public provenance of one original row, as the views permit it. */
export interface CompanyRegistryProvenance {
  readonly resourceKey: string;
  readonly sourceRowNumber: number;
  readonly sourceRowSha256: string;
  readonly sourceUrl: string | null;
  readonly sourceFileSha256: string | null;
  readonly sourcePublishedAt: IsoDate | null;
}

export interface CompanyRegistryIdentityObservation {
  /** `<editionId>:<resourceKey>:<sourceRowNumber>`. */
  readonly id: string;
  readonly identifierKey: string | null;
  readonly name: string | null;
  readonly euid: string | null;
  readonly legalForm: string | null;
  /** Civil date ONRC recorded on this row; never a founding date. */
  readonly recordedDate: IsoDate | null;
  /** date | datetime | blank | unparsed_shape | invalid_calendar | invalid_time. */
  readonly recordedDateState: string;
  /** Derived geography (only from an address that may contribute it). */
  readonly countyCode: string | null;
  readonly uatSirutaCode: string | null;
  readonly provenance: CompanyRegistryProvenance;
}

/** A catalog label: the current database catalog, never frozen in or observed by the edition. */
export interface CompanyCaenCatalogLabel {
  readonly label: string;
  /** The exact catalog system, `caen_<revision>`. */
  readonly system: string;
  readonly source: typeof CAEN_CATALOG_SOURCE;
}

export const CAEN_CATALOG_SOURCE = 'current_db_catalog' as const;

export interface CompanyRegistryCaenObservation {
  readonly id: string;
  readonly identifierKey: string;
  /** code | missing | invalid. */
  readonly parseState: string;
  readonly code: string | null;
  /** known | missing | invalid. */
  readonly revisionState: string;
  /** rev0..rev3 when known; an unknown revision gets no label. */
  readonly revision: string | null;
  readonly catalogLabel: CompanyCaenCatalogLabel | null;
  readonly provenance: CompanyRegistryProvenance;
}

export interface CompanyRegistryStatusObservation {
  readonly id: string;
  readonly identifierKey: string;
  readonly parseState: string;
  readonly code: string | null;
  /** The edition's frozen label; NULL until a source bundle binding is proved. */
  readonly label: string | null;
  readonly labelSource: string | null;
  readonly provenance: CompanyRegistryProvenance;
}

export type CompanyRegistryCuiState =
  'in_edition' | 'not_in_edition' | Exclude<CompanyRegistryState, 'published'>;

/** Registry evidence of one CUI in the pinned scope. */
export interface CompanyRegistryEvidence {
  readonly registry: CompanyRegistryEnvelope;
  readonly cuiState: CompanyRegistryCuiState;
  readonly profile: CompanyRegistryCuiProfile | null;
  readonly identifiers: readonly CompanyRegistryIdentifier[];
  readonly identityObservations: readonly CompanyRegistryIdentityObservation[];
  readonly caenObservations: readonly CompanyRegistryCaenObservation[];
  readonly statusObservations: readonly CompanyRegistryStatusObservation[];
  /** True when an observation list reached its bound (counts are on the profile/identifiers). */
  readonly observationsTruncated: boolean;
}

/** Evidence of a CUI when no edition is pinned (the envelope state, nothing else). */
export const noRegistryEvidence = (scope: CompanyRegistryEnvelope): CompanyRegistryEvidence => ({
  registry: scope,
  cuiState: scope.state === 'published' ? 'not_in_edition' : scope.state,
  profile: null,
  identifiers: [],
  identityObservations: [],
  caenObservations: [],
  statusObservations: [],
  observationsTruncated: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// Namespaces and selectors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The edition's qualified CUI namespace: 2-10 digits, no leading zero (the
 * `public_shape_2_10` token class). A CUI outside it (a held one-digit source
 * token such as 1 or 4, a leading-zero or longer token) is never linked to
 * edition evidence. This states the namespace, not legal validity.
 */
export const ONRC_QUALIFIED_CUI = /^[1-9][0-9]{1,9}$/u;
export const isOnrcQualifiedCui = (cui: string): boolean => ONRC_QUALIFIED_CUI.test(cui);

/**
 * The edition's identifier lookup key (scrapper `identifierKey`): every
 * ECMAScript white-space and line-terminator code point removed (the 25 code
 * points of `String.prototype.trim`), then `toUpperCase`; null when nothing
 * remains. No other conversion (no old/new number format inference).
 */
export const ONRC_TRIM_CODE_POINTS: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];
const ONRC_IDENTIFIER_SPACE = new RegExp(
  `[${ONRC_TRIM_CODE_POINTS.map((cp) => `\\u{${cp.toString(16)}}`).join('')}]`,
  'gu'
);
export const onrcIdentifierKey = (raw: string): string | null => {
  const key = raw.replace(ONRC_IDENTIFIER_SPACE, '').toUpperCase();
  return key === '' ? null : key;
};

/** Known ONRC CAEN revisions (rev0 included). */
export const ONRC_CAEN_REVISIONS = ['rev0', 'rev1', 'rev2', 'rev3'] as const;

/** An exact ONRC CAEN selector `<revision>:<code>`, e.g. `rev2:6201` or `rev0:1111`. */
export interface OnrcCaenSelector {
  readonly revision: string;
  readonly code: string;
}

const ONRC_CAEN_SELECTOR = /^(rev[0-3]):([0-9]{4})$/u;

export const parseOnrcCaenSelector = (raw: string): OnrcCaenSelector | null => {
  const match = ONRC_CAEN_SELECTOR.exec(raw.trim());
  if (match === null) return null;
  const [, revision, code] = match;
  return revision === undefined || code === undefined ? null : { revision, code };
};

export const onrcCaenKey = (revision: string, code: string): string => `${revision}:${code}`;

// ─────────────────────────────────────────────────────────────────────────────
// Compatibility adapters (qualified scalars only)
// ─────────────────────────────────────────────────────────────────────────────

/** Where a compatibility display text came from. */
export type CompanyStatusLabelSource = 'api_nomenclature' | 'code';

/**
 * A status for compatibility display: the code, and display text from this
 * API's static status nomenclature (or the code itself when the code is not
 * in it). Never an ONRC-observed label.
 */
export const compatStatus = (
  code: string
): {
  readonly code: string;
  readonly label: string;
  readonly labelSource: CompanyStatusLabelSource;
} => {
  const known = COMPANY_STATUS_NOMENCLATURE[code];
  return known !== undefined
    ? { code, label: known, labelSource: 'api_nomenclature' }
    : { code, label: code, labelSource: 'code' };
};

export type CompanyNameSource = 'onrc_edition' | 'core_organization';

/**
 * The display name: the edition's qualified public CUI name when it has one,
 * else the directory spine's core organization name, attributed as such
 * (never presented as this edition's observation).
 */
export const displayName = (
  coreName: string,
  profile: CompanyRegistryCuiProfile | null
): { readonly name: string; readonly nameSource: CompanyNameSource } => {
  const onrc = profile?.name.value ?? null;
  return onrc !== null
    ? { name: onrc, nameSource: 'onrc_edition' }
    : { name: coreName, nameSource: 'core_organization' };
};

/**
 * The single public identifier key when the CUI has exactly one resolved
 * identifier and no unresolved one; null otherwise (several identifiers are
 * listed, never picked).
 */
export const singleIdentifierKey = (evidence: CompanyRegistryEvidence): string | null => {
  const profile = evidence.profile;
  if (profile?.unresolvedIdentifierCount !== 0) return null;
  if (profile.identifierCount !== 1 || evidence.identifiers.length !== 1) return null;
  return evidence.identifiers[0]?.identifierKey ?? null;
};

/** One activity per (revision, code) the pinned edition publicly observes, parsed codes only. */
export const onrcActivityKeys = (
  observations: readonly CompanyRegistryCaenObservation[]
): readonly {
  readonly code: string;
  readonly revision: string | null;
  readonly label: string | null;
}[] => {
  const seen = new Map<string, { code: string; revision: string | null; label: string | null }>();
  for (const o of observations) {
    if (o.code === null) continue;
    const key = `${o.revision ?? ''}:${o.code}`;
    if (!seen.has(key)) {
      seen.set(key, { code: o.code, revision: o.revision, label: o.catalogLabel?.label ?? null });
    }
  }
  return [...seen.values()].sort((a, b) => {
    const byCode = a.code.localeCompare(b.code);
    return byCode !== 0 ? byCode : (a.revision ?? '').localeCompare(b.revision ?? '');
  });
};

/** Distinct parsed public status codes the pinned edition observes, ascending. */
export const observedStatusCodes = (
  observations: readonly CompanyRegistryStatusObservation[]
): readonly string[] =>
  [...new Set(observations.flatMap((o) => (o.code === null ? [] : [o.code])))].sort();
