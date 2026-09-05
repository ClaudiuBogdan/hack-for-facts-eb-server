/** Shared identity visibility predicates. NULL class is not declared public. */
import { sql, type RawBuilder } from 'kysely';

import { MAX_SERVED_CUI_DIGITS } from '../../core/types.js';

export const organizationIdentifierIsServable = (column: string): RawBuilder<boolean> =>
  sql<boolean>`(${sql.ref(column)} is null or length(${sql.ref(column)}) <= ${sql.lit(MAX_SERVED_CUI_DIGITS)})`;

export const organizationRowIsPublic = (column: string): RawBuilder<boolean> =>
  sql<boolean>`${sql.ref(column)} = ${'public'}`;
