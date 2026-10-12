/**
 * The derived activity selection rule (CAEN contract §B), ONE case table over
 * every branch of the agreement and the basis, written by hand: the class keys
 * of the edition aggregate, the fiscal row's receipt-proven form and the
 * catalog candidates. ANAF never yields a revision; a selected ONRC key keeps
 * its exact label; an ANAF code gets catalog candidates only.
 */

import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_AGGREGATE_BOUND_MESSAGE,
  ACTIVITY_AGGREGATE_GROUP_BOUND,
  activityCatalogCodes,
  selectActivity,
  type ActivityFiscalObservation,
  type ActivitySelectionInput,
  type CaenClassStateGroup,
  type CompanyActivityBasis,
  type CompanyAnafCaenForm,
  type CompanyAnafOnrcAgreement,
} from '@/modules/companies/core/activity-selection.js';

import type { CaenCatalogDescription } from '@/modules/companies/core/caen-descriptions.js';

const cls = (revision: string, code: string, rows = 1): CaenClassStateGroup => ({
  revision,
  code,
  classState: 'class',
  rows,
});
const other = (
  classState: string,
  revision: string | null,
  code: string | null,
  rows = 1
): CaenClassStateGroup => ({ revision, code, classState, rows });
/**
 * A fiscal row as the database answers it: the form, its usability under the
 * form policy and the code's catalog membership are INPUTS (decided by the
 * database functions), never derived by the rule.
 */
const fiscal = (
  code: string | null,
  form: string | null,
  usable: boolean | null,
  catalogued: boolean | null = false,
  statusDate: string | null = '2026-09-28'
): ActivityFiscalObservation => ({
  code,
  form,
  usable,
  policy: 'anaf-caen-form-policy-v1',
  catalogued,
  statusDate,
});

/** The current catalog: `rev:code` → label (blank labels are kept as given). */
const CATALOG: Readonly<Record<string, string | null>> = {
  'rev2:6201': 'Activități de realizare a soft-ului la comandă',
  'rev3:6201': 'Activități de realizare a software-ului la comandă',
  'rev2:4711': 'Comerț cu amănuntul în magazine nespecializate',
  'rev3:4711': 'Comerț cu amănuntul în magazine nespecializate',
  'rev2:0111': 'Cultivarea cerealelor',
  'rev2:0000': 'Placeholder text never used',
};

const catalogFor = (
  codes: readonly string[]
): ReadonlyMap<string, readonly CaenCatalogDescription[]> =>
  new Map(
    codes.map((code) => [
      code,
      Object.entries(CATALOG).flatMap(([key, label]) =>
        key.endsWith(`:${code}`) ? [{ revision: key.slice(0, key.indexOf(':')), label }] : []
      ),
    ])
  );

const input = (
  groups: readonly CaenClassStateGroup[],
  f: ActivityFiscalObservation | null,
  over: Partial<ActivitySelectionInput> = {}
): ActivitySelectionInput => ({
  groups,
  fiscal: f,
  catalog: catalogFor(activityCatalogCodes(groups, f?.code ?? null)),
  caenCoverage: 'complete',
  editionId: '7',
  editionSourceDate: '2026-07-08',
  ...over,
});

interface Case {
  readonly name: string;
  readonly groups: readonly CaenClassStateGroup[];
  readonly fiscal: ActivityFiscalObservation | null;
  readonly basis: CompanyActivityBasis;
  readonly agreement: CompanyAnafOnrcAgreement;
  readonly form: CompanyAnafCaenForm;
  readonly source: 'ONRC' | 'ANAF' | null;
  readonly revision: string | null;
  readonly code: string | null;
  readonly classKeyCount: number;
}

