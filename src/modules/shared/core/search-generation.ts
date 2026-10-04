/**
 * Shared Kernel — the palette generation-control protocol (scrapper
 * `search-generation-control-contract.md`, frozen data-24, r2 data-25).
 *
 * The `entities` palette index carries exactly one reserved control document
 * per generation, read by exact ID only (never a search, never a hit). It
 * names the generation and the ONRC registry scope its company contribution
 * was built for. This module parses it STRICTLY: exactly the 18 contract
 * keys, the accepted versions, canonical bigint strings, an exact civil date.
 * Anything else is not a witness. Core: no throws; the only I/O is the exact
 * read through the injected Meili port (`readGenerationControl`).
 *
 * The server never recomputes the producer's `company_value_digest`; it is
 * the producer's index-versus-source witness, carried here only so two reads
 * of the same generation can be compared as a whole.
 */

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import type { MeiliClient } from './ports.js';

/** The reserved document id, doc_type and doc_key (entity ids end in `_<md5>`: no collision). */
export const PALETTE_GENERATION_CONTROL_ID = 'palette_generation_control';
export const PALETTE_GENERATION_CONTROL_VERSION = 'palette-generation-control-v1';
export const PALETTE_COMPANY_PROJECTION_VERSION = 'palette-company-v1';
const ONRC_INTERPRETATION_VERSION = 'onrc-edition-v1';
const ONRC_DIMENSION_POLICY_VERSION = 'onrc-dimensions-v1';

/** PostgreSQL `bigint` upper bound: no edition id or epoch exceeds it. */
const PG_BIGINT_MAX = 9223372036854775807n;

const CANONICAL_BIGINT = '^(0|[1-9][0-9]{0,18})$';
const POSITIVE_BIGINT = '^[1-9][0-9]{0,18}$';

/** The 18 keys of the contract table (§1); an omitted or extra key is not a control. */
const ControlSchema = Type.Object(
  {
    id: Type.Literal(PALETTE_GENERATION_CONTROL_ID),
    doc_type: Type.Literal(PALETTE_GENERATION_CONTROL_ID),
    doc_key: Type.Literal(PALETTE_GENERATION_CONTROL_ID),
    privacy_class: Type.Literal('internal'),
    control_version: Type.Literal(PALETTE_GENERATION_CONTROL_VERSION),
    projection_version: Type.Literal(PALETTE_COMPANY_PROJECTION_VERSION),
    generation_id: Type.String({ pattern: '^[A-Za-z0-9_-]{1,200}$' }),
    registry_scope_key: Type.String(),
    onrc_edition_id: Type.String({ pattern: POSITIVE_BIGINT }),
    onrc_publication_epoch: Type.String({ pattern: CANONICAL_BIGINT }),
    company_access_epoch: Type.String({ pattern: CANONICAL_BIGINT }),
    onrc_source_snapshot_id: Type.String({ minLength: 1 }),
    onrc_source_published_at: Type.Union([
      Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' }),
      Type.Null(),
    ]),
    onrc_interpretation_version: Type.Literal(ONRC_INTERPRETATION_VERSION),
    onrc_dimension_policy_version: Type.Literal(ONRC_DIMENSION_POLICY_VERSION),
    entity_count: Type.Integer({ minimum: 0 }),
    company_count: Type.Integer({ minimum: 0 }),
    company_value_digest: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  },
  { additionalProperties: false }
);

/** A parsed, accepted generation control. Bigints stay canonical decimal strings. */
export interface PaletteGenerationControl {
  readonly generationId: string;
  /** `onrc:published:<edition>:<publication epoch>:<access epoch>` (the server's `registryScopeKey`). */
  readonly registryScopeKey: string;
  readonly editionId: string;
  readonly publicationEpoch: string;
  readonly accessEpoch: string;
  readonly sourceSnapshotId: string;
  readonly sourcePublishedAt: string | null;
  readonly entityCount: number;
  readonly companyCount: number;
  readonly companyValueDigest: string;
}

/**
 * One reading of the control. `missing`: the index has no control document;
 * `unreadable`: the read itself failed; `unsupported`: a control of another
 * control/projection version; `malformed`: anything else that is not exactly
 * the accepted shape. Only `valid` is a witness.
 */
export type GenerationControlReading =
  | { readonly state: 'valid'; readonly control: PaletteGenerationControl }
  | { readonly state: 'missing' | 'unreadable' | 'unsupported' | 'malformed' };

const withinBigint = (text: string): boolean => BigInt(text) <= PG_BIGINT_MAX;

