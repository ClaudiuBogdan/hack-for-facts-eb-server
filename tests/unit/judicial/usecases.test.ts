/**
 * Judicial — usecase unit tests over MOCKED ports (no DB). The centerpiece is the
 * PRIVACY-CRITICAL projection in `getCaseDetail` (§3.2): every client-view party
 * renders `name: null`; publishable companies retain only their gated stable key
 * and legal form. Also covers the company-litigation empty-in-v1 shape and the
 * resolve dims.
 */

import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  getCaseDetail,
  getCaseLineage,
  getCompanyLitigation,
  resolveJudicialFilters,
  type JudicialRepos,
} from '@/modules/judicial/core/usecases.js';
import { invalidInput } from '@/modules/shared/index.js';

import type {
  JudicialAsOf,
  JudicialCase,
  JudicialParty,
  PublishableName,
} from '@/modules/judicial/core/types.js';

const asOf: JudicialAsOf = {
  asOf: '2026-06-07T00:00:00.000Z',
  estimated: true,
  sourceSlug: 'portal_just',
  basis: 'max_stored_source_modified_at',
  captureFreshnessAt: null,
  loadFreshnessAt: null,
};

/** A repos stub where each port is a vi.fn returning an ok() of a sensible default. */
const makeRepos = (over: Partial<Record<keyof JudicialRepos, unknown>> = {}): JudicialRepos => {
  const base = {
    courts: {
      list: vi.fn(async () => ok([])),
      getByCode: vi.fn(async () => ok(null)),
      listChildren: vi.fn(async () => ok([])),
      resolveCourt: vi.fn(async () => ok([])),
      resolveCategory: vi.fn(async () => ok([])),
    },
    cases: {
      getById: vi.fn(async () => ok(null)),
      getByNaturalKey: vi.fn(async () => ok(null)),
      listCursor: vi.fn(async () => ok({ items: [], next: null })),
      aggregate: vi.fn(async () => ok({ groups: [], denominator: 0, coverage: 0 })),
      getAsOf: vi.fn(async () => ok(asOf)),
    },
    hearings: { listForCase: vi.fn(async () => ok([])) },
    appeals: { listForCase: vi.fn(async () => ok([])) },
    parties: { listForCase: vi.fn(async () => ok([])) },
    dictionary: {
      getPublishableName: vi.fn(async () => ok(null)),
      getPublishableNames: vi.fn(async () => ok(new Map<string, PublishableName>())),
      resolveCompanyName: vi.fn(async () => ok([])),
    },
    companyLinks: {
      summaryForCui: vi.fn(async () =>
        ok({
          cui: '0',
          companyName: null,
          caseCount: 0,
          courtLevels: [],
          years: [],
          coverage: 0,
          caveats: ['company-litigation links not yet published'],
        })
      ),
      listCasesForCui: vi.fn(async () => ok({ items: [], next: null })),
    },
    legalRefs: {
      listForCase: vi.fn(async () => ok([])),
      casesCitingAct: vi.fn(async () => ok({ items: [], next: null })),
    },
    lineage: { lineageForCase: vi.fn(async () => ok([])) },
    // API-04: the stored-decision repo (unused by the existing assertions).
    decisions: {
      listIssuingBodies: vi.fn(async () => ok([])),
      getById: vi.fn(async () => ok(null)),
      getBySource: vi.fn(async () => ok(null)),
      list: vi.fn(async () => ok({ items: [], next: null })),
      listSubjectLinks: vi.fn(async () => ok({ items: [], next: null })),
      resolveIssuingBodies: vi.fn(async () => ok([])),
      resolveSourceSystems: vi.fn(async () => ok([])),
    },
  } as unknown as JudicialRepos;
  return { ...base, ...over } as JudicialRepos;
};