const CASES: readonly Case[] = [
  // |K| = 1: always the single key, whatever ANAF says.
  {
    name: '|K|=1, ANAF has the same digits',
    groups: [cls('rev2', '6201', 3)],
    fiscal: fiscal('6201', 'four_digit', true),
    basis: 'onrc_single_class',
    agreement: 'match_one_key',
    form: 'four_digit',
    source: 'ONRC',
    revision: 'rev2',
    code: '6201',
    classKeyCount: 1,
  },
  {
    name: '|K|=1, ANAF differs',
    groups: [cls('rev2', '6201')],
    fiscal: fiscal('4711', 'four_digit', true),
    basis: 'onrc_single_class',
    agreement: 'differs',
    form: 'four_digit',
    source: 'ONRC',
    revision: 'rev2',
    code: '6201',
    classKeyCount: 1,
  },
  {
    name: '|K|=1, no public fiscal row',
    groups: [cls('rev3', '6201')],
    fiscal: null,
    basis: 'onrc_single_class',
    agreement: 'anaf_missing',
    form: 'absent',
    source: 'ONRC',
    revision: 'rev3',
    code: '6201',
    classKeyCount: 1,
  },
  {
    name: '|K|=1, a short ANAF code',
    groups: [cls('rev2', '0111')],
    fiscal: fiscal('0111', 'short', false),
    basis: 'onrc_single_class',
    agreement: 'anaf_not_usable',
    form: 'short',
    source: 'ONRC',
    revision: 'rev2',
    code: '0111',
    classKeyCount: 1,
  },
  // |K| >= 2: only a unique numeric match selects.
  {
    name: '|K|=2, ANAF equals exactly one key',
    groups: [cls('rev2', '6201'), cls('rev2', '4711', 2)],
    fiscal: fiscal('4711', 'four_digit', true),
    basis: 'onrc_class_anaf_numeric_match',
    agreement: 'match_one_key',
    form: 'four_digit',
    source: 'ONRC',
    revision: 'rev2',
    code: '4711',
    classKeyCount: 2,
  },
  {
    name: '|K|=2, ANAF matches the same digits in two revisions (rev2:4711, rev3:4711)',
    groups: [cls('rev2', '4711'), cls('rev3', '4711')],
    fiscal: fiscal('4711', 'four_digit', true),
    basis: 'onrc_multiple_classes',
    agreement: 'match_multiple_revisions',
    form: 'four_digit',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 2,
  },
  {
    name: '|K|=2, ANAF differs',
    groups: [cls('rev2', '6201'), cls('rev2', '4711')],
    fiscal: fiscal('0111', 'four_digit', true),
    basis: 'onrc_multiple_classes',
    agreement: 'differs',
    form: 'four_digit',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 2,
  },
  {
    name: '|K|=2, the ANAF observation is unbound',
    groups: [cls('rev2', '6201'), cls('rev2', '4711')],
    fiscal: fiscal('4711', 'unbound', false),
    basis: 'onrc_multiple_classes',
    agreement: 'anaf_not_usable',
    form: 'unbound',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 2,
  },
  {
    name: '|K|=2, the ANAF placeholder 9999',
    groups: [cls('rev2', '6201'), cls('rev2', '4711')],
    fiscal: fiscal('9999', 'four_digit', true),
    basis: 'onrc_multiple_classes',
    agreement: 'anaf_placeholder',
    form: 'four_digit',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 2,
  },
  // |K| = 0: the ANAF code stands in only when usable, real and catalogued.
  {
    name: '|K|=0, a usable catalogued ANAF code',
    groups: [],
    fiscal: fiscal('4711', 'four_digit', true, true),
    basis: 'anaf_fiscal_code',
    agreement: 'no_class_key',
    form: 'four_digit',
    source: 'ANAF',
    revision: null,
    code: '4711',
    classKeyCount: 0,
  },
  {
    name: '|K|=0, the ANAF placeholder 0000 (even usable and catalogued)',
    groups: [],
    fiscal: fiscal('0000', 'four_digit', true, true),
    basis: 'no_qualified_selection',
    agreement: 'anaf_placeholder',
    form: 'four_digit',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 0,
  },
  {
    name: '|K|=0, an uncatalogued ANAF code',
    groups: [],
    fiscal: fiscal('1234', 'four_digit', true),
    basis: 'anaf_fiscal_uncatalogued',
    agreement: 'no_class_key',
    form: 'four_digit',
    source: 'ANAF',
    revision: null,
    code: '1234',
    classKeyCount: 0,
  },
  {
    name: '|K|=0, catalogued false even though the candidates carry labels (the DB flag decides)',
    groups: [],
    fiscal: fiscal('4711', 'four_digit', true, false),
    basis: 'anaf_fiscal_uncatalogued',
    agreement: 'no_class_key',
    form: 'four_digit',
    source: 'ANAF',
    revision: null,
    code: '4711',
    classKeyCount: 0,
  },
  {
    name: '|K|=0, an unqualified form (no valid receipt)',
    groups: [],
    fiscal: fiscal('4711', 'unqualified', false),
    basis: 'no_qualified_selection',
    agreement: 'anaf_not_usable',
    form: 'unqualified',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 0,
  },
  {
    name: '|K|=0, a usability the database did not state (null): fail closed',
    groups: [],
    fiscal: fiscal('4711', null, null),
    basis: 'no_qualified_selection',
    agreement: 'anaf_not_usable',
    form: 'unqualified',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 0,
  },
  {
    name: '|K|=0, an unbound form',
    groups: [],
    fiscal: fiscal('4711', 'unbound', false),
    basis: 'no_qualified_selection',
    agreement: 'anaf_not_usable',
    form: 'unbound',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 0,
  },
  {
    name: '|K|=0, three_digit under policy v1 (usable=false)',
    groups: [],
    fiscal: fiscal('0111', 'three_digit', false, true),
    basis: 'no_qualified_selection',
    agreement: 'anaf_not_usable',
    form: 'three_digit',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 0,
  },
  {
    name: '|K|=0, the same three_digit row under a future policy (usable=true) selects',
    groups: [],
    fiscal: fiscal('0111', 'three_digit', true, true),
    basis: 'anaf_fiscal_code',
    agreement: 'no_class_key',
    form: 'three_digit',
    source: 'ANAF',
    revision: null,
    code: '0111',
    classKeyCount: 0,
  },
  {
    name: '|K|=2, a three_digit numeric match under a future policy (usable=true)',
    groups: [cls('rev2', '0111'), cls('rev2', '6201')],
    fiscal: fiscal('0111', 'three_digit', true),
    basis: 'onrc_class_anaf_numeric_match',
    agreement: 'match_one_key',
    form: 'three_digit',
    source: 'ONRC',
    revision: 'rev2',
    code: '0111',
    classKeyCount: 2,
  },
  {
    name: '|K|=2, the same match with usable=false (policy v1) does not select',
    groups: [cls('rev2', '0111'), cls('rev2', '6201')],
    fiscal: fiscal('0111', 'three_digit', false),
    basis: 'onrc_multiple_classes',
    agreement: 'anaf_not_usable',
    form: 'three_digit',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 2,
  },
  {
    name: '|K|=0, a four_digit form the policy does not admit (the usable set is never hard-coded)',
    groups: [],
    fiscal: fiscal('4711', 'four_digit', false, true),
    basis: 'no_qualified_selection',
    agreement: 'anaf_not_usable',
    form: 'four_digit',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 0,
  },
  {
    name: '|K|=0, catalogued true without catalog candidates read (the DB flag decides)',
    groups: [],
    fiscal: fiscal('7777', 'four_digit', true, true),
    basis: 'anaf_fiscal_code',
    agreement: 'no_class_key',
    form: 'four_digit',
    source: 'ANAF',
    revision: null,
    code: '7777',
    classKeyCount: 0,
  },
  {
    name: '|K|=0, a form outside the vocabulary',
    groups: [],
    fiscal: fiscal('4711', 'principal', false),
    basis: 'no_qualified_selection',
    agreement: 'anaf_not_usable',
    form: 'unqualified',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 0,
  },
  {
    name: '|K|=0, a fiscal row without a code',
    groups: [],
    fiscal: fiscal(null, 'missing', false),
    basis: 'no_qualified_selection',
    agreement: 'anaf_missing',
    form: 'missing',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 0,
  },
  {
    name: '|K|=0, an invalid token (code NULL)',
    groups: [],
    fiscal: fiscal(null, 'invalid', false),
    basis: 'no_qualified_selection',
    agreement: 'anaf_missing',
    form: 'invalid',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 0,
  },
  {
    name: '|K|=0, no public fiscal row',
    groups: [],
    fiscal: null,
    basis: 'no_qualified_selection',
    agreement: 'anaf_missing',
    form: 'absent',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 0,
  },
  // Unqualified ONRC rows never form a key.
  {
    name: 'a short-token-only CUI has no class key; a usable ANAF code stands in',
    groups: [other('short_token', 'rev2', '0111', 3)],
    fiscal: fiscal('0111', 'four_digit', true, true),
    basis: 'anaf_fiscal_code',
    agreement: 'no_class_key',
    form: 'four_digit',
    source: 'ANAF',
    revision: null,
    code: '0111',
    classKeyCount: 0,
  },
  {
    name: 'a short-token-only CUI without a usable ANAF code selects nothing',
    groups: [other('short_token', 'rev2', '0111', 3)],
    fiscal: fiscal('0111', 'short', false),
    basis: 'no_qualified_selection',
    agreement: 'anaf_not_usable',
    form: 'short',
    source: null,
    revision: null,
    code: null,
    classKeyCount: 0,
  },
  {
    name: 'unknown revision, unlabeled key and unparsed rows beside one class key',
    groups: [
      cls('rev2', '6201', 2),
      other('unknown_revision', null, '6201', 4),
      other('unlabeled_key', 'rev1', '2864'),
      other('unparsed', null, null, 2),
    ],
    fiscal: fiscal('2864', 'four_digit', true),
    basis: 'onrc_single_class',
    agreement: 'differs',
    form: 'four_digit',
    source: 'ONRC',
    revision: 'rev2',
    code: '6201',
    classKeyCount: 1,
  },
];

