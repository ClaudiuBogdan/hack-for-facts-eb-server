/**
 * The ANAF-assumed main activity on the REAL repository SQL path (scripted
 * driver, nothing executes): ONE statement reads the assignment and the
 * flags from the two public views; history reads only the public history
 * views with a keyset bound; no base table, correction, refresh log, probe,
 * admission or raw custody relation is ever named; a capability SQLSTATE is
 * the part's `unavailable` state; every vocabulary value fails closed.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  MAIN_CLASS_FLAG_BOUND,
  mainActivityWitness,
} from '@/modules/companies/core/main-activity.js';
import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';
import { mapAssignment, rowWitness } from '@/modules/companies/shell/repo/main-activity-sql.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim();

class ScriptedDriver extends DummyDriver {
  constructor(private readonly answer: (statement: Statement) => readonly unknown[]) {
    super();
  }

  override acquireConnection(): Promise<DatabaseConnection> {
    const answer = this.answer;
    return Promise.resolve({
      executeQuery: (query) => {
        try {
          return Promise.resolve({
            rows: [...answer({ sql: flat(query.sql), parameters: query.parameters })] as never[],
          });
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      streamQuery: async function* () {
        // never streamed
      },
    });
  }
}

const scriptedDb = (answer: (statement: Statement) => readonly unknown[] = () => []) => {
  const statements: Statement[] = [];
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new ScriptedDriver((statement) => {
          statements.push(statement);
          return answer(statement);
        }),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
};

const sqlState = (code: string): Error => Object.assign(new Error(`sqlstate ${code}`), { code });

const CUI = '2816464';

/** Only the four public main views; never a base table or operator surface. */
const ALLOWED_MAIN =
  /companies_v2\.main_caen_(?!current_assignments\b|class_flags\b|public_resolutions\b|public_supports\b)/u;
const FORBIDDEN: readonly RegExp[] = [
  /\b(?:companies_v2\.)?(?:fiscal_status|company_fiscal_admissions|onrc_current_caen_observations)\b(?!_)/u,
  /main_caen_unbound_probes|main_caen_company_timeline|fiscal_observation_custody/u,
];

const expectOnlyPublicViews = (statements: readonly Statement[]): void => {
  expect(statements.length).toBeGreaterThan(0);
  for (const s of statements) {
    expect(s.sql).not.toMatch(ALLOWED_MAIN);
    for (const pattern of FORBIDDEN) expect(s.sql).not.toMatch(pattern);
  }
};

const assignmentRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  resolution_id: '11',
  support_id: '21',
  status: 'resolved',
  main_role_basis: 'anaf_assumed_main',
  policy_version: 'anaf-assumed-main-caen-v1',
  anaf_original_token: '610',
  anaf_json_type: 'string',
  anaf_token_form: 'other_digit_form',
  anaf_canonical_digits: '610',
  anaf_assumed_code: null,
  anaf_v3_form: 'three_digit',
  revision_basis: 'unique_onrc_match',
  match_basis: 'leading_zero_match',
  candidate_keys: ['rev2:0610'],
  resolved_revision: 'rev2',
  resolved_code: '0610',
  resolved_label: 'Extracția petrolului brut',
  correction_id: null,
  edition_id: '7',
  edition_source_published_at: '2026-07-08',
  onrc_caen_coverage: 'complete',
  fiscal_source_snapshot_id: 'anaf:2026-06-15',
  fiscal_source_hash: 'b'.repeat(64),
  fiscal_status_date: '2026-06-15',
  fiscal_retrieved_at: '2026-06-15T08:00:00.000000Z',
  fiscal_source_url: 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva',
  fiscal_raw_capture_id: null,
  fiscal_raw_custody_id: null,
  evidence_custody: 'pointer_bound_at_derivation',
  fiscal_time_basis: 'native',
  fiscal_raw_retrieved_at: null,
  derived_at: '2026-10-13T22:30:00.000000Z',
  evidence_at: '2026-10-13T22:30:00.000000Z',
  refreshed_at: '2026-10-13T22:30:00.000000Z',
  refresh_id: '3',
  content_epoch: '2',
  currentness: 'current',
  anaf_withdrawn: false,
  integrity_held: false,
  ...over,
});

const flagRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  revision: 'rev2',
  code: '0610',
  is_main_caen: true,
  matches_assumed_main_code: true,
  currentness: 'current',
  resolution_id: '11',
  edition_id: '7',
  ...over,
});

