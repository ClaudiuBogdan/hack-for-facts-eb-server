/**
 * Parliament module — row → view-model mappers (plan 04 §2). Row types mirror the
 * `::text`-cast SQL projection (dates as strings, bigint as strings); mappers
 * convert to the camelCase domain models. The `attrs` jsonb is NEVER passed
 * through raw — `safeAttrs` whitelists known keys (privacy, §2.6 / Codex #4).
 */

import {
  BILL_ATTR_KEYS,
  MEMBER_ATTR_KEYS,
  VOTE_ATTR_KEYS,
  type ParliamentBill,
  type ParliamentBillDocument,
  type ParliamentBillEvent,
  type ParliamentControlItem,
  type ParliamentDeclarationMeta,
  type ParliamentGroupInterval,
  type ParliamentInitiative,
  type ParliamentMember,
  type ParliamentPerson,
  type ParliamentPersonConfidence,
  type ParliamentSpeech,
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
    attrs,
  };
};

export interface PersonRow {
  person_id: string;
  canonical_name: string;
  normalized_name: string;
  birth_date: string | null;
  confidence: string | null;
}

export const mapPerson = (r: PersonRow): ParliamentPerson => ({
  personId: r.person_id,
  canonicalName: r.canonical_name,
  normalizedName: r.normalized_name,
  birthDate: r.birth_date,
  confidence: confidenceOf(r.confidence),
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
  attrs: safeAttrs(r.attrs, BILL_ATTR_KEYS),
  sourceUpdatedAt: r.source_updated_at,
  updatedAt: r.updated_at,
});

export interface BillEventRow {
  position: number;
  event_date: string | null;
  event_date_text: string | null;
  description: string | null;
  chamber_code: string | null;
  committee: string | null;
  vote_idv: string | null;
  docs: unknown;
}

export const mapBillEvent = (r: BillEventRow): ParliamentBillEvent => ({
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
  url: string;
  label: string | null;
  kind: string | null;
  position: number | null;
}

export const mapBillDocument = (r: BillDocumentRow): ParliamentBillDocument => ({
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
  attrs: unknown;
}

export const mapVote = (r: VoteRow): ParliamentVote => {
  const attrs = safeAttrs(r.attrs, VOTE_ATTR_KEYS);
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
    tallyMismatch: attrs['tally_mismatch'] === true,
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
}

export const mapControlItem = (r: ControlItemRow): ParliamentControlItem => ({
  itemKey: r.item_key,
  controlType: r.control_type,
  controlTypeProvenance: r.control_type_provenance,
  title: r.title,
  recipient: r.recipient,
  itemDate: r.item_date,
  responseStatus: r.response_status,
  authorName: r.author_name,
  mandateKey: r.mandate_key,
});

export interface SpeechRow {
  speech_key: string;
  mandate_key: string | null;
  speaker_name: string | null;
  chamber: string | null;
  spoken_at: string | null;
  title: string | null;
  summary: string | null;
}

export const mapSpeech = (r: SpeechRow): ParliamentSpeech => ({
  speechKey: r.speech_key,
  mandateKey: r.mandate_key,
  speakerName: r.speaker_name,
  chamber: r.chamber,
  spokenAt: r.spoken_at,
  title: r.title,
  summary: r.summary,
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

export const mapDeclaration = (r: DeclarationRow): ParliamentDeclarationMeta => ({
  declarationType: r.declaration_type,
  declarationDate: r.declaration_date,
  label: r.label,
  fileUrl: r.file_url,
});

export { tallyOf };
