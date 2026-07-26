/**
 * Parliament module — row → view-model mappers (plan 04 §2). Row types mirror the
 * `::text`-cast SQL projection (dates as strings, bigint as strings); mappers
 * convert to the camelCase domain models. The `attrs` jsonb is NEVER passed
 * through raw — `safeAttrs` whitelists known keys (privacy, §2.6 / Codex #4).
 */

import {
  AI_DISCLAIMER,
  AI_TRUST_CLASS,
  BILL_ATTR_KEYS,
  MEMBER_ATTR_KEYS,
  VOTE_ATTR_KEYS,
  type ParliamentAiBillMetadata,
  type ParliamentAiControlItemMetadata,
  type ParliamentBill,
  type ParliamentBillDocument,
  type ParliamentBillEvent,
  type ParliamentCommittee,
  type ParliamentCommitteeMembership,
  type ParliamentControlItem,
  type ParliamentDeclarationMeta,
  type ParliamentGroupInterval,
  type ParliamentInitiative,
  type ParliamentMember,
  type ParliamentPerson,
  type ParliamentPersonConfidence,
  type ParliamentSpeech,
  type ParliamentSpeechRedirect,
  type ParliamentStenogramSegment,
  type ParliamentStenogramSession,
  type ParliamentStenogramSessionRef,
  type ParliamentTally,
  type ParliamentVote,
  type SafeAttrs,
} from '../../core/types.js';

/** Project a raw jsonb attrs object down to a whitelist of primitive-valued keys. */
export const safeAttrs = (raw: unknown, keys: readonly string[]): SafeAttrs => {
  const out: SafeAttrs = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
};

const confidenceOf = (raw: string | null): ParliamentPersonConfidence => {
  switch (raw) {
    case 'high':
    case 'medium':
    case 'low':
      return raw;
    default:
      return 'low';
  }
};

// ── members / persons / groups ───────────────────────────────────────────────

export interface MemberRow {
  mandate_key: string;
  chamber: string | null;
  legislature: string | null;
  full_name: string | null;
  normalized_name: string | null;
  group_name: string | null;
  group_id: string | null;
  constituency_name: string | null;
  birth_date: string | null;
  person_id: string | null;
  is_current: boolean;
  mandate_end_date: string | null;
  mandate_end_reason: string | null;
  attrs: unknown;
}

export const mapMember = (r: MemberRow): ParliamentMember => {
  const attrs = safeAttrs(r.attrs, MEMBER_ATTR_KEYS);
  // profile_url is already in the MEMBER_ATTR_KEYS whitelist; surface it flat
  // (string only — defend against a non-string primitive sneaking through).
  const profileUrl = typeof attrs['profile_url'] === 'string' ? attrs['profile_url'] : null;
  // B3: cv_pdf_url is whitelisted in MEMBER_ATTR_KEYS; surface it flat (string only).
  const cvPdfUrl = typeof attrs['cv_pdf_url'] === 'string' ? attrs['cv_pdf_url'] : null;
  return {
    mandateKey: r.mandate_key,
    chamber: r.chamber,
    legislature: r.legislature,
    fullName: r.full_name,
    normalizedName: r.normalized_name,
    groupName: r.group_name,
    groupId: r.group_id,
    constituencyName: r.constituency_name,
    birthDate: r.birth_date,
    personId: r.person_id,
    isCurrent: r.is_current,
    mandateEndDate: r.mandate_end_date,
    mandateEndReason: r.mandate_end_reason,
    profileUrl,
    cvPdfUrl,
    attrs,
  };
};

export interface PersonRow {
  person_id: string;
  canonical_name: string;
  normalized_name: string;
  birth_date: string | null;
  confidence: string | null;
  /** identity-v2 traceability (prod migration 20260701T176000) — CDep mandate page. */
  source_url: string | null;
}

export const mapPerson = (r: PersonRow): ParliamentPerson => ({
  personId: r.person_id,
  canonicalName: r.canonical_name,
  normalizedName: r.normalized_name,
  birthDate: r.birth_date,
  confidence: confidenceOf(r.confidence),
  sourceUrl: r.source_url,
});

export interface GroupIntervalRow {
  mandate_key: string;
  group_id: string;
  valid_from: string;
  valid_to: string | null;
  source: string;
  vote_count: number | null;
}

export const mapGroupInterval = (r: GroupIntervalRow): ParliamentGroupInterval => ({
  mandateKey: r.mandate_key,
  groupId: r.group_id,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  source: r.source,
  voteCount: r.vote_count,
});

// ── bills ────────────────────────────────────────────────────────────────────