const SOURCE_WITHDRAWN = assignmentRow({
  status: null,
  revision_basis: null,
  match_basis: null,
  candidate_keys: null,
  resolved_revision: null,
  resolved_code: null,
  resolved_label: null,
  anaf_original_token: null,
  anaf_json_type: null,
  anaf_token_form: null,
  anaf_canonical_digits: null,
  anaf_v3_form: null,
  fiscal_source_snapshot_id: null,
  fiscal_source_hash: null,
  fiscal_status_date: null,
  fiscal_retrieved_at: null,
  fiscal_source_url: null,
  evidence_custody: null,
  fiscal_time_basis: null,
  currentness: 'source_withdrawn',
  anaf_withdrawn: true,
});

describe('readMainActivity (repo.getMainActivity)', () => {
  const twoFlags = () => [
    flagRow(),
    flagRow({ code: '4711', is_main_caen: false, matches_assumed_main_code: false }),
  ];

  it('with flags: the assignment and the flags in ONE statement from the two public views', async () => {
    const { db, statements } = scriptedDb(() => [
      { assignment: assignmentRow(), flags: twoFlags() },
    ]);
    const res = (
      await makeCompaniesRepo(db).getMainActivity(`RO ${CUI}`, { flags: true })
    )._unsafeUnwrap();
    expect(statements).toHaveLength(1);
    const text = statements[0]!.sql;
    expect(text).toContain('from companies_v2.main_caen_current_assignments a where a.cui = $1');
    expect(text).toContain('from companies_v2.main_caen_class_flags f where f.cui = $2');
    expect(text).toContain("'anaf_withdrawn', a.anaf_withdrawn");
    expect(text).toContain("'integrity_held', a.integrity_held");
    expect(statements[0]!.parameters).toEqual([CUI, CUI, MAIN_CLASS_FLAG_BOUND + 1]);
    expectOnlyPublicViews(statements);
    expect(res).toMatchObject({
      assignment: {
        state: 'row',
        witness: rowWitness(assignmentRow()),
        activity: {
          status: 'resolved',
          anafWithdrawn: false,
          matchBasis: 'leading_zero_match',
          resolved: { revision: 'rev2', code: '0610', labelSource: 'frozen_at_derivation' },
          candidates: [{ revision: 'rev2', code: '0610' }],
          anaf: { originalToken: '610', canonicalDigits: '610', assumedCode: null },
          edition: { editionId: '7', sourcePublishedAt: '2026-07-08' },
        },
      },
      flags: {
        state: 'read',
        flags: [
          { revision: 'rev2', code: '0610', isMainCaen: true },
          { revision: 'rev2', code: '4711', isMainCaen: false },
        ],
      },
    });
  });

  it('main only: never names the flag view (no irrelevant flag list)', async () => {
    const { db, statements } = scriptedDb(() => [{ assignment: assignmentRow() }]);
    const res = (
      await makeCompaniesRepo(db).getMainActivity(CUI, { flags: false })
    )._unsafeUnwrap();
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).not.toContain('main_caen_class_flags');
    expect(res).toMatchObject({ assignment: { state: 'row' }, flags: { state: 'not_requested' } });
  });

  it('no assignment row is none (flags still listed)', async () => {
    const { db } = scriptedDb(() => [
      {
        assignment: null,
        flags: [
          flagRow({
            is_main_caen: null,
            matches_assumed_main_code: null,
            currentness: 'no_assignment',
            resolution_id: null,
          }),
        ],
      },
    ]);
    const res = (await makeCompaniesRepo(db).getMainActivity(CUI, { flags: true }))._unsafeUnwrap();
    expect(res).toMatchObject({
      assignment: { state: 'none' },
      flags: { state: 'read', flags: [{ currentness: 'no_assignment' }] },
    });
  });

  it.each(['42P01', '42703', '42883', '42501'])(
    'a capability SQLSTATE %s on every statement is the unavailable state, never an error',
    async (code) => {
      const { db } = scriptedDb(() => {
        throw sqlState(code);
      });
      for (const flags of [true, false]) {
        expect(
          (await makeCompaniesRepo(db).getMainActivity(CUI, { flags }))._unsafeUnwrap()
        ).toEqual({
          assignment: { state: 'unavailable' },
          flags: { state: flags ? 'unavailable' : 'not_requested' },
        });
      }
    }
  );

  it('readable assignment + missing/denied flag view: the main activity is served, flags unavailable, the witness agrees', async () => {
    for (const code of ['42P01', '42501']) {
      const { db, statements } = scriptedDb((statement) => {
        if (statement.sql.includes('main_caen_class_flags')) throw sqlState(code);
        return [{ assignment: assignmentRow() }];
      });
      const repo = makeCompaniesRepo(db);
      const res = (await repo.getMainActivity(CUI, { flags: true }))._unsafeUnwrap();
      expect(res.flags).toEqual({ state: 'unavailable' });
      expect(res.assignment.state).toBe('row');
      expect(mainActivityWitness(res)).toBe(
        (await repo.readMainActivityWitness(CUI))._unsafeUnwrap()
      );
      expect(statements).toHaveLength(3);
    }
  });

  it('any other failure is a Database error, never unavailable', async () => {
    const { db } = scriptedDb(() => {
      throw sqlState('57014');
    });
    expect(
      (await makeCompaniesRepo(db).getMainActivity(CUI, { flags: true }))._unsafeUnwrapErr().type
    ).toBe('Database');
  });

  it('a flag set past its bound is overflow (null flags), never truncated and never refusing the main activity', async () => {
    const flags = Array.from({ length: MAIN_CLASS_FLAG_BOUND + 1 }, (_, i) =>
      flagRow({ code: String(1000 + i).slice(-4) })
    );
    const { db } = scriptedDb(() => [{ assignment: assignmentRow(), flags }]);
    const res = (await makeCompaniesRepo(db).getMainActivity(CUI, { flags: true }))._unsafeUnwrap();
    expect(res.flags).toEqual({ state: 'overflow' });
    expect(res.assignment).toMatchObject({ state: 'row', activity: { status: 'resolved' } });
  });

  it('a malformed flag or row shape fails closed', async () => {
    for (const answer of [
      { assignment: assignmentRow(), flags: [flagRow({ currentness: 'fresh' })] },
      { assignment: assignmentRow(), flags: [flagRow({ revision: 'rev4' })] },
      { assignment: { ...assignmentRow(), resolution_id: 11 }, flags: [] },
      { assignment: { ...assignmentRow(), anaf_withdrawn: null }, flags: [] },
    ]) {
      const { db } = scriptedDb(() => [answer]);
      expect(
        (await makeCompaniesRepo(db).getMainActivity(CUI, { flags: true }))._unsafeUnwrapErr().type
      ).toBe('Database');
    }
  });
});