describe('selectActivity: the CAEN contract §B case table', () => {
  it.each(CASES)('$name', (c) => {
    const s = selectActivity(input(c.groups, c.fiscal))._unsafeUnwrap();
    expect([s.basis, s.agreement, s.anafCodeForm, s.source, s.revision, s.code]).toEqual([
      c.basis,
      c.agreement,
      c.form,
      c.source,
      c.revision,
      c.code,
    ]);
    expect(s.classKeyCount).toBe(c.classKeyCount);
    expect(s.derived).toBe(true);
    // ANAF never supplies a revision.
    if (s.source === 'ANAF') expect(s.revision).toBeNull();
    if (s.source === null) {
      expect([s.label, s.descriptionStatus, s.descriptions]).toEqual([null, null, []]);
    }
    expect(s.anafCode).toBe(c.fiscal?.code ?? null);
    // Usable is the database's form answer (fail closed on anything but
    // true) AND not a placeholder code.
    expect(s.anafCodeUsable).toBe(
      c.fiscal?.usable === true && !['0000', '9999'].includes(c.fiscal.code ?? '')
    );
  });

  it('covers every basis, agreement and form of the vocabulary', () => {
    const outcomes = CASES.map((c) => selectActivity(input(c.groups, c.fiscal))._unsafeUnwrap());
    expect(new Set(outcomes.map((s) => s.basis))).toEqual(
      new Set([
        'onrc_single_class',
        'onrc_class_anaf_numeric_match',
        'onrc_multiple_classes',
        'anaf_fiscal_code',
        'anaf_fiscal_uncatalogued',
        'no_qualified_selection',
      ])
    );
    expect(new Set(outcomes.map((s) => s.agreement))).toEqual(
      new Set([
        'match_one_key',
        'match_multiple_revisions',
        'differs',
        'no_class_key',
        'anaf_missing',
        'anaf_placeholder',
        'anaf_not_usable',
      ])
    );
    expect(new Set(outcomes.map((s) => s.anafCodeForm))).toEqual(
      new Set([
        'four_digit',
        'three_digit',
        'short',
        'missing',
        'invalid',
        'unbound',
        'unqualified',
        'absent',
      ])
    );
  });
});