const theCase: JudicialCase = {
  caseId: '100',
  sourceSlug: 'portal_just',
  institutionCode: 'JUDX',
  caseNumber: '1/2024',
  caseNumberOld: null,
  department: null,
  category: 'civil',
  categoryName: 'Civil',
  stage: 'fond',
  stageName: 'Fond',
  object: 'pretenții',
  sourceOpenedAt: '2024-01-01',
  sourceOpenedAtBasis: 'portal_header_data',
  latestSourceModifiedAt: '2024-02-01T00:00:00.000Z',
};

describe('getCaseDetail — the privacy-critical name merge (§3.2)', () => {
  const parties: JudicialParty[] = [
    // person with a NON-NULL key that the dictionary WOULD resolve (it's a company
    // name elsewhere) — but publishable=false on THIS row → name MUST stay null.
    {
      caseId: '100',
      partyIndex: 0,
      partyKind: 'person',
      roleNormalized: 'parat',
      nameKeyId: '500',
      publishable: false,
    },
    {
      caseId: '100',
      partyIndex: 1,
      partyKind: 'unknown',
      roleNormalized: null,
      nameKeyId: null,
      publishable: false,
    },
    {
      caseId: '100',
      partyIndex: 2,
      partyKind: 'company',
      roleNormalized: 'reclamant',
      nameKeyId: '500',
      publishable: true,
    },
    // a company party whose row is NOT publishable (declined rule) → name must be null.
    {
      caseId: '100',
      partyIndex: 3,
      partyKind: 'company',
      roleNormalized: 'reclamant',
      nameKeyId: '999',
      publishable: false,
    },
  ];

  it('withholds every party-view name while preserving gated company key and legal form', async () => {
    const repos = makeRepos({
      cases: {
        getById: vi.fn(async () => ok(theCase)),
        getByNaturalKey: vi.fn(async () => ok(null)),
        listCursor: vi.fn(async () => ok({ items: [], next: null })),
        aggregate: vi.fn(async () => ok({ groups: [], denominator: 0, coverage: 0 })),
        getAsOf: vi.fn(async () => ok(asOf)),
      },
      parties: { listForCase: vi.fn(async () => ok(parties)) },
      dictionary: {
        // gate returns a name ONLY for key 500 (publishable company); 999 absent.
        getPublishableName: vi.fn(async () => ok(null)),
        getPublishableNames: vi.fn(async () =>
          ok(
            new Map<string, PublishableName>([
              [
                '500',
                {
                  nameKeyId: '500',
                  displayName: 'ACME SRL',
                  partyKind: 'company',
                  legalForm: 'SRL',
                },
              ],
            ])
          )
        ),
        resolveCompanyName: vi.fn(async () => ok([])),
      },
    });

    const res = await getCaseDetail(repos, { caseId: '100' });
    expect(res.isOk()).toBe(true);
    const detail = res._unsafeUnwrap();
    expect(detail).not.toBeNull();
    const views = detail!.parties;

    // person w/ a non-null key that the dictionary WOULD resolve, but this row is
    // not publishable → both the stable key and name MUST stay null.
    expect(views[0]).toMatchObject({ partyKind: 'person', nameKeyId: null, name: null });
    // unknown → key and name null
    expect(views[1]).toMatchObject({ partyKind: 'unknown', nameKeyId: null, name: null });
    // company w/ publishable row + dictionary match → gated key/form, but no client-view name
    expect(views[2]).toMatchObject({
      partyKind: 'company',
      nameKeyId: '500',
      name: null,
      legalForm: 'SRL',
    });
    // company w/ non-publishable row (declined rule) → key and name null
    expect(views[3]).toMatchObject({ partyKind: 'company', nameKeyId: null, name: null });

    // anonymized count of person/unknown parties
    expect(detail!.personPartyCount).toBe(2);

    expect(views.every((view) => view.name === null)).toBe(true);
    // NO view object carries the dictionary's internal displayName field.
    for (const v of views) {
      expect(Object.keys(v)).not.toContain('displayName');
    }
  });

  it('only PUBLISHABLE rows pass their key to the gated dictionary (person/declined keys never sent)', async () => {
    const dict = {
      getPublishableName: vi.fn(async () => ok(null)),
      getPublishableNames: vi.fn(async () => ok(new Map<string, PublishableName>())),
      resolveCompanyName: vi.fn(async () => ok([])),
    };
    const repos = makeRepos({
      cases: {
        getById: vi.fn(async () => ok(theCase)),
        getByNaturalKey: vi.fn(async () => ok(null)),
        listCursor: vi.fn(async () => ok({ items: [], next: null })),
        aggregate: vi.fn(async () => ok({ groups: [], denominator: 0, coverage: 0 })),
        getAsOf: vi.fn(async () => ok(asOf)),
      },
      parties: { listForCase: vi.fn(async () => ok(parties)) },
      dictionary: dict,
    });
    await getCaseDetail(repos, { caseId: '100' });
    // Only the publishable company row's key (500) is requested. The person row's
    // shared key (500) and the declined company row's key (999) are NOT sent —
    // proving the merge cannot resolve a name for a non-publishable row.
    expect(dict.getPublishableNames).toHaveBeenCalledWith(['500']);
  });
});

