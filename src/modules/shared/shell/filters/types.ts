import type { RawBuilder } from 'kysely';

/** A parameterized SQL condition (Kysely `sql``` — injection-safe by design). */
export type SqlCondition = RawBuilder<unknown>;