describe('selectActivity: labels, counts and evidence', () => {
  it('labels a selected ONRC key EXACTLY by its own revision, never another one', () => {
    const s = selectActivity(
      input([cls('rev3', '6201')], fiscal('6201', 'four_digit', true))
    )._unsafeUnwrap();
    expect([s.label, s.descriptionStatus, s.descriptions]).toEqual([
      'Activități de realizare a software-ului la comandă',
      'EXACT',
      [{ revision: 'rev3', label: 'Activități de realizare a software-ului la comandă' }],
    ]);
  });

  it('gives an ANAF code catalog candidates only: CONSENSUS or CONFLICT, never EXACT', () => {
    const consensus = selectActivity(
      input([], fiscal('4711', 'four_digit', true, true))
    )._unsafeUnwrap();
    expect([consensus.label, consensus.descriptionStatus, consensus.revision]).toEqual([
      'Comerț cu amănuntul în magazine nespecializate',
      'CONSENSUS',
      null,
    ]);
    expect(consensus.descriptions.map((d) => d.revision)).toEqual(['rev2', 'rev3']);
    const conflict = selectActivity(
      input([], fiscal('6201', 'four_digit', true, true))
    )._unsafeUnwrap();
    expect([conflict.label, conflict.descriptionStatus, conflict.revision]).toEqual([
      null,
      'CONFLICT',
      null,
    ]);
  });

  it('never labels an uncatalogued ANAF code, even when candidates carry text', () => {
    const s = selectActivity(input([], fiscal('4711', 'four_digit', true, false)))._unsafeUnwrap();
    expect([s.basis, s.label, s.descriptionStatus, s.descriptions]).toEqual([
      'anaf_fiscal_uncatalogued',
      null,
      null,
      [],
    ]);
  });

  it('states the database usability and form policy next to the form', () => {
    const v1 = selectActivity(input([], fiscal('0111', 'three_digit', false)))._unsafeUnwrap();
    expect([v1.anafCodeForm, v1.anafCodeUsable, v1.anafCaenFormPolicy]).toEqual([
      'three_digit',
      false,
      'anaf-caen-form-policy-v1',
    ]);
    const unknown = selectActivity(input([], fiscal('4711', 'four_digit', null)))._unsafeUnwrap();
    expect([unknown.anafCodeUsable, unknown.agreement]).toEqual([false, 'anaf_not_usable']);
  });

  it.each(['0000', '9999'])(
    'never exposes the placeholder %s as a usable code, though its four-digit form is admitted',
    (code) => {
      for (const groups of [[], [cls('rev2', '6201'), cls('rev2', '4711')]]) {
        const s = selectActivity(
          input(groups, fiscal(code, 'four_digit', true, true))
        )._unsafeUnwrap();
        expect([s.anafCode, s.anafCodeForm, s.anafCodeUsable, s.agreement, s.source]).toEqual([
          code,
          'four_digit',
          false,
          'anaf_placeholder',
          null,
        ]);
      }
    }
  );

  it('counts the exact aggregate: rows, unqualified rows and distinct class keys', () => {
    const s = selectActivity(
      input(
        [
          cls('rev2', '6201', 2),
          other('unknown_revision', null, '6201', 4),
          other('unlabeled_key', 'rev1', '2864'),
          other('short_token', 'rev2', '0111', 2),
        ],
        fiscal('6201', 'four_digit', true)
      )
    )._unsafeUnwrap();
    expect([s.observationCount, s.unqualifiedObservationCount, s.classKeyCount]).toEqual([9, 7, 1]);
  });

  it('keeps an unresolved coverage exactly as computed (never upgraded by ANAF)', () => {
    const s = selectActivity(
      input([cls('rev2', '6201')], fiscal('6201', 'four_digit', true), {
        caenCoverage: 'unresolved',
      })
    )._unsafeUnwrap();
    expect([s.basis, s.caenCoverage]).toEqual(['onrc_single_class', 'unresolved']);
  });

  it('states both source dates next to the selection', () => {
    const s = selectActivity(
      input([cls('rev2', '6201')], fiscal('6201', 'four_digit', true))
    )._unsafeUnwrap();
    expect([s.editionId, s.editionSourceDate, s.anafStatusDate]).toEqual([
      '7',
      '2026-07-08',
      '2026-09-28',
    ]);
  });

  it('reads the catalog of every class code and the ANAF code, nothing else', () => {
    expect(
      activityCatalogCodes(
        [cls('rev2', '6201'), cls('rev3', '6201'), other('short_token', 'rev2', '0111')],
        '4711'
      )
    ).toEqual(['4711', '6201']);
  });
});