describe('mapAssignment: the vocabulary fails closed', () => {
  const map = (over: Record<string, unknown>) =>
    mapAssignment(assignmentRow(over) as Parameters<typeof mapAssignment>[0], 'a:w');

  it.each([
    ['an unknown currentness', { currentness: 'stale' }],
    ['an unknown status', { status: 'resolved_somehow' }],
    ['another policy', { policy_version: 'anaf-assumed-main-caen-v3' }],
    ['an unknown role basis', { main_role_basis: 'onrc_principal' }],
    ['an unknown match basis', { match_basis: 'numeric' }],
    ['an unknown token form', { anaf_token_form: 'padded' }],
    ['an unknown custody', { evidence_custody: 'archived' }],
    ['a malformed candidate', { candidate_keys: ['rev2:610'] }],
    ['a selection without its label', { resolved_label: null }],
    ['a blank label', { resolved_label: '  ' }],
    ['a selection on a non-selecting status', { status: 'no_onrc_match' }],
    [
      'a status under a suppressing currentness',
      { currentness: 'onrc_unavailable', edition_id: null },
    ],
    [
      'a missing status while current',
      {
        status: null,
        match_basis: null,
        revision_basis: null,
        candidate_keys: null,
        resolved_revision: null,
        resolved_code: null,
        resolved_label: null,
      },
    ],
    [
      'source_withdrawn without the withdrawal flag',
      { ...SOURCE_WITHDRAWN, anaf_withdrawn: false },
    ],
    [
      'an edition while onrc_unavailable',
      {
        currentness: 'onrc_unavailable',
        status: null,
        match_basis: null,
        revision_basis: null,
        candidate_keys: null,
        resolved_revision: null,
        resolved_code: null,
        resolved_label: null,
      },
    ],
    ['a padded assumed code', { anaf_assumed_code: '610' }],
    [
      'a withheld interpretation that still carries candidates',
      {
        currentness: 'pending_refresh',
        status: null,
        match_basis: null,
        revision_basis: null,
        resolved_revision: null,
        resolved_code: null,
        resolved_label: null,
      },
    ],
  ])('refuses %s', (_what, over) => {
    expect(map(over).isErr()).toBe(true);
  });

  it('SOURCE_WITHDRAWN: no ANAF object at all, no interpretation, the edition kept', () => {
    const activity = mapAssignment(
      SOURCE_WITHDRAWN as Parameters<typeof mapAssignment>[0],
      'a:w'
    )._unsafeUnwrap();
    expect(activity).toMatchObject({
      currentness: 'source_withdrawn',
      anafWithdrawn: true,
      status: null,
      resolved: null,
      candidates: null,
      anaf: null,
      edition: { editionId: '7' },
    });
  });

  it('ONRC_UNAVAILABLE + fiscal withdrawal: the WHOLE ANAF object is null (even if a field leaked)', () => {
    const activity = map({
      currentness: 'onrc_unavailable',
      anaf_withdrawn: true,
      status: null,
      match_basis: null,
      revision_basis: null,
      candidate_keys: null,
      resolved_revision: null,
      resolved_code: null,
      resolved_label: null,
      edition_id: null,
      edition_source_published_at: null,
      onrc_caen_coverage: null,
      // the v2 provenance is suppressed with the source, as the view does
      fiscal_time_basis: null,
      // a defensive check: a value the view should have nulled is never served
      fiscal_status_date: '2026-06-15',
    })._unsafeUnwrap();
    expect(activity).toMatchObject({
      currentness: 'onrc_unavailable',
      anafWithdrawn: true,
      anaf: null,
      edition: null,
    });
  });

  it('ONRC_UNAVAILABLE alone keeps the ANAF evidence', () => {
    const activity = map({
      currentness: 'onrc_unavailable',
      status: null,
      match_basis: null,
      revision_basis: null,
      candidate_keys: null,
      resolved_revision: null,
      resolved_code: null,
      resolved_label: null,
      edition_id: null,
    })._unsafeUnwrap();
    expect(activity.anaf).toMatchObject({ originalToken: '610', statusDate: '2026-06-15' });
  });

  it('accepts the integrity-hold shape: PENDING_REFRESH, suppressed interpretation and token fields, source dates kept', () => {
    const activity = map({
      integrity_held: true,
      currentness: 'pending_refresh',
      status: null,
      match_basis: null,
      revision_basis: null,
      candidate_keys: null,
      resolved_revision: null,
      resolved_code: null,
      resolved_label: null,
      anaf_original_token: null,
      anaf_json_type: null,
      anaf_token_form: null,
      anaf_canonical_digits: null,
      anaf_v3_form: null,
    })._unsafeUnwrap();
    expect(activity).toMatchObject({
      currentness: 'pending_refresh',
      integrityHeld: true,
      status: null,
      resolved: null,
      candidates: null,
      anaf: { originalToken: null, tokenForm: null, statusDate: '2026-06-15' },
    });
  });

  it('accepts a hold combined with ONRC_UNAVAILABLE or SOURCE_WITHDRAWN (the view reports those first); never a key or token', () => {
    const suppressed = {
      integrity_held: true,
      status: null,
      match_basis: null,
      revision_basis: null,
      candidate_keys: null,
      resolved_revision: null,
      resolved_code: null,
      resolved_label: null,
      anaf_original_token: null,
      anaf_json_type: null,
      anaf_token_form: null,
      anaf_canonical_digits: null,
      anaf_v3_form: null,
    };
    const onrc = map({
      ...suppressed,
      currentness: 'onrc_unavailable',
      edition_id: null,
    })._unsafeUnwrap();
    expect(onrc).toMatchObject({
      currentness: 'onrc_unavailable',
      integrityHeld: true,
      resolved: null,
      anaf: { originalToken: null, statusDate: '2026-06-15' },
    });
    const both = map({ ...SOURCE_WITHDRAWN, ...suppressed })._unsafeUnwrap();
    expect(both).toMatchObject({
      currentness: 'source_withdrawn',
      integrityHeld: true,
      anafWithdrawn: true,
      anaf: null,
      resolved: null,
    });
  });

  it('refuses a held source that is current, interpreted or still shows a token', () => {
    const held = {
      integrity_held: true,
      currentness: 'pending_refresh',
      status: null,
      match_basis: null,
      revision_basis: null,
      candidate_keys: null,
      resolved_revision: null,
      resolved_code: null,
      resolved_label: null,
      anaf_original_token: null,
      anaf_json_type: null,
      anaf_token_form: null,
      anaf_canonical_digits: null,
      anaf_v3_form: null,
    };
    expect(map(held).isOk()).toBe(true);
    expect(map({ integrity_held: true }).isErr()).toBe(true); // current + interpreted
    expect(map({ ...held, anaf_original_token: '6201', anaf_json_type: 'string' }).isErr()).toBe(
      true
    );
    expect(map({ ...held, anaf_token_form: 'four_digit' }).isErr()).toBe(true);
  });

  it.each([
    ['string', 'private@example.com', 'invalid'],
    ['string', '+40 721 234 567', 'invalid'],
    ['number', '40721234567', 'invalid'],
    ['object', '{"email":"private@example.com"}', 'invalid'],
    ['array', '["0610"]', 'invalid'],
  ])(
    'never forwards a malformed %s token (contact / object / phone-like): null token, diagnostics kept',
    (jsonType, token, form) => {
      const activity = map({
        status: 'token_invalid',
        match_basis: null,
        revision_basis: null,
        candidate_keys: [],
        resolved_revision: null,
        resolved_code: null,
        resolved_label: null,
        anaf_json_type: jsonType,
        anaf_original_token: token,
        anaf_token_form: form,
        anaf_canonical_digits: null,
      })._unsafeUnwrap();
      expect(activity.anaf).toMatchObject({ originalToken: null, jsonType, tokenForm: form });
      expect(JSON.stringify(activity)).not.toContain('example.com');
      expect(JSON.stringify(activity)).not.toContain('721');
    }
  );

  it.each(['610', '0610', '000610', '9999', '0000'])('serves the valid original %s', (token) => {
    expect(map({ anaf_original_token: token })._unsafeUnwrap().anaf?.originalToken).toBe(token);
  });

  it('never serves a v3 form outside its vocabulary', () => {
    expect(
      map({ anaf_v3_form: 'call me at private@example.com' })._unsafeUnwrap().anaf?.v3Form
    ).toBeNull();
    expect(map({ anaf_v3_form: 'three_digit' })._unsafeUnwrap().anaf?.v3Form).toBe('three_digit');
    // 'absent' is a JSON type/form census value, never a v3 form (root answer serving02 Q3).
    expect(map({ anaf_v3_form: 'absent' })._unsafeUnwrap().anaf?.v3Form).toBeNull();
  });

  it('serves an all-zero canonical form as no digits', () => {
    const activity = map({
      status: 'token_placeholder',
      match_basis: null,
      revision_basis: null,
      candidate_keys: [],
      resolved_revision: null,
      resolved_code: null,
      resolved_label: null,
      anaf_original_token: '0000',
      anaf_token_form: 'zero_placeholder',
      anaf_canonical_digits: '',
    })._unsafeUnwrap();
    expect(activity.anaf).toMatchObject({ originalToken: '0000', canonicalDigits: null });
  });
});

