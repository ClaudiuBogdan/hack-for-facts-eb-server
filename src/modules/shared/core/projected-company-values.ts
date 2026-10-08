import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import type { SearchHit, SearchHitCompany } from './types.js';

const nullableText = Type.Union([Type.String(), Type.Null()]);
const ProjectedCompanySchema = Type.Object(
  {
    registryState: Type.Union([Type.Literal('in_edition'), Type.Literal('not_in_edition')]),
    name: Type.String({ minLength: 1 }),
    nameSource: Type.Union([Type.Literal('onrc_edition'), Type.Literal('core_organization')]),
    legalForm: nullableText,
    countyCode: nullableText,
    active: Type.Union([Type.Boolean(), Type.Null()]),
    identifiers: Type.Array(Type.String()),
  },
  { additionalProperties: false }
);

/** Existing serving bound; preserve unknown activity and source attribution. */
const COMPANY_IDENTIFIER_LIMIT = 200;
const PERSONAL_SHAPED_IDENTIFIER = /^(RO)?[0-9]{11,}$/iu;
const COMPANY_FIELDS = [
  'company_name',
  'company_name_source',
  'company_legal_form',
  'company_county_code',
  'company_active',
  'company_identifiers',
] as const;

/** null: no company; undefined: malformed. Values come entirely from Meili. */
export function projectedCompanyValues(hit: SearchHit): SearchHitCompany | null | undefined {
  const attrs = hit.attrs;
  const state = attrs['company_registry_state'];
  if (state === undefined || state === null) {
    return COMPANY_FIELDS.some((key) => attrs[key] !== undefined && attrs[key] !== null)
      ? undefined
      : null;
  }
  const row = {
    registryState: state,
    name: attrs['company_name'],
    nameSource: attrs['company_name_source'],
    legalForm: attrs['company_legal_form'],
    countyCode: attrs['company_county_code'],
    active: attrs['company_active'],
    identifiers: attrs['company_identifiers'],
  };
  if (!Value.Check(ProjectedCompanySchema, row) || row.name.trim() === '') return undefined;
  if (
    row.registryState === 'not_in_edition' &&
    (row.nameSource !== 'core_organization' ||
      row.legalForm !== null ||
      row.countyCode !== null ||
      row.active !== null ||
      row.identifiers.length !== 0)
  )
    return undefined;
  return {
    ...row,
    countyName: row.countyCode === null ? null : (hit.countyName ?? null),
    identifiers: row.identifiers
      .slice(0, COMPANY_IDENTIFIER_LIMIT)
      .filter((value) => !PERSONAL_SHAPED_IDENTIFIER.test(value)),
  };
}
