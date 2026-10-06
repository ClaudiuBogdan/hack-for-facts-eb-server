import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  type ApiError,
  type CollectionFilterSpec,
  type FilterInput,
} from '@/modules/shared/index.js';

import { PUBLIC_ENTERPRISE_AUTHORITY_LEVELS, PUBLIC_ENTERPRISE_FAMILIES } from './types.js';

/**
 * The public-enterprise list (`public_enterprise_memberships m`), CUI order.
 * `currentOnly` and the two authority fields are repo-owned (virtual): the repo
 * reads them and adds the membership flag or an EXISTS over the public edges.
 */
export const publicEnterpriseListFilterSpec: CollectionFilterSpec = {
  collection: 'public_enterprises',
  sort: { default: 'cui', allowed: ['cui'] },
  fields: [
    {
      name: 'cuis',
      type: 'string',
      ops: ['in'],
      array: true,
      column: { alias: 'm', column: 'cui' },
      description: 'Public-enterprise CUIs.',
    },
    {
      name: 'families',
      type: 'enum',
      enumValues: PUBLIC_ENTERPRISE_FAMILIES,
      ops: ['in'],
      array: true,
      column: { alias: 'm', column: 'current_families', arrayColumn: true },
      description: 'Any of these families among the current public observations.',
    },
    {
      name: 'currentOnly',
      type: 'bool',
      ops: ['eq'],
      default: true,
      virtual: true,
      column: { alias: 'm', column: 'is_current_member' },
      description:
        'true (default): current members only. false: every public anchor, including historical ones.',
    },
    {
      name: 'authorityCuis',
      type: 'string',
      ops: ['in'],
      array: true,
      virtual: true,
      column: { alias: 'e', column: 'authority_cui' },
      description: 'Has a current public control edge to any of these authority CUIs.',
    },
    {
      name: 'authorityLevels',
      type: 'enum',
      enumValues: PUBLIC_ENTERPRISE_AUTHORITY_LEVELS,
      ops: ['in'],
      array: true,
      virtual: true,
      column: { alias: 'e', column: 'authority_level' },
      description: 'Has a current public control edge reporting any of these levels.',
    },
  ],
};

/** The AMEPIP indicators of one enterprise (`public_amepip_indicators v`). */
export const publicEnterpriseIndicatorFilterSpec: CollectionFilterSpec = {
  collection: 'public_enterprise_indicators',
  sort: { default: 'yearSheetVersionKey', allowed: ['yearSheetVersionKey'] },
  fields: [
    {
      name: 'years',
      type: 'int',
      ops: ['in'],
      array: true,
      column: { alias: 'v', column: 'year' },
    },
    {
      name: 'kpiCodes',
      type: 'string',
      ops: ['in'],
      array: true,
      column: { alias: 'v', column: 'kpi_code' },
    },
    {
      name: 'sourceSheets',
      type: 'string',
      ops: ['in'],
      array: true,
      column: { alias: 'v', column: 'source_sheet' },
    },
  ],
};

/**
 * Drop GraphQL `null`s (an omitted field and `field: null` mean the same) so
 * only real `{ op: value }` entries reach the kernel compiler and the cursor
 * hash.
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

/** The repo-owned (virtual) list predicates, validated. */
export interface PublicEnterpriseVirtualFilters {
  readonly currentOnly: boolean;
  /** Absent: no predicate. `[]`: matches nothing (kernel `in: []` semantics). */
  readonly authorityCuis?: readonly string[];
  readonly authorityLevels?: readonly string[];
}

const CUI_PATTERN = /^[0-9]{2,10}$/u;

const inValues = (
  filter: FilterInput,
  name: string,
  accept: (value: string) => boolean
): Result<readonly string[] | undefined, ApiError> => {
  const field = filter[name];
  if (field === undefined) return ok(undefined);
  const values = field['in'];
  if (values === undefined) return ok(undefined);
  if (!Array.isArray(values)) return err(invalidInput(`${name} 'in' requires an array`, name));
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !accept(value))
      return err(invalidInput(`invalid ${name} value`, name));
    out.push(value);
  }
  return ok(out);
};

export const parseVirtualFilters = (
  filter: FilterInput
): Result<PublicEnterpriseVirtualFilters, ApiError> => {
  const currentOnlyField = filter['currentOnly'];
  const currentOnlyValue = currentOnlyField?.['eq'];
  if (currentOnlyValue !== undefined && typeof currentOnlyValue !== 'boolean')
    return err(invalidInput('currentOnly must be a boolean', 'currentOnly'));
  const authorityCuis = inValues(filter, 'authorityCuis', (v) => CUI_PATTERN.test(v));
  if (authorityCuis.isErr()) return err(authorityCuis.error);
  const authorityLevels = inValues(filter, 'authorityLevels', (v) =>
    (PUBLIC_ENTERPRISE_AUTHORITY_LEVELS as readonly string[]).includes(v)
  );
  if (authorityLevels.isErr()) return err(authorityLevels.error);
  return ok({
    currentOnly: currentOnlyValue ?? true,
    ...(authorityCuis.value === undefined ? {} : { authorityCuis: authorityCuis.value }),
    ...(authorityLevels.value === undefined ? {} : { authorityLevels: authorityLevels.value }),
  });
};
