import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  type ApiError,
  type CollectionFilterSpec,
  type FilterInput,
} from '@/modules/shared/index.js';

import { ELECTION_COMPETITOR_KINDS, ELECTION_PLACE_TYPES, ELECTION_STATUSES } from './types.js';

/**
 * The filter specs give the three surfaces one validated input. The repository
 * builds its own predicates from the validated values: jurisdiction type and
 * county are computed from the jurisdiction key and the territory reference,
 * not stored columns.
 */

/** Contests of one occurrence, `contest_key` order. */
export const electionContestsFilterSpec: CollectionFilterSpec = {
  collection: 'election_contests',
  sort: { default: 'contestKey', allowed: ['contestKey'] },
  fields: [
    {
      name: 'offices',
      type: 'string',
      ops: ['in'],
      array: true,
      column: { alias: 'c', column: 'office' },
      description:
        'Office, e.g. mayor, local_council, county_council, county_council_president, general_mayor, general_council, chamber, senate, president, european_parliament.',
    },
    {
      name: 'statuses',
      type: 'enum',
      enumValues: ELECTION_STATUSES,
      ops: ['in'],
      array: true,
      column: { alias: 'c', column: 'status' },
      description:
        'held, or annulled (an annulled contest may have no figures; one annulled after its count keeps them).',
    },
    {
      name: 'jurisdictionTypes',
      type: 'enum',
      enumValues: ELECTION_PLACE_TYPES,
      ops: ['in'],
      array: true,
      column: { alias: 'c', column: 'jurisdiction_type' },
      description: 'The type of place the office covers: uat, county, diaspora or national.',
    },
    {
      name: 'countyCodes',
      type: 'string',
      ops: ['in'],
      array: true,
      column: { alias: 'c', column: 'county_code' },
      description:
        'County code of the jurisdiction (e.g. CJ, B): a county contest, or a UAT contest in that county.',
    },
  ],
};

/** Competitors of one event's generation, `competitor_key` order. */
export const electionCompetitorsFilterSpec: CollectionFilterSpec = {
  collection: 'election_competitors',
  sort: { default: 'competitorKey', allowed: ['competitorKey'] },
  fields: [
    {
      name: 'kinds',
      type: 'enum',
      enumValues: ELECTION_COMPETITOR_KINDS,
      ops: ['in'],
      array: true,
      column: { alias: 'k', column: 'competitor_kind' },
      description: 'party, minority_org, list, independent or independents_bucket.',
    },
  ],
};

/**
 * Drop GraphQL `null`s (an omitted field and `field: null` mean the same) so
 * only real `{ op: value }` entries reach validation and SQL.
 */
export const withoutNulls = (input: unknown): FilterInput => {
  if (typeof input !== 'object' || input === null) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [field, ops] of Object.entries(input)) {
    if (typeof ops !== 'object' || ops === null) continue;
    const kept = Object.fromEntries(
      Object.entries(ops as Record<string, unknown>).filter(([, value]) => value !== null)
    );
    if (Object.keys(kept).length > 0) out[field] = kept;
  }
  return out as FilterInput;
};

export const MAX_FILTER_VALUES = 100;
export const MAX_KEY_LENGTH = 512;
const OFFICE = /^[a-z][a-z0-9_]*(?::[a-z0-9_]+)?$/u;
const COUNTY_CODE = /^[A-Z]{1,2}$/u;

/** A non-empty opaque value without control characters, passed through unchanged. */
export const isOpaqueText = (value: string, maxLength: number): boolean =>
  value.length > 0 &&
  value.length <= maxLength &&
  // eslint-disable-next-line no-control-regex -- Rejecting control characters is the point.
  !/[\u0000-\u001f\u007f]/u.test(value);

export const isOffice = (value: string): boolean => value.length <= 64 && OFFICE.test(value);

const acceptsValue = (spec: CollectionFilterSpec, field: string, value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  const declared = spec.fields.find((candidate) => candidate.name === field);
  if (declared?.type === 'enum') return (declared.enumValues ?? []).includes(value);
  if (field === 'offices') return isOffice(value);
  if (field === 'countyCodes') return COUNTY_CODE.test(value);
  return false;
};

/** The validated `in` values of one field, or undefined when the field is absent. */
export const inValues = (filter: FilterInput, field: string): readonly string[] | undefined => {
  const values = filter[field]?.['in'];
  return Array.isArray(values) ? (values as string[]) : undefined;
};

/**
 * Every field must be declared by the spec, use only `in`, and carry at most
 * MAX_FILTER_VALUES valid values. `in: []` is valid and matches nothing.
 */
export const validateFilter = (
  spec: CollectionFilterSpec,
  filter: FilterInput
): Result<FilterInput, ApiError> => {
  const fields = new Set(spec.fields.map((field) => field.name));
  for (const [name, ops] of Object.entries(filter)) {
    if (!fields.has(name) || ops === undefined)
      return err(invalidInput(`Unsupported filter field '${name}'.`, name));
    for (const [op, values] of Object.entries(ops)) {
      if (op !== 'in') return err(invalidInput(`${name} supports only 'in'.`, name));
      if (!Array.isArray(values) || values.length > MAX_FILTER_VALUES)
        return err(
          invalidInput(`${name}.in must be an array of at most ${String(MAX_FILTER_VALUES)}.`, name)
        );
      if (!values.every((value: unknown) => acceptsValue(spec, name, value)))
        return err(invalidInput(`Invalid ${name} value.`, name));
    }
  }
  return ok(filter);
};