describe('readMainActivityWitness', () => {
  it('is the digest of the whole public row: a masking with unchanged ids, epoch and currentness moves it', async () => {
    const masked = assignmentRow({
      currentness: 'onrc_unavailable',
      status: null,
      match_basis: null,
      revision_basis: null,
      candidate_keys: null,
      resolved_revision: null,
      resolved_code: null,
      resolved_label: null,
      edition_id: null,
    });
    const both = {
      ...masked,
      anaf_withdrawn: true,
      anaf_original_token: null,
      fiscal_status_date: null,
    };
    const read = async (row: Record<string, unknown>) => {
      const { db, statements } = scriptedDb(() => [{ assignment: row }]);
      const witness = (await makeCompaniesRepo(db).readMainActivityWitness(CUI))._unsafeUnwrap();
      expectOnlyPublicViews(statements);
      return witness;
    };
    const before = await read(masked);
    const after = await read(both);
    expect(before).toMatch(/^a:[0-9a-f]{64}$/u);
    expect(after).not.toBe(before);
    expect(before).toBe(rowWitness(masked));
  });

  it('none without a row, unavailable on a capability failure', async () => {
    expect(
      (
        await makeCompaniesRepo(
          scriptedDb(() => [{ assignment: null }]).db
        ).readMainActivityWitness(CUI)
      )._unsafeUnwrap()
    ).toBe('none');
    const { db } = scriptedDb(() => {
      throw sqlState('42501');
    });
    expect((await makeCompaniesRepo(db).readMainActivityWitness(CUI))._unsafeUnwrap()).toBe(
      'unavailable'
    );
  });
});

