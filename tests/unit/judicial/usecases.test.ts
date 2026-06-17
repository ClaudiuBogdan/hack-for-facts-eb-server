/**
 * Judicial — usecase unit tests over MOCKED ports (no DB). The centerpiece is the
 * PRIVACY-CRITICAL name merge in `getCaseDetail` (§3.2): a person party renders
 * `name: null`; a company party renders the gated publishable name; a name-key the
 * gate declines also renders `name: null`. Also covers the company-litigation
 * empty-in-v1 shape and the resolve dims.
 */

import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  getCaseDetail,
  getCompanyLitigation,
  resolveJudicialFilters,
  type JudicialRepos,
} from '@/modules/judicial/core/usecases.js';

import type { JudicialParty, PublishableName } from '@/modules/judicial/core/types.js';

const asOf = { asOf: '2026-06-07T00:00:00.000Z', estimated: true };

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
      summaryForCui: vi.fn(async () => ok({ cui: '0', companyName: null, caseCount: 0, courtLevels: [], years: [], coverage: 0, caveats: ['company-litigation links not yet published'] })),
      listCasesForCui: vi.fn(async () => ok({ items: [], next: null })),
    },
    legalRefs: { listForCase: vi.fn(async () => ok([])), casesCitingAct: vi.fn(async () => ok({ items: [], next: null })) },
    lineage: { lineageForCase: vi.fn(async () => ok([])) },
  } as unknown as JudicialRepos;
  return { ...base, ...over } as JudicialRepos;
};

const theCase = {
  caseId: '100', sourceSlug: 'portal_just', institutionCode: 'JUDX', caseNumber: '1/2024',
  caseNumberOld: null, department: null, category: 'civil', categoryName: 'Civil', stage: 'fond',
  stageName: 'Fond', object: 'pretenții', sourceOpenedAt: '2024-01-01', latestSourceModifiedAt: '2024-02-01T00:00:00.000Z',
};

describe('getCaseDetail — the privacy-critical name merge (§3.2)', () => {
  const parties: JudicialParty[] = [
    // person with a NON-NULL key that the dictionary WOULD resolve (it's a company
    // name elsewhere) — but publishable=false on THIS row → name MUST stay null.
    { caseId: '100', partyIndex: 0, partyKind: 'person', roleNormalized: 'parat', nameKeyId: '500', publishable: false },
    { caseId: '100', partyIndex: 1, partyKind: 'unknown', roleNormalized: null, nameKeyId: null, publishable: false },
    { caseId: '100', partyIndex: 2, partyKind: 'company', roleNormalized: 'reclamant', nameKeyId: '500', publishable: true },
    // a company party whose row is NOT publishable (declined rule) → name must be null.
    { caseId: '100', partyIndex: 3, partyKind: 'company', roleNormalized: 'reclamant', nameKeyId: '999', publishable: false },
  ];

  it('renders person/unknown with name:null and company with the gated name; declined key → null', async () => {
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
          ok(new Map<string, PublishableName>([['500', { nameKeyId: '500', displayName: 'ACME SRL', partyKind: 'company', legalForm: 'SRL' }]]))
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
    // not publishable → name MUST stay null (the P0 per-row defence-in-depth).
    expect(views[0]).toMatchObject({ partyKind: 'person', nameKeyId: '500', name: null });
    // unknown → name null
    expect(views[1]).toMatchObject({ partyKind: 'unknown', name: null });
    // company w/ publishable row + key → gated name
    expect(views[2]).toMatchObject({ partyKind: 'company', name: 'ACME SRL', legalForm: 'SRL' });
    // company w/ non-publishable row (declined rule) → name null
    expect(views[3]).toMatchObject({ partyKind: 'company', nameKeyId: '999', name: null });

    // anonymized count of person/unknown parties
    expect(detail!.personPartyCount).toBe(2);

    // NO view object carries displayName or any name beyond the gated 'name' field.
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
          ok([{ nameKeyId: '7', displayName: 'ACME SRL', partyKind: 'company' as const, legalForm: 'SRL' }])
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