export interface BillRow {
  bill_key: string;
  plx_number: string | null;
  plx_year: number | null;
  senate_number: string | null;
  senate_year: number | null;
  title: string | null;
  final_law_number: string | null;
  final_law_year: number | null;
  status_text: string | null;
  bill_type: string | null;
  last_event_date: string | null;
  is_canonical: boolean;
  canonical_bill_key: string | null;
  attrs: unknown;
  source_updated_at: string | null;
  updated_at: string | null;
}

export const mapBill = (r: BillRow): ParliamentBill => ({
  billKey: r.bill_key,
  plxNumber: r.plx_number,
  plxYear: r.plx_year,
  senateNumber: r.senate_number,
  senateYear: r.senate_year,
  title: r.title,
  finalLawNumber: r.final_law_number,
  finalLawYear: r.final_law_year,
  statusText: r.status_text,
  billType: r.bill_type,
  lastEventDate: r.last_event_date,
  isCanonical: r.is_canonical,
  canonicalBillKey: r.canonical_bill_key,
  attrs: safeAttrs(r.attrs, BILL_ATTR_KEYS),
  sourceUpdatedAt: r.source_updated_at,
  updatedAt: r.updated_at,
});

export interface BillEventRow {
  bill_key: string;
  position: number;
  event_date: string | null;
  event_date_text: string | null;
  description: string | null;
  chamber_code: string | null;
  committee: string[] | null;
  vote_idv: string | null;
  docs: unknown;
}

export const mapBillEvent = (r: BillEventRow): ParliamentBillEvent => ({
  sourceBillKey: r.bill_key,
  position: r.position,
  eventDate: r.event_date,
  eventDateText: r.event_date_text,
  description: r.description,
  chamberCode: r.chamber_code,
  committee: r.committee,
  voteIdv: r.vote_idv,
  docs: Array.isArray(r.docs) ? (r.docs as readonly unknown[]) : [],
});

export interface BillDocumentRow {
  bill_key: string;
  url: string;
  label: string | null;
  kind: string | null;
  position: number | null;
}

export const mapBillDocument = (r: BillDocumentRow): ParliamentBillDocument => ({
  sourceBillKey: r.bill_key,
  url: r.url,
  label: r.label,
  kind: r.kind,
  position: r.position,
});

// ── votes / ballots ──────────────────────────────────────────────────────────

const tallyOf = (r: {
  pentru: number | null;
  impotriva: number | null;
  abtinere: number | null;
  nu_a_votat: number | null;
  present: number | null;
}): ParliamentTally => ({
  pentru: r.pentru,
  impotriva: r.impotriva,
  abtinere: r.abtinere,
  nuAVotat: r.nu_a_votat,
  present: r.present,
});

export interface VoteRow {
  vote_key: string;
  chamber: string;
  vote_date: string | null;
  title: string | null;
  pentru: number | null;
  impotriva: number | null;
  abtinere: number | null;
  nu_a_votat: number | null;
  present: number | null;
  outcome: string | null;
  division_number: number | null;
  bill_key: string | null;
  law_reference: string | null;
  /** E2 traceability (prod migration 20260701T172000) — EXACT division page. */
  source_url: string | null;
  attrs: unknown;
}

export const mapVote = (r: VoteRow): ParliamentVote => {
  const attrs = safeAttrs(r.attrs, VOTE_ATTR_KEYS);
  // The loader writes `tally_mismatch` as a JSON OBJECT ({pentru:{official,recorded},…})
  // on the ~454 votes whose source tally disagrees with the per-ballot count. `safeAttrs`
  // drops non-primitive values, so the flag is detected on the RAW attrs — presence-only,
  // surfaced as a boolean (the object internals are never exposed, §2.6). The old
  // `attrs['tally_mismatch'] === true` could never be true (the value is an object, and
  // safeAttrs had already stripped it) → it read false for 0/4855 votes.
  const rawAttrs =
    r.attrs !== null && typeof r.attrs === 'object' && !Array.isArray(r.attrs)
      ? (r.attrs as Record<string, unknown>)
      : {};
  return {
    voteKey: r.vote_key,
    chamber: r.chamber,
    voteDate: r.vote_date,
    title: r.title,
    tally: tallyOf(r),
    outcome: r.outcome,
    divisionNumber: r.division_number,
    billKey: r.bill_key,
    lawReference: r.law_reference,
    sourceUrl: r.source_url,
    tallyMismatch: rawAttrs['tally_mismatch'] != null,
    attrs,
  };
};

// ── member activity ──────────────────────────────────────────────────────────

