/**
 * Judicial REST — boundary schemas (API-04). TypeBox only.
 *
 * RESPONSES are fully declared: every field of every payload, and the module
 * envelope (foundation §5.2 / §14.11). The ONLY deliberately open slots are the
 * stored JSON values (`JudicialDecision.attrs` and the link's stored JSON
 * value), declared `Type.Unknown()` so the serializer emits any stored JSON
 * value (object, array, scalar, null) unchanged — never an object-only schema
 * that would drop unfamiliar keys or an `{}` default. Dates and timestamps are
 * plain strings (no restrictive format): native exceptional spellings (BC,
 * expanded years, ±infinity) must serialize.
 *
 * QUERY STRINGS are NOT given to Fastify's validator: its AJV runs with
 * `coerceTypes` + `removeAdditional`, which would coerce malformed integer or
 * boolean text and erase unknown keys or duplicates before any check. Each
 * route declares a parameter table instead; `decodeQuery` checks the ORIGINAL
 * parsed query (unknown keys, duplicate scalars, lexical integers/booleans),
 * decodes it once and re-checks the decoded object against its TypeBox schema.
 * A repeated parameter is a list; a single occurrence is a one-member list; no
 * CSV splitting.
 */

import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import type { FlatKind, FlatRule } from '../filters/transport-input.js';

// ── query decoding ─────────────────────────────────────────────────────────────

/** A route's query-parameter table: name → lexical kind. */
export type QueryTable = Readonly<Record<string, FlatKind>>;

/** The parameter table of a set of flat filter rules (plus extra route params). */
export const queryTableOf = (rules: readonly FlatRule[], extra: QueryTable = {}): QueryTable => ({
  ...Object.fromEntries(rules.map((r) => [r.key, r.kind])),
  ...extra,
});

export const PAGE_QUERY: QueryTable = { first: 'int', after: 'string' };

const INT_TEXT_RE = /^-?(?:0|[1-9][0-9]*)$/u;

const kindSchema = (kind: FlatKind): TSchema => {
  switch (kind) {
    case 'string':
      return Type.String();
    case 'stringList':
      return Type.Array(Type.String());
    case 'int':
      return Type.Integer();
    case 'bool':
      return Type.Boolean();
  }
};

/** The TypeBox schema of a decoded query (strict: no unknown keys). */
export const decodedQuerySchema = (table: QueryTable): TSchema =>
  Type.Object(
    Object.fromEntries(
      Object.entries(table).map(([k, kind]) => [k, Type.Optional(kindSchema(kind))])
    ),
    { additionalProperties: false }
  );

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Decode the ORIGINAL parsed query against its table, BEFORE any coercion.
 * Errors name only table-owned parameters (an unknown key is never echoed) and
 * never echo a value.
 */
export const decodeQuery = (
  raw: unknown,
  table: QueryTable
): Result<Record<string, unknown>, ApiError> => {
  if (raw === undefined || raw === null) return ok({});
  if (!isPlainRecord(raw)) return err(invalidInput('malformed query string', 'query'));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const kind = Object.hasOwn(table, key) ? table[key] : undefined;
    if (kind === undefined) return err(invalidInput('unsupported query parameter', 'query'));
    if (kind === 'stringList') {
      if (typeof value === 'string') out[key] = [value];
      else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        out[key] = [...value];
      } else return err(invalidInput(`${key} must be a list of strings`, key));
      continue;
    }
    if (Array.isArray(value)) {
      return err(invalidInput(`${key} may appear only once`, key));
    }
    if (typeof value !== 'string') return err(invalidInput(`malformed ${key}`, key));
    switch (kind) {
      case 'string':
        out[key] = value;
        break;
      case 'int': {
        const n = INT_TEXT_RE.test(value) ? Number(value) : Number.NaN;
        if (!Number.isSafeInteger(n)) return err(invalidInput(`${key} must be an integer`, key));
        out[key] = n;
        break;
      }
      case 'bool':
        if (value !== 'true' && value !== 'false') {
          return err(invalidInput(`${key} must be true or false`, key));
        }
        out[key] = value === 'true';
        break;
    }
  }
  if (!Value.Check(decodedQuerySchema(table), out)) {
    return err(invalidInput('malformed query string', 'query'));
  }
  return ok(out);
};

// ── response payloads (fully declared) ─────────────────────────────────────────

const N = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const S = () => Type.String();
const NS = () => N(Type.String());
const INT = () => Type.Integer();

export const CourtSchema = Type.Object({
  institutionCode: S(),
  ordinal: INT(),
  courtLevel: S(),
  specialization: NS(),
  locality: NS(),
  countyCode: NS(),
  countySirutaCode: NS(),
  parentInstitutionCode: NS(),
  mappingConfidence: S(),
});

export const CourtTreeSchema = Type.Object({
  court: CourtSchema,
  children: Type.Array(CourtSchema),
});

export const CaseSchema = Type.Object({
  caseId: S(),
  sourceSlug: S(),
  institutionCode: S(),
  caseNumber: S(),
  caseNumberOld: NS(),
  department: NS(),
  category: NS(),
  categoryName: NS(),
  stage: NS(),
  stageName: NS(),
  object: NS(),
  sourceOpenedAt: NS(),
  sourceOpenedAtBasis: S(),
  latestSourceModifiedAt: NS(),
});

