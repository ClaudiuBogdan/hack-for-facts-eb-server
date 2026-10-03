/**
 * Judicial repos — temporal SQL rendering (A1). The justice `timestamptz` and
 * `date` columns are unrestricted (BC, expanded years, ±infinity, and dates past
 * the timestamp range are all legal), and the prod pool returns their wire text
 * in the session's TimeZone/DateStyle. So nothing in this module parses them in
 * JavaScript: each value is rendered here, in SQL, from a FIXED column
 * expression supplied by the calling repo (never user input).
 *
 * Ordinary values keep their existing display shapes; exceptional values are
 * explicit PostgreSQL-compatible text instead of an error, a wrong year or a
 * dropped era. Cursor values use `exactTimestampText`, never a display.
 */

import { sql, type RawBuilder } from 'kysely';

/**
 * The EXACT text of a timestamptz: finite values in UTC with six fractional
 * digits and an explicit era taken from the same UTC expression
 * (`2026-05-04T13:15:00.123456+00 AD`); ±infinity as PostgreSQL text; NULL stays
 * NULL. It casts back to the identical native value under any session
 * TimeZone/DateStyle (the cursor codec).
 */
export const exactTimestampText = (col: RawBuilder<unknown>): RawBuilder<string | null> =>
  sql<string | null>`(case
    when ${col} is null then null
    when isfinite(${col}) then to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
      || '+00' || to_char(${col} at time zone 'UTC', ' BC')
    else ${col}::text
  end)`;

/**
 * UTC timestamp display (`latestSourceModifiedAt`, `asOf`, `hearingAt`): the
 * existing millisecond ISO shape `YYYY-MM-DDTHH:mm:ss.SSSZ` for AD years 1–9999
 * (year 0001 stays 0001); otherwise the exact UTC text with era, or
 * `infinity`/`-infinity`. The year test and the formatting use the same UTC
 * expression.
 */
export const utcTimestampDisplay = (col: RawBuilder<unknown>): RawBuilder<string | null> =>
  sql<string | null>`(case
    when ${col} is null then null
    when not isfinite(${col}) then ${col}::text
    when extract(year from ${col} at time zone 'UTC') between 1 and 9999
      then to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    else ${exactTimestampText(col)}
  end)`;

/**
 * Session-timezone date display of a timestamptz (case `sourceOpenedAt` only —
 * its existing session-date interpretation is kept): `YYYY-MM-DD` for AD years
 * 1–9999; otherwise the date with its era in the same timezone
 * (`0001-12-31 BC`, `10000-01-01 AD`), or `infinity`/`-infinity`.
 */
export const sessionDateDisplay = (col: RawBuilder<unknown>): RawBuilder<string | null> =>
  sql<string | null>`(case
    when ${col} is null then null
    when not isfinite(${col}) then ${col}::text
    when extract(year from ${col}) between 1 and 9999 then to_char(${col}, 'YYYY-MM-DD')
    else to_char(${col}, 'YYYY-MM-DD BC')
  end)`;

/**
 * Native `date` display (hearing pronouncement/document dates, appeal date):
 * `YYYY-MM-DD` for AD years 1–9999; otherwise the full native year (padded to
 * at least four digits, never truncated) with an explicit era (`0001-12-31 BC`,
 * `10000-01-01 AD`, `5874897-12-31 AD`), or `infinity`/`-infinity`. Built from
 * the date's own components: no to_char, no timestamp cast (which would fail
 * past the timestamp range), no DateStyle-dependent `::text` of a finite date.
 */
export const nativeDateDisplay = (col: RawBuilder<unknown>): RawBuilder<string | null> => {
  const year = sql`extract(year from ${col})::integer`;
  return sql<string | null>`(case
    when ${col} is null then null
    when not isfinite(${col}) then ${col}::text
    else lpad(abs(${year})::text, greatest(4, length(abs(${year})::text)), '0')
      || '-' || lpad(extract(month from ${col})::integer::text, 2, '0')
      || '-' || lpad(extract(day from ${col})::integer::text, 2, '0')
      || (case when ${year} < 0 then ' BC' when ${year} > 9999 then ' AD' else '' end)
  end)`;
};