export interface ControlItemRow {
  item_key: string;
  control_type: string | null;
  control_type_provenance: string | null;
  title: string | null;
  recipient: string | null;
  item_date: string | null;
  response_status: string | null;
  author_name: string | null;
  mandate_key: string | null;
  /** E2 traceability (prod migration 20260701T172000) — EXACT source page. */
  source_url: string | null;
}

/** Chamber from the mandate_key prefix: '1:'=senat, '2:'=camera_deputatilor. */
const chamberFromMandateKey = (mandateKey: string | null): string | null => {
  if (mandateKey == null) return null;
  const prefix = mandateKey.split(':')[0];
  if (prefix === '1') return 'senat';
  if (prefix === '2') return 'camera_deputatilor';
  return null;
};

export const mapControlItem = (r: ControlItemRow): ParliamentControlItem => ({
  itemKey: r.item_key,
  controlType: r.control_type,
  controlTypeProvenance: r.control_type_provenance,
  title: r.title,
  recipient: r.recipient,
  itemDate: r.item_date,
  responseStatus: r.response_status,
  chamber: chamberFromMandateKey(r.mandate_key),
  authorName: r.author_name,
  mandateKey: r.mandate_key,
  sourceUrl: r.source_url,
});

export interface SpeechRow {
  speech_key: string;
  mandate_key: string | null;
  speaker_name: string | null;
  chamber: string | null;
  spoken_at: string | null;
  title: string | null;
  summary: string | null;
  source_url: string | null;
  source_url_kind: string | null;
  // Canonical-stenogram pointers. OPTIONAL on the row type on purpose: they are
  // selected only when the repo's canonical probe says the additive columns exist,
  // so a database without the migration yields a row WITHOUT these keys and the
  // mapper reports the honest "not canonical / not available" defaults.
  is_canonical?: boolean | null;
  stenogram_session_key?: string | null;
  stenogram_segment_key?: string | null;
}

/**
 * Decode the 0-based printed position from a canonical segment key
 * (`<session_key>#<position padded to 5>`). The key IS its (session, position)
 * identity — the scrapper mints it with `canonicalSegmentKey()` and the DB enforces
 * a unique `(session_key, position)` index over the same pair — so decoding is
 * reading the contract, not inferring from data. Anything that is not a `#`-suffixed
 * run of digits returns null rather than a guessed 0.
 */
export const positionFromSegmentKey = (segmentKey: string | null | undefined): number | null => {
  if (segmentKey == null) return null;
  const hash = segmentKey.lastIndexOf('#');
  if (hash < 0) return null;
  const suffix = segmentKey.slice(hash + 1);
  if (!/^\d+$/u.test(suffix)) return null;
  const position = Number.parseInt(suffix, 10);
  return Number.isSafeInteger(position) && position >= 0 ? position : null;
};

export const mapSpeech = (r: SpeechRow): ParliamentSpeech => ({
  speechKey: r.speech_key,
  mandateKey: r.mandate_key,
  speakerName: r.speaker_name,
  chamber: r.chamber,
  spokenAt: r.spoken_at,
  title: r.title,
  summary: r.summary,
  sourceUrl: r.source_url,
  sourceUrlKind: r.source_url_kind,
  // `=== true` (not a truthiness test): the column is absent on a pre-migration DB
  // and must then read as false, never undefined, on a non-optional view field.
  isCanonical: r.is_canonical === true,
  sessionKey: r.stenogram_session_key ?? null,
  position: positionFromSegmentKey(r.stenogram_segment_key),
});

// ── canonical stenogram (migration 20260726T140000) ──────────────────────────

export interface StenogramSessionRow {
  session_key: string;
  chamber: string;
  session_date: string | null; // ::text
  session_date_source: string;
  title: string | null;
  source_system: string;
  availability: string;
  source_url: string;
  source_url_kind: string;
  sitting_key: string | null;
  presiding_text: string | null;
  start_time_text: string | null;
  end_time_text: string | null;
  segment_count: number;
  speech_count: number;
  speaker_count: number;
  capture_digest: string | null;
  canonical_digest: string;
  source_updated_at: string | null; // ::text
}

/** The navigation-target row (a sitting as a previous/next link). */
export interface StenogramSessionRefRow {
  session_key: string;
  chamber: string;
  session_date: string | null; // ::text
  title: string | null;
  availability: string;
  source_url: string;
  source_url_kind: string;
}

export const mapStenogramSessionRef = (
  r: StenogramSessionRefRow
): ParliamentStenogramSessionRef => ({
  sessionKey: r.session_key,
  chamber: r.chamber,
  sessionDate: r.session_date,
  title: r.title,
  availability: r.availability,
  sourceUrl: r.source_url,
  sourceUrlKind: r.source_url_kind,
});