const HearingSchema = Type.Object({
  caseId: S(),
  hearingIndex: INT(),
  hearingAt: NS(),
  panel: NS(),
  pronouncementDate: NS(),
  documentNumber: NS(),
  documentDate: NS(),
});

const AppealSchema = Type.Object({
  caseId: S(),
  appealIndex: INT(),
  appealDeclaredAt: NS(),
  appealType: NS(),
});

const PartyViewSchema = Type.Object({
  partyIndex: INT(),
  partyKind: S(),
  roleNormalized: NS(),
  nameKeyId: NS(),
  name: NS(),
  legalForm: NS(),
});

export const LegalRefSchema = Type.Object({
  caseLegalReferenceId: S(),
  caseId: S(),
  sourceField: S(),
  hearingIndex: N(INT()),
  actType: NS(),
  actNumber: NS(),
  actYear: N(INT()),
  issuerSlug: NS(),
  articleFragment: NS(),
  targetActId: NS(),
  resolutionStatus: NS(),
  confidenceScore: NS(),
  citation: S(),
});

export const LineageEdgeSchema = Type.Object({
  lineageCandidateId: S(),
  fromCaseId: S(),
  toCaseId: NS(),
  lineageType: S(),
  method: NS(),
  confidenceScore: NS(),
  validationStatus: S(),
});

const AsOfSchema = Type.Object({
  asOf: NS(),
  estimated: Type.Boolean(),
  sourceSlug: S(),
  basis: S(),
  captureFreshnessAt: NS(),
  loadFreshnessAt: NS(),
});

export const CaseDetailSchema = Type.Object({
  case: CaseSchema,
  hearings: Type.Array(HearingSchema),
  appeals: Type.Array(AppealSchema),
  parties: Type.Array(PartyViewSchema),
  personPartyCount: INT(),
  legalReferences: Type.Array(LegalRefSchema),
  lineage: Type.Array(LineageEdgeSchema),
  asOf: AsOfSchema,
});

export const CaseAggregateSchema = Type.Object({
  groups: Type.Array(Type.Object({ key: S(), label: NS(), caseCount: INT() })),
  denominator: INT(),
  coverage: Type.Number(),
});

export const CompanyLitigationSchema = Type.Object({
  cui: S(),
  companyName: NS(),
  caseCount: INT(),
  courtLevels: Type.Array(Type.Object({ courtLevel: S(), count: INT() })),
  years: Type.Array(Type.Object({ year: INT(), count: INT() })),
  coverage: Type.Number(),
  caveats: Type.Array(S()),
});

export const CaseLinkSchema = Type.Object({
  caseId: S(),
  institutionCode: S(),
  caseNumber: S(),
  category: NS(),
  sourceOpenedAt: NS(),
});

export const CaseCitationSchema = Type.Object({
  caseId: S(),
  institutionCode: S(),
  caseNumber: S(),
  actType: NS(),
  actNumber: NS(),
  actYear: N(INT()),
});

export const ResolveHitSchema = Type.Object({
  kind: S(),
  value: S(),
  label: S(),
  score: Type.Optional(Type.Number()),
  hint: Type.Optional(S()),
});

export const IssuingBodySchema = Type.Object({
  issuingBody: S(),
  label: S(),
  kind: S(),
  notes: NS(),
  createdAt: S(),
});

export const DecisionSchema = Type.Object({
  decisionId: S(),
  issuingBody: S(),
  sourceSystem: S(),
  sourceRef: S(),
  decisionNo: NS(),
  decisionYear: N(INT()),
  decisionDate: NS(),
  decisionKind: NS(),
  outcomeNormalized: NS(),
  ecli: NS(),
  applicationNo: NS(),
  /** The stored JSON value, deliberately open (any JSON value, as stored). */
  attrs: Type.Unknown(),
  privacyClass: S(),
  sourceUrl: NS(),
  sourceObjectKey: NS(),
  createdAt: S(),
  updatedAt: S(),
});

export const DecisionSubjectLinkSchema = Type.Object({
  linkId: S(),
  decisionId: S(),
  subjectKind: S(),
  subjectRef: S(),
  role: NS(),
  method: NS(),
  confidenceScore: NS(),
  validationStatus: S(),
  /** The stored JSON value, deliberately open (served as stored; API-04 override). */
  evidence: Type.Unknown(),
  resolverVersion: NS(),
  createdAt: S(),
  updatedAt: S(),
});

// ── envelopes ──────────────────────────────────────────────────────────────────

/** Success: `{ ok: true, data, requestId }` (+ `meta.cursor.next` on cursor lists). */
export const successSchema = <T extends TSchema>(data: T) =>
  Type.Object({ ok: Type.Literal(true), data, requestId: S() });

export const pageSuccessSchema = <T extends TSchema>(item: T) =>
  Type.Object({
    ok: Type.Literal(true),
    data: Type.Array(item),
    requestId: S(),
    meta: Type.Object({ cursor: Type.Object({ next: NS() }) }),
  });

/** Failure: `{ ok: false, error: <ApiError type>, message, field?, resource?, requestId }`. */
export const ErrorSchema = Type.Object({
  ok: Type.Literal(false),
  error: S(),
  message: S(),
  field: Type.Optional(S()),
  resource: Type.Optional(S()),
  requestId: S(),
});

/** The response map of a route: its success shape plus the shared error envelope. */
export const responses = (success: TSchema) => ({
  200: success,
  '4xx': ErrorSchema,
  '5xx': ErrorSchema,
});