describe('getCaseDetail — as-of is scoped to the RESOLVED case source (A2)', () => {
  it.each([
    ['by id', { caseId: '200' }],
    ['by natural key', { institutionCode: 'InaltaCurtedeCasatiesiJustitie', caseNumber: '7/2020' }],
  ] as const)('passes the case source_slug to getAsOf (%s)', async (_label, ref) => {
    const iccjCase: JudicialCase = {
      ...theCase,
      caseId: '200',
      sourceSlug: 'iccj',
      institutionCode: 'InaltaCurtedeCasatiesiJustitie',
      caseNumber: '7/2020',
      sourceOpenedAt: null,
      sourceOpenedAtBasis: 'iccj_archive_case_date',
      latestSourceModifiedAt: null,
    };
    const iccjAsOf: JudicialAsOf = { ...asOf, asOf: null, sourceSlug: 'iccj' };
    const getAsOf = vi.fn(async (_sourceSlug: string) => ok(iccjAsOf));
    const repos = makeRepos({
      cases: {
        getById: vi.fn(async () => ok(iccjCase)),
        getByNaturalKey: vi.fn(async () => ok(iccjCase)),
        listCursor: vi.fn(async () => ok({ items: [], next: null })),
        aggregate: vi.fn(async () => ok({ groups: [], denominator: 0, coverage: 0 })),
        getAsOf,
      },
    });

    const detail = (await getCaseDetail(repos, ref))._unsafeUnwrap();

    expect(getAsOf).toHaveBeenCalledTimes(1);
    expect(getAsOf).toHaveBeenCalledWith('iccj');
    expect(detail?.asOf).toEqual({
      asOf: null,
      estimated: true,
      sourceSlug: 'iccj',
      basis: 'max_stored_source_modified_at',
      captureFreshnessAt: null,
      loadFreshnessAt: null,
    });
  });

  it('does not read as-of for a missing case', async () => {
    const repos = makeRepos();
    const res = await getCaseDetail(repos, { caseId: '404' });
    expect(res._unsafeUnwrap()).toBeNull();
    expect(repos.cases.getAsOf).not.toHaveBeenCalled();
  });
});

describe('getCompanyLitigation — empty in v1 (published-only)', () => {
  it('returns caseCount 0 + coverage 0 + a caveat', async () => {
    const repos = makeRepos();
    const res = await getCompanyLitigation(repos, '12345678');
    expect(res.isOk()).toBe(true);
    const s = res._unsafeUnwrap();
    expect(s.caseCount).toBe(0);
    expect(s.coverage).toBe(0);
    expect(s.caveats.length).toBeGreaterThan(0);
  });
});