/**
 * Row → session view model. NOTHING is defaulted: `availability`,
 * `session_date_source`, `source_url_kind` and `chamber` are DB CHECK domains, so
 * an unexpected value is a data defect that must stay VISIBLE rather than be
 * silently normalised into a friendlier enum member.
 */
export const mapStenogramSession = (r: StenogramSessionRow): ParliamentStenogramSession => ({
  sessionKey: r.session_key,
  chamber: r.chamber,
  sessionDate: r.session_date,
  sessionDateSource: r.session_date_source,
  title: r.title,
  sourceSystem: r.source_system,
  availability: r.availability,
  sourceUrl: r.source_url,
  sourceUrlKind: r.source_url_kind,
  sittingKey: r.sitting_key,
  presidingText: r.presiding_text,
  startTimeText: r.start_time_text,
  endTimeText: r.end_time_text,
  segmentCount: r.segment_count,
  speechCount: r.speech_count,
  speakerCount: r.speaker_count,
  captureDigest: r.capture_digest,
  canonicalDigest: r.canonical_digest,
  sourceUpdatedAt: r.source_updated_at,
});

export interface StenogramSegmentRow {
  segment_key: string;
  session_key: string;
  position: number;
  segment_kind: string;
  text: string;
  text_chars: number;
  speaker_name: string | null;
  speaker_ref: string | null;
  mandate_key: string | null;
  speech_key: string | null;
  agenda_ref: string | null;
  source_url: string;
  source_url_kind: string;
}

export const mapStenogramSegment = (r: StenogramSegmentRow): ParliamentStenogramSegment => ({
  segmentKey: r.segment_key,
  sessionKey: r.session_key,
  position: r.position,
  kind: r.segment_kind,
  text: r.text,
  textChars: r.text_chars,
  speakerName: r.speaker_name,
  speakerRef: r.speaker_ref,
  mandateKey: r.mandate_key,
  speechKey: r.speech_key,
  agendaRef: r.agenda_ref,
  sourceUrl: r.source_url,
  sourceUrlKind: r.source_url_kind,
});

export interface SpeechRedirectRow {
  legacy_speech_key: string;
  session_key: string;
  canonical_speech_key: string | null;
  canonical_segment_key: string | null;
  canonical_position: number | null;
  mapping_kind: string;
  match_method: string;
}

/** Row → redirect view model. `evidence` is internal matcher state and never read. */
export const mapSpeechRedirect = (r: SpeechRedirectRow): ParliamentSpeechRedirect => ({
  legacySpeechKey: r.legacy_speech_key,
  sessionKey: r.session_key,
  canonicalSpeechKey: r.canonical_speech_key,
  canonicalSegmentKey: r.canonical_segment_key,
  canonicalPosition: r.canonical_position,
  mappingKind: r.mapping_kind,
  matchMethod: r.match_method,
});

export interface InitiativeRow {
  initiative_key: string;
  mandate_key: string;
  bill_key: string | null;
  title: string | null;
  status: string | null;
  promulgated_law_number: string | null;
  promulgated_law_year: number | null;
  registration_date: string | null; // to_date(registration_date_text)::text → ISO
}

export const mapInitiative = (r: InitiativeRow): ParliamentInitiative => ({
  initiativeKey: r.initiative_key,
  mandateKey: r.mandate_key,
  billKey: r.bill_key,
  title: r.title,
  status: r.status,
  promulgatedLawNumber: r.promulgated_law_number,
  promulgatedLawYear: r.promulgated_law_year,
  registrationDate: r.registration_date,
});

export interface DeclarationRow {
  declaration_type: string;
  declaration_date: string | null;
  label: string | null;
  file_url: string;
}

/** CDEP declaration URLs bucket by year in the path (.../deputati/2012/avere/x.pdf). */
const declarationYearFromUrl = (url: string): number | null => {
  const m = /\/((?:19|20)\d{2})(?=\/)/u.exec(url);
  return m?.[1] !== undefined ? Number(m[1]) : null;
};

export const mapDeclaration = (r: DeclarationRow): ParliamentDeclarationMeta => {
  // M10: the source carries no per-declaration date or label (the CDEP index is a
  // year-bucketed list of PDF links). Recover the YEAR from the file_url path and
  // synthesize a human label so these are not 100% null. declarationDate stays null —
  // a full date cannot be fabricated from a year alone (honest).
  const year = declarationYearFromUrl(r.file_url);
  return {
    declarationType: r.declaration_type,
    declarationDate: r.declaration_date,
    declarationYear: year,
    label:
      r.label ?? (year !== null ? `${r.declaration_type} ${String(year)}` : r.declaration_type),
    fileUrl: r.file_url,
  };
};