/** A real civil date in years 0001–9999 (the contract's `YYYY-MM-DD`). */
const isCivilDate = (text: string): boolean => {
  const [y, m, d] = text.split('-').map(Number) as [number, number, number];
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
  return d <= days;
};

// eslint-disable-next-line no-control-regex -- matching C0, DEL and C1 control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parse one raw control document (`null` = the index has none). Strict: a
 * different version of either protocol is `unsupported`, every other
 * deviation `malformed`.
 */
export const parseGenerationControl = (raw: unknown): GenerationControlReading => {
  if (raw === null) return { state: 'missing' };
  if (!isObject(raw)) return { state: 'malformed' };
  if (
    (typeof raw['control_version'] === 'string' &&
      raw['control_version'] !== PALETTE_GENERATION_CONTROL_VERSION) ||
    (typeof raw['projection_version'] === 'string' &&
      raw['projection_version'] !== PALETTE_COMPANY_PROJECTION_VERSION)
  ) {
    return { state: 'unsupported' };
  }
  if (!Value.Check(ControlSchema, raw)) return { state: 'malformed' };
  const edition = raw.onrc_edition_id;
  const publication = raw.onrc_publication_epoch;
  const access = raw.company_access_epoch;
  if (
    !withinBigint(edition) ||
    !withinBigint(publication) ||
    !withinBigint(access) ||
    raw.registry_scope_key !== `onrc:published:${edition}:${publication}:${access}` ||
    CONTROL_CHARACTER.test(raw.onrc_source_snapshot_id) ||
    (raw.onrc_source_published_at !== null && !isCivilDate(raw.onrc_source_published_at)) ||
    !Number.isSafeInteger(raw.entity_count) ||
    !Number.isSafeInteger(raw.company_count)
  ) {
    return { state: 'malformed' };
  }
  return {
    state: 'valid',
    control: {
      generationId: raw.generation_id,
      registryScopeKey: raw.registry_scope_key,
      editionId: edition,
      publicationEpoch: publication,
      accessEpoch: access,
      sourceSnapshotId: raw.onrc_source_snapshot_id,
      sourcePublishedAt: raw.onrc_source_published_at,
      entityCount: raw.entity_count,
      companyCount: raw.company_count,
      companyValueDigest: raw.company_value_digest,
    },
  };
};

/**
 * Read and parse the control of `index` through the client's exact-ID read.
 * A client without that read, or a failed read, is never a witness.
 */
export const readGenerationControl = async (
  client: Pick<MeiliClient, 'readGenerationControl'>,
  index: string
): Promise<GenerationControlReading> => {
  const raw = await client.readGenerationControl?.(index);
  if (raw === undefined) return { state: 'missing' };
  return raw.isErr() ? { state: 'unreadable' } : parseGenerationControl(raw.value);
};

/** Two readings name the same generation (every parsed field equal). */
export const sameGeneration = (a: PaletteGenerationControl, b: PaletteGenerationControl): boolean =>
  a.generationId === b.generationId &&
  a.registryScopeKey === b.registryScopeKey &&
  a.sourceSnapshotId === b.sourceSnapshotId &&
  a.sourcePublishedAt === b.sourcePublishedAt &&
  a.entityCount === b.entityCount &&
  a.companyCount === b.companyCount &&
  a.companyValueDigest === b.companyValueDigest;

/**
 * The generation two control reads (before and after one candidate fetch)
 * witness: the control when both are valid and name the same generation;
 * otherwise the reason it is not a witness. A changed generation or scope
 * between the reads is `control_incoherent`.
 */
export type GenerationWitness =
  | { readonly witnessed: true; readonly control: PaletteGenerationControl }
  | { readonly witnessed: false; readonly reason: GenerationWitnessFailure };

export type GenerationWitnessFailure =
  | 'control_missing'
  | 'control_unreadable'
  | 'control_unsupported'
  | 'control_malformed'
  | 'control_incoherent';

const FAILURE_OF: Readonly<
  Record<Exclude<GenerationControlReading['state'], 'valid'>, GenerationWitnessFailure>
> = {
  missing: 'control_missing',
  unreadable: 'control_unreadable',
  unsupported: 'control_unsupported',
  malformed: 'control_malformed',
};

export const witnessGeneration = (
  before: GenerationControlReading,
  after: GenerationControlReading
): GenerationWitness => {
  if (before.state !== 'valid') return { witnessed: false, reason: FAILURE_OF[before.state] };
  if (after.state !== 'valid') return { witnessed: false, reason: FAILURE_OF[after.state] };
  return sameGeneration(before.control, after.control)
    ? { witnessed: true, control: before.control }
    : { witnessed: false, reason: 'control_incoherent' };
};