describe('resolveJudicialFilters — companyName resolves the dictionary, never echoes the query (S1)', () => {
  it('a person-name query returns empty (dictionary holds no persons)', async () => {
    const repos = makeRepos(); // resolveCompanyName returns []
    const res = await resolveJudicialFilters(repos, 'companyName', 'Ion Popescu', 10);
    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap()).toEqual([]);
  });

  it('a company match returns the dictionary display_name as the label, not the query', async () => {
    const repos = makeRepos({
      dictionary: {
        getPublishableName: vi.fn(async () => ok(null)),
        getPublishableNames: vi.fn(async () => ok(new Map())),
        resolveCompanyName: vi.fn(async () =>
          ok([
            {
              nameKeyId: '7',
              displayName: 'ACME SRL',
              partyKind: 'company' as const,
              legalForm: 'SRL',
            },
          ])
        ),
      },
    });
    const res = await resolveJudicialFilters(repos, 'companyName', 'acme', 10);
    const hits = res._unsafeUnwrap();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'companyName', value: '7', label: 'ACME SRL' });
    expect(hits[0]?.label).not.toBe('acme'); // never echoes the query
  });
});

describe('API-04 usecase guards (existing case semantics otherwise unchanged)', () => {
  it('getCaseLineage validates the DIRECT case id before any repo access', async () => {
    const lineageForCase = vi.fn(async () => ok([]));
    const repos = makeRepos({ lineage: { lineageForCase } });
    for (const bad of ['-1', '1.5', 'abc', '', '9223372036854775808', 7]) {
      const res = await getCaseLineage(repos, bad);
      expect(res.isErr() && res.error.type).toBe('InvalidInput');
    }
    expect(lineageForCase).not.toHaveBeenCalled();
    const ok1 = await getCaseLineage(repos, '9223372036854775807');
    expect(ok1.isOk()).toBe(true);
    expect(lineageForCase).toHaveBeenCalledWith('9223372036854775807');
  });

  it('an ambiguous natural-key lookup stops at the lookup: no child, dictionary or as-of read', async () => {
    const ambiguity = invalidInput('case lookup is ambiguous; use caseId', 'caseNumber');
    const reads = {
      hearings: vi.fn(async () => ok([])),
      appeals: vi.fn(async () => ok([])),
      parties: vi.fn(async () => ok([])),
      legalRefs: vi.fn(async () => ok([])),
      lineage: vi.fn(async () => ok([])),
      names: vi.fn(async () => ok(new Map<string, PublishableName>())),
      asOf: vi.fn(async () => ok(asOf)),
    };
    const getByNaturalKey = vi.fn(async () => err(ambiguity));
    const repos = makeRepos({
      cases: {
        getById: vi.fn(async () => ok(null)),
        getByNaturalKey,
        listCursor: vi.fn(async () => ok({ items: [], next: null })),
        aggregate: vi.fn(async () => ok({ groups: [], denominator: 0, coverage: 0 })),
        getAsOf: reads.asOf,
      },
      hearings: { listForCase: reads.hearings },
      appeals: { listForCase: reads.appeals },
      parties: { listForCase: reads.parties },
      legalRefs: { listForCase: reads.legalRefs, casesCitingAct: vi.fn() },
      lineage: { lineageForCase: reads.lineage },
      dictionary: {
        getPublishableName: vi.fn(),
        getPublishableNames: reads.names,
        resolveCompanyName: vi.fn(),
      },
    });
    const res = await getCaseDetail(repos, { institutionCode: 'JUDX', caseNumber: '1/2024' });
    expect(res.isErr() && res.error).toEqual({
      type: 'InvalidInput',
      message: 'case lookup is ambiguous; use caseId',
      field: 'caseNumber',
    });
    expect(getByNaturalKey).toHaveBeenCalledTimes(1);
    for (const read of Object.values(reads)) expect(read).not.toHaveBeenCalled();
  });
});