describe('readMainActivityHistory', () => {
  const outcomeRow = (over: Record<string, unknown> = {}) => ({
    resolution_id: '11',
    previous_resolution_id: null,
    refresh_id: '3',
    reasons: ['first_assignment'],
    policy_version: 'anaf-assumed-main-caen-v1',
    main_role_basis: 'anaf_assumed_main',
    status: 'resolved',
    revision_basis: 'unique_onrc_match',
    match_basis: 'leading_zero_match',
    anaf_original_token: '610',
    anaf_json_type: 'string',
    anaf_token_form: 'other_digit_form',
    anaf_canonical_digits: '610',
    anaf_assumed_code: null,
    edition_id: '7',
    candidate_keys: ['rev2:0610'],
    resolved_revision: 'rev2',
    resolved_code: '0610',
    resolved_label: 'Extracția petrolului brut',
    correction_id: null,
    derived_at: '2026-10-13T22:30:00.000000Z',
    anaf_withdrawn: false,
    onrc_withdrawn: false,
    ...over,
  });

  it('outcomes: the public resolutions view, newest first, keyset bound and limit', async () => {
    const { db, statements } = scriptedDb(() => [outcomeRow()]);
    const res = (
      await makeCompaniesRepo(db).getMainActivityHistory(CUI, {
        kind: 'outcomes',
        beforeId: '40',
        limit: 21,
      })
    )._unsafeUnwrap();
    expectOnlyPublicViews(statements);
    expect(statements[0]!.sql).toContain('from companies_v2.main_caen_public_resolutions r');
    expect(statements[0]!.sql).toContain(
      'and ($2::bigint is null or "r"."resolution_id" < $3::bigint)'
    );
    expect(statements[0]!.sql).toContain('order by r.resolution_id desc');
    expect(statements[0]!.parameters).toEqual([CUI, '40', '40', 21]);
    expect(res).toMatchObject({
      state: 'read',
      outcomes: [{ resolutionId: '11', status: 'resolved' }],
    });
  });

  it('a withdrawn ANAF source serves no ANAF fields and no interpretation', async () => {
    const { db } = scriptedDb(() => [
      outcomeRow({
        anaf_withdrawn: true,
        status: null,
        revision_basis: null,
        match_basis: null,
        candidate_keys: null,
        resolved_revision: null,
        resolved_code: null,
        resolved_label: null,
        anaf_original_token: null,
        anaf_json_type: null,
        anaf_token_form: null,
        anaf_canonical_digits: null,
      }),
    ]);
    const res = (
      await makeCompaniesRepo(db).getMainActivityHistory(CUI, {
        kind: 'outcomes',
        beforeId: null,
        limit: 2,
      })
    )._unsafeUnwrap();
    expect(res).toMatchObject({
      state: 'read',
      outcomes: [{ anaf: null, status: null, resolved: null, anafWithdrawn: true }],
    });
  });

  it('an interpretation served while a source is withdrawn fails closed', async () => {
    const { db } = scriptedDb(() => [outcomeRow({ onrc_withdrawn: true })]);
    expect(
      (
        await makeCompaniesRepo(db).getMainActivityHistory(CUI, {
          kind: 'outcomes',
          beforeId: null,
          limit: 2,
        })
      )._unsafeUnwrapErr().type
    ).toBe('Database');
  });

  it('evidence: the public supports view, no keyset on the first page', async () => {
    const { db, statements } = scriptedDb(() => [
      {
        support_id: '21',
        previous_support_id: null,
        resolution_id: '11',
        refresh_id: '3',
        edition_id: '7',
        fiscal_source_snapshot_id: 'anaf:2026-06-15',
        fiscal_source_hash: 'b'.repeat(64),
        fiscal_status_date: '2026-06-15',
        fiscal_retrieved_at: '2026-06-15T08:00:00.000000Z',
        fiscal_source_url: null,
        fiscal_raw_capture_id: '901',
        fiscal_raw_custody_id: null,
        evidence_custody: 'archived_exchange',
        fiscal_time_basis: 'native',
        fiscal_raw_retrieved_at: null,
        anaf_original_token: '610',
        anaf_json_type: 'number',
        onrc_caen_coverage: 'complete',
        evidence_at: '2026-10-13T22:30:00.000000Z',
        anaf_withdrawn: false,
        onrc_withdrawn: false,
      },
    ]);
    const res = (
      await makeCompaniesRepo(db).getMainActivityHistory(CUI, {
        kind: 'evidence',
        beforeId: null,
        limit: 21,
      })
    )._unsafeUnwrap();
    expectOnlyPublicViews(statements);
    expect(statements[0]!.sql).toContain('from companies_v2.main_caen_public_supports s');
    expect(statements[0]!.parameters).toEqual([CUI, null, null, 21]);
    expect(res).toMatchObject({
      state: 'read',
      evidence: [
        {
          supportId: '21',
          anaf: { rawCaptureId: '901', evidenceCustody: 'archived_exchange', jsonType: 'number' },
        },
      ],
    });
  });

  it('never forwards a malformed token on the outcome or evidence path', async () => {
    const outcomes = scriptedDb(() => [
      outcomeRow({
        status: 'token_invalid',
        match_basis: null,
        revision_basis: null,
        candidate_keys: [],
        resolved_revision: null,
        resolved_code: null,
        resolved_label: null,
        anaf_json_type: 'object',
        anaf_original_token: '{"email":"private@example.com"}',
        anaf_token_form: 'invalid',
        anaf_canonical_digits: null,
      }),
    ]);
    const o = (
      await makeCompaniesRepo(outcomes.db).getMainActivityHistory(CUI, {
        kind: 'outcomes',
        beforeId: null,
        limit: 2,
      })
    )._unsafeUnwrap();
    expect(JSON.stringify(o)).not.toContain('example.com');
    expect(o).toMatchObject({
      outcomes: [{ anaf: { originalToken: null, jsonType: 'object', tokenForm: 'invalid' } }],
    });

    const evidence = scriptedDb(() => [
      {
        support_id: '21',
        previous_support_id: null,
        resolution_id: '11',
        refresh_id: '3',
        edition_id: '7',
        fiscal_source_snapshot_id: 's',
        fiscal_source_hash: 'b'.repeat(64),
        fiscal_status_date: '2026-06-15',
        fiscal_retrieved_at: null,
        fiscal_source_url: null,
        fiscal_raw_capture_id: null,
        fiscal_raw_custody_id: null,
        evidence_custody: 'pointer_bound_at_derivation',
        fiscal_time_basis: 'native',
        fiscal_raw_retrieved_at: null,
        anaf_original_token: '0721234567',
        anaf_json_type: 'string',
        onrc_caen_coverage: null,
        evidence_at: '2026-10-13T22:30:00.000000Z',
        anaf_withdrawn: false,
        onrc_withdrawn: false,
      },
    ]);
    const e = (
      await makeCompaniesRepo(evidence.db).getMainActivityHistory(CUI, {
        kind: 'evidence',
        beforeId: null,
        limit: 2,
      })
    )._unsafeUnwrap();
    expect(JSON.stringify(e)).not.toContain('0721234567');
    expect(e).toMatchObject({ evidence: [{ anaf: { originalToken: null, jsonType: 'string' } }] });
  });

  it("reads the exact served rows' current visibility by id from the public view", async () => {
    const { db, statements } = scriptedDb(() => [
      { id: '11', anaf_withdrawn: false, onrc_withdrawn: true },
    ]);
    const res = (
      await makeCompaniesRepo(db).readMainActivityHistoryVisibility(CUI, 'outcomes', ['11', '10'])
    )._unsafeUnwrap();
    expectOnlyPublicViews(statements);
    expect(statements[0]!.sql).toContain('from companies_v2.main_caen_public_resolutions r');
    expect(statements[0]!.parameters).toEqual([CUI, '["11","10"]']);
    expect(res).toEqual(new Map([['11', 'false:true']]));
  });

  it('a capability failure is unavailable', async () => {
    const { db } = scriptedDb(() => {
      throw sqlState('42P01');
    });
    expect(
      (
        await makeCompaniesRepo(db).getMainActivityHistory(CUI, {
          kind: 'evidence',
          beforeId: null,
          limit: 2,
        })
      )._unsafeUnwrap()
    ).toEqual({ state: 'unavailable' });
  });
});
