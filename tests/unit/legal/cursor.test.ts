/**
 * Legal — keyset cursor SQL shape (pure render via Kysely's compiler). Covers the
 * Codex finding: a non-null cursor in BOTH directions must keep the `IS NULL`
 * (NULLS LAST) section reachable, and `act_id` is compared `::bigint` (not text).
 */

import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { keysetCursor } from '@/modules/legal/shell/repo/filter-helpers.js';

// A driverless Kysely just to compile `sql` fragments to a parameterized string.
const db = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (d) => new PostgresIntrospector(d),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const render = (frag: ReturnType<typeof keysetCursor>): string =>
  sql`select 1 where ${frag}`.compile(db).sql;

describe('keysetCursor — null-section reachability + bigint tiebreak', () => {
  it('desc non-null cursor keeps the IS NULL section reachable', () => {
    const s = render(keysetCursor(sql`a.act_year`, 'int', '2015', '66150', 'desc'));
    expect(s).toContain('is null');
    expect(s).toContain('::bigint'); // act_id compared as bigint
    expect(s).toContain('::int'); // sort value cast
  });

  it('asc non-null cursor ALSO keeps the IS NULL section reachable (Codex fix)', () => {
    const s = render(keysetCursor(sql`a.act_year`, 'int', '2015', '66150', 'asc'));
    expect(s).toContain('is null'); // the bug was the asc path dropping this
    expect(s).toContain('::bigint');
  });

  it('null cursor (sentinel "") restricts to the null section by the act_id tiebreak', () => {
    const s = render(keysetCursor(sql`a.act_year`, 'int', '', '66150', 'desc'));
    expect(s).toContain('is null');
    expect(s).toContain('::bigint');
  });

  it('text sort (display_citation) emits no cast on the sort value', () => {
    const s = render(keysetCursor(sql`a.display_citation`, 'text', 'Legea', '66150', 'asc'));
    expect(s).not.toContain('::int');
    expect(s).not.toContain('::date');
    expect(s).toContain('::bigint'); // act_id still bigint
  });
});