describe('selectActivity: the bound and the vocabulary', () => {
  const many = (n: number): CaenClassStateGroup[] =>
    Array.from({ length: n }, (_, i) => other('unparsed', null, String(i).padStart(4, '0')));

  it('refuses more than 2000 groups as a typed refusal, never a truncated selection', () => {
    const error = selectActivity(
      input(many(ACTIVITY_AGGREGATE_GROUP_BOUND + 1), fiscal('6201', 'four_digit', true))
    )._unsafeUnwrapErr();
    expect(error).toEqual({
      type: 'ServiceUnavailable',
      message: ACTIVITY_AGGREGATE_BOUND_MESSAGE,
    });
  });

  it('answers exactly 2000 groups', () => {
    const s = selectActivity(input(many(ACTIVITY_AGGREGATE_GROUP_BOUND), null))._unsafeUnwrap();
    expect(s.unqualifiedObservationCount).toBe(2000);
  });

  it.each([
    ['a class state outside the vocabulary', [other('principal', 'rev2', '6201')]],
    ['a class row without a known revision', [other('class', null, '6201')]],
    ['a class row with a short code', [other('class', 'rev2', '62')]],
    ['an empty group', [cls('rev2', '6201', 0)]],
  ])('refuses %s as a serving invariant', (_label, groups) => {
    expect(selectActivity(input(groups, null))._unsafeUnwrapErr().type).toBe('Database');
  });
});