// ── AI metadata (B1 — stamps the trust class + disclaimer on every row) ────────

/** A text[] pg column: already an array of strings on read; defend against null. */
const strArray = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export interface AiBillMetadataRow {
  summary: string | null;
  topic: string | null;
  domains: unknown;
  keywords: unknown;
  value_class: string;
  config_key: string;
  prompt_version: string;
  schema_version: number;
  model: string;
  validation_status: string;
  confidence: string | null;
  source_updated_at: string | null;
  loaded_at: string | null;
  privacy_class: string;
}

export const mapAiBillMetadata = (r: AiBillMetadataRow): ParliamentAiBillMetadata => ({
  summary: r.summary,
  topic: r.topic,
  domains: strArray(r.domains),
  keywords: strArray(r.keywords),
  valueClass: r.value_class,
  configKey: r.config_key,
  promptVersion: r.prompt_version,
  schemaVersion: r.schema_version,
  model: r.model,
  validationStatus: r.validation_status,
  confidence: r.confidence,
  sourceUpdatedAt: r.source_updated_at,
  loadedAt: r.loaded_at,
  privacyClass: r.privacy_class,
  trustClass: AI_TRUST_CLASS,
  disclaimer: AI_DISCLAIMER,
});

export interface AiControlItemMetadataRow {
  summary: string | null;
  policy_domains: unknown;
  issue_types: unknown;
  urgency: string | null;
  keywords: unknown;
  config_key: string;
  prompt_version: string;
  schema_version: number;
  model: string;
  validation_status: string;
  confidence: string | null;
  source_updated_at: string | null;
  loaded_at: string | null;
  privacy_class: string;
}

export const mapAiControlItemMetadata = (
  r: AiControlItemMetadataRow
): ParliamentAiControlItemMetadata => ({
  summary: r.summary,
  policyDomains: strArray(r.policy_domains),
  issueTypes: strArray(r.issue_types),
  urgency: r.urgency,
  keywords: strArray(r.keywords),
  configKey: r.config_key,
  promptVersion: r.prompt_version,
  schemaVersion: r.schema_version,
  model: r.model,
  validationStatus: r.validation_status,
  confidence: r.confidence,
  sourceUpdatedAt: r.source_updated_at,
  loadedAt: r.loaded_at,
  privacyClass: r.privacy_class,
  trustClass: AI_TRUST_CLASS,
  disclaimer: AI_DISCLAIMER,
});

// ── committees (B2) ──────────────────────────────────────────────────────────

/** Translate the raw chamber code to the module-consistent enum value. */
const committeeChamber = (raw: string | null): string => {
  if (raw === 'cdep') return 'camera_deputatilor';
  if (raw === 'senate') return 'senat';
  return raw ?? '';
};

export interface CommitteeRow {
  committee_key: string;
  chamber: string | null;
  name: string;
  legislature: string | null;
  committee_type: string | null;
  source_url: string;
}

export const mapCommittee = (r: CommitteeRow): ParliamentCommittee => ({
  committeeKey: r.committee_key,
  chamber: committeeChamber(r.chamber),
  name: r.name,
  legislature: r.legislature,
  committeeType: r.committee_type,
  sourceUrl: r.source_url,
});

/** A committee-membership row's SERVABLE core fields (PDL-003: no group/raw name). */
export interface CommitteeMembershipCoreRow {
  membership_key: string;
  membership_role: string | null;
  joined_date: string | null;
  left_date: string | null;
  membership_is_bureau: boolean | null;
  membership_source_url: string;
}

/**
 * Map a committee-membership row to the view model. PDL-003 REGRESSION GUARD: the
 * output carries NO parliamentaryGroup / role_raw / memberName — those raw columns
 * are unbound in the schema and never projected. `committee` (member direction) and
 * `member` (roster direction) are the soft-links the repo resolves per query.
 */
export const mapCommitteeMembership = (
  r: CommitteeMembershipCoreRow,
  committee: ParliamentCommittee | null,
  member: ParliamentMember | null
): ParliamentCommitteeMembership => ({
  membershipKey: r.membership_key,
  role: r.membership_role,
  joinedDate: r.joined_date,
  leftDate: r.left_date,
  isBureau: r.membership_is_bureau,
  sourceUrl: r.membership_source_url,
  committee,
  member,
});

export { tallyOf };
