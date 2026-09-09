import { describe, expect, it } from 'vitest';

import { makeParliamentRepo } from '@/modules/parliament/shell/repo/parliament-repo.js';

import { makeCapturingDb } from '../../fixtures/capturing-db.js';

interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const flat = (value: string): string => value.replace(/\s+/gu, ' ').trim();

describe('canonical vote-position SQL', () => {
  it('serves one current logical position and its lossless observation metadata', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const result = await repo.listVoteRecords('senat:1', { first: 20 });
    expect(result.isOk()).toBe(true);

    const query = flat(captured[0]?.sql ?? '');
    expect(query).toContain('from "parliament"."vote_positions" as "vp"');
    expect(query).toContain('"vp"."is_current" = true');
    expect(query).toContain('"vp"."position_status"');
    expect(query).toContain('"vp"."observed_choices"');
    expect(query).toContain('"vp"."group_name_variant_count"');
    expect(query).not.toContain('vote_records');
  });

  it('reports conflicts and unknowns outside every effective-choice bucket', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const result = await repo.voteGroupBreakdown('senat:1');
    expect(result.isOk()).toBe(true);

    const query = flat(captured[0]?.sql ?? '');
    expect(query).toContain('"vp"."position_status" = \'confirmed\'');
    expect(query).toContain("vp.position_status = 'conflicting_choice'");
    expect(query).toContain("vp.position_status in ('unknown_marker', 'identity_conflict')");
    expect(query).toContain("vp.effective_choice = 'nu_a_votat'");
    expect(query).toContain('"vp"."group_name_variant_count" =');
  });

  it('applies member choice filters only to an effective canonical choice', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const result = await repo.listMemberVotes(
      'senat:2024:1',
      { first: 20 },
      { choice: { in: ['pentru'] } }
    );
    expect(result.isOk()).toBe(true);

    const query = flat(captured[0]?.sql ?? '');
    expect(query).toContain('"vp"."effective_choice" in');
    expect(query).toContain('"vp"."is_current" = true');
    expect(query).not.toContain('"vo"."choice"');
  });

  it('includes non-choice participation in cohesion percentages', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const result = await repo.cohesionForVoteKeys(['senat:1']);
    expect(result.isOk()).toBe(true);

    const query = flat(captured[0]?.sql ?? '');
    expect(query).toContain("vp.position_status = 'conflicting_choice'");
    expect(query).toContain("vp.position_status in ('unknown_marker', 'identity_conflict')");
    expect(query).toContain('count(distinct vp.vote_key)');
    expect(query).toContain('"vp"."group_name_variant_count" =');
  });
});
