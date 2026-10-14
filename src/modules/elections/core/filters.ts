import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  type ApiError,
  type CollectionFilterSpec,
  type FilterInput,
} from '@/modules/shared/index.js';

import { ELECTION_SCOPE_TYPES } from './types.js';

/** Source editions (`elections.elections e` + public `electoral_events ev`), `election_key` order. */
export const electionCatalogFilterSpec: CollectionFilterSpec = {
  collection: 'election_catalog',
  sort: { default: 'electionKey', allowed: ['electionKey'] },
  fields: [
    {
      name: 'reportedYears',
      type: 'int',
      ops: ['in'],
      array: true,
      column: { alias: 'e', column: 'election_year' },
      description: 'Reported (unverified) source-edition year.',
    },
    {
      name: 'reportedFamilies',
      type: 'string',
      ops: ['in'],
      array: true,
      column: { alias: 'e', column: 'election_family' },
      description:
        'Reported (unverified) stored family label, e.g. local, parliamentary, presidential, referendum. Matched exactly, never corrected: some labels are wrong (European Parliament editions are stored as parliamentary).',
    },
    {
      name: 'eventKeys',
      type: 'string',
      ops: ['in'],
      array: true,
      column: { alias: 'ev', column: 'event_key' },
      description: 'Platform event grouping, e.g. ro:local:2024. Editions of one event overlap.',
    },
  ],
};

/** Contests of one edition (`elections.contests c`), `contest_key` order. */
export const electionContestsFilterSpec: CollectionFilterSpec = {
  collection: 'election_contests',
  sort: { default: 'contestKey', allowed: ['contestKey'] },
  fields: [
    {
      name: 'reportedOffices',
      type: 'string',
      ops: ['in'],
      array: true,
      column: { alias: 'c', column: 'office' },
      description:
        'Reported (unverified) stored office label, e.g. mayor, local_council, county_council, county_president, chamber_deputies, senate. Vocabularies differ per source edition.',
    },
    {
      name: 'scopeTypes',
      type: 'enum',
      enumValues: ELECTION_SCOPE_TYPES,
      ops: ['in'],
      array: true,
      column: { alias: 'c', column: 'scope_type' },
      description: 'Source scope type; not a verified jurisdiction.',
    },
    {
      name: 'reportedRounds',
      type: 'string',
      ops: ['in'],
      array: true,
      column: { alias: 'c', column: 'round_label' },
      description: 'Reported round label exactly as stored (open source vocabulary). Not finality.',
    },
  ],
};

/**
 * Drop GraphQL `null`s (an omitted field and `field: null` mean the same) so
 * only real `{ op: value }` entries reach validation, SQL and paging.
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
const MAX_LABEL_LENGTH = 128;
export const MAX_KEY_LENGTH = 512;
export const MIN_REPORTED_YEAR = 1800;
export const MAX_REPORTED_YEAR = 2100;

/** A non-empty opaque value without control characters, passed through unchanged. */
export const isOpaqueText = (value: string, maxLength: number): boolean =>
  value.length > 0 &&
  value.length <= maxLength &&
  // eslint-disable-next-line no-control-regex -- Rejecting control characters is the point.
  !/[\u0000-\u001f\u007f]/u.test(value);

const acceptsValue = (field: string, value: unknown): boolean => {
  switch (field) {
    case 'reportedYears':
      return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= MIN_REPORTED_YEAR &&
        value <= MAX_REPORTED_YEAR
      );
    case 'scopeTypes':
      return (
        typeof value === 'string' && (ELECTION_SCOPE_TYPES as readonly string[]).includes(value)
      );
    case 'eventKeys':
      return typeof value === 'string' && isOpaqueText(value, MAX_KEY_LENGTH);
    default:
      return typeof value === 'string' && isOpaqueText(value, MAX_LABEL_LENGTH);
  }
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
      if (!values.every((value: unknown) => acceptsValue(name, value)))
        return err(invalidInput(`Invalid ${name} value.`, name));
    }
  }
  return ok(filter);
};
