/**
 * Companies analytics schema v2 (one pinned ONRC edition), over the in-memory
 * semantics oracle: the release's source pin and schema are refused unless
 * exactly the frozen contract; county/UAT/status are consensus buckets with
 * explicit basis groups (each company once, money once, every key a filter);
 * ONRC observation filters hold on ONE identifier; exclusions need complete
 * evidence; records carry the bases and the exact recorded civil date.
 */

import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { parseRelease, parseSourcePin } from '@/modules/companies/core/analytics-release.js';
import { parseScopeShape } from '@/modules/companies/core/analytics-scope.js';
import {
  companyAnalysisBreakdown,
  companyAnalysisRecords,
  companyAnalysisRelease,
  companyAnalysisStats,
} from '@/modules/companies/core/analytics-usecases.js';

import {
  DATASET,
  ONRC_CONTROLS,
  SOURCE_PIN,
  analyticsDeps,
  fakeLabels,
  fakeReleases,
  makeInMemoryEngine,
  releaseRow,
} from './analytics-fixtures.js';

import type { CompanyAnalysisEngine } from '@/modules/companies/core/analytics-ports.js';

const ACTIVE = releaseRow(7, DATASET.companies, DATASET.statements);

const setup = () => {
  const engine = makeInMemoryEngine(DATASET.companies, DATASET.statements, [7]);
  const releases = fakeReleases(ACTIVE);
  return { engine, releases, deps: analyticsDeps(engine, releases, fakeLabels()) };
};

/** The CUIs of a scope (via the records page, CUI order). */
const cuisOf = async (scope: Record<string, unknown>): Promise<string[]> => {
  const { deps } = setup();
  const page = (
    await companyAnalysisRecords(deps, { scope, sort: 'CUI', first: 100 })
  )._unsafeUnwrap();
  return page.edges.map((e) => e.node.cui);
};

// ── the source pin and schema ────────────────────────────────────────────────

describe('the release source pin (inputs.onrc) and schema', () => {
  it.each([
    ['a null source date', { sourcePublishedAt: null }],
    ['the first civil date', { sourcePublishedAt: '0001-01-01' }],
    ['the last civil date', { sourcePublishedAt: '9999-12-31' }],
    ['a leap day', { sourcePublishedAt: '2024-02-29' }],
    ['the largest bigint edition', { editionId: '9223372036854775807' }],
  ])('accepts %s', (_label, over) => {
    expect(parseSourcePin({ ...SOURCE_PIN, ...over })._unsafeUnwrap()).toEqual({
      ...SOURCE_PIN,
      ...over,
    });
  });

  it.each([
    ['no pin', undefined, 'missing'],
    ['a pin that is not an object', 'onrc:published:42:3:0', 'missing'],
    ['a missing key', (({ sourceSnapshotId: _, ...rest }) => rest)(SOURCE_PIN), 'eight pin keys'],
    ['an extra key', { ...SOURCE_PIN, accessEpoch: '0' }, 'eight pin keys'],
    ['a numeric edition id', { ...SOURCE_PIN, editionId: 42 }, 'malformed'],
    ['a leading-zero edition id', { ...SOURCE_PIN, editionId: '042' }, 'malformed'],
    ['a zero publication epoch', { ...SOURCE_PIN, publicationEpoch: '0' }, 'malformed'],
    ['an id beyond bigint', { ...SOURCE_PIN, editionId: '9223372036854775808' }, 'malformed'],
    ['an empty snapshot id', { ...SOURCE_PIN, sourceSnapshotId: '' }, 'malformed'],
    ['a control character', { ...SOURCE_PIN, sourceSnapshotId: 'onrc:\n' }, 'malformed'],
    ['a non-calendar date', { ...SOURCE_PIN, sourcePublishedAt: '2023-02-29' }, 'malformed'],
    ['year 0000', { ...SOURCE_PIN, sourcePublishedAt: '0000-12-31' }, 'malformed'],
    ['a five-digit year', { ...SOURCE_PIN, sourcePublishedAt: '10000-01-01' }, 'malformed'],
    ['the fence sentinel', { ...SOURCE_PIN, sourcePublishedAt: 'out-of-range' }, 'malformed'],
    ['a timestamp', { ...SOURCE_PIN, sourcePublishedAt: '2026-07-08T00:00:00Z' }, 'malformed'],
    [
      'another interpretation',
      { ...SOURCE_PIN, interpretationVersion: 'onrc-edition-v2' },
      'unsupported interpretationVersion',
    ],
    [
      'another privacy policy',
      { ...SOURCE_PIN, privacyPolicyVersion: 'onrc-privacy-v2' },
      'unsupported privacyPolicyVersion',
    ],
    [
      'another dimension policy',
      { ...SOURCE_PIN, dimensionPolicyVersion: 'onrc-dimensions-v2' },
      'unsupported dimensionPolicyVersion',
    ],
    [
      'another eligibility policy',
      { ...SOURCE_PIN, eligibilityPolicyVersion: 'public-legal-person-v2' },
      'unsupported eligibilityPolicyVersion',
    ],
  ])('refuses %s', (_label, pin, reason) => {
    const row = { ...ACTIVE, inputs: { ...(ACTIVE.inputs as object), onrc: pin } };
    expect(parseRelease(row, 'companies_analytics')._unsafeUnwrapErr()).toContain(reason);
  });

  it('serves no v1 release: the active one is unavailable and a pin is a release error, before any engine work', async () => {
    const v1 = {
      ...ACTIVE,
      schemaVersion: 'companies-analytics-ch-v1',
      populationPolicyVersion: 'public-legal-person-v1',
      inputs: { frontier: [] },
    };
    const engine = makeInMemoryEngine(DATASET.companies, DATASET.statements, [7]);
    const releases = fakeReleases(v1);
    const deps = analyticsDeps(engine, releases);
    const active = (await companyAnalysisStats(deps, {}))._unsafeUnwrapErr();
    expect(active).toEqual({
      type: 'ServiceUnavailable',
      message:
        'the active companies analytics release cannot be served: release schema companies-analytics-ch-v1 is not supported by this reader (it serves companies-analytics-ch-v2 only)',
    });
    const pinned = (await companyAnalysisStats(deps, { release: '7' }))._unsafeUnwrapErr();
    expect(pinned).toMatchObject({ type: 'InvalidInput', field: 'release' });
    expect(pinned.message).toContain('is not supported by this reader');
    // Never a healthy zero: nothing reached the engine or the state guard.
    expect(engine.calls).toEqual([]);
    expect(releases.privacy.reads).toBe(0);
  });

  it('carries the source edition on every answer and in the capabilities', async () => {
    const { deps } = setup();
    const info = (await companyAnalysisRelease(deps, {}))._unsafeUnwrap();
    expect(info.release.source).toEqual(SOURCE_PIN);
    expect(info.schemaVersion).toBe('companies-analytics-ch-v2');
    expect(info.populationPolicyVersion).toBe('public-onrc-edition-legal-person-v2');
    const stats = (await companyAnalysisStats(deps, {}))._unsafeUnwrap();
    expect(stats.release.source).toEqual(SOURCE_PIN);
  });

  it('keeps all 21 metrics × 7 statuses in every year coverage, adding up to the statements', async () => {
    const { deps } = setup();
    const info = (await companyAnalysisRelease(deps, {}))._unsafeUnwrap();
    for (const year of info.years) {
      expect(year.metrics).toHaveLength(21);
      for (const m of year.metrics) {
        const counts = Object.values(m.coverage).map((v) => BigInt(v));
        expect(counts).toHaveLength(7);
        expect(counts.reduce((a, b) => a + b, 0n)).toBe(BigInt(year.statements));
      }
    }
  });
});

// ── consensus buckets ────────────────────────────────────────────────────────

describe('county / UAT / observed status are consensus buckets with explicit bases', () => {
  it('OBSERVED_STATUS: the consensus value or its basis group, each company once, unknown empty', async () => {
    const { deps } = setup();
    const b = (
      await companyAnalysisBreakdown(deps, {
        dimension: 'OBSERVED_STATUS',
        topN: 100,
        rankBy: 'COMPANIES',
      })
    )._unsafeUnwrap();
    expect(
      b.groups.map((g) => [g.key, g.basis, g.label, g.labelSource, g.companies, g.filers])
    ).toEqual([
      ['1048', null, 'funcțiune', 'api_nomenclature', '3', '2'],
      // 300 (1048 + 1070 on ONE identifier) and 400 (split identifiers).
      ['(multiple_values)', 'MULTIPLE_VALUES', null, null, '2', '2'],
      // 500: partial status evidence has no status value.
      ['(partial_observations)', 'PARTIAL_OBSERVATIONS', null, null, '1', '1'],
    ]);
    expect(b.unknown).toMatchObject({ companies: '0', filers: '0' });
    expect(b.totals.companies).toBe('6');
  });

  it('every county / UAT / status bucket holds exactly the hand-declared companies', async () => {
    const members = {
      county: {
        CJ: ['100', '600'],
        B: ['200'],
        IS: ['500'],
        '(missing)': ['300'],
        '(multiple_values)': ['400'],
      },
      uat: {
        '54975': ['100', '600'],
        '95060': ['500'],
        '(missing)': ['200', '300'],
        '(multiple_values)': ['400'],
      },
      observedStatus: {
        '1048': ['100', '200', '600'],
        '(multiple_values)': ['300', '400'],
        '(partial_observations)': ['500'],
      },
    } as const;
    for (const [field, buckets] of Object.entries(members)) {
      for (const [key, cuis] of Object.entries(buckets))
        expect([field, key, await cuisOf({ [field]: { in: [key] } })]).toEqual([field, key, cuis]);
    }
  });

  it.each(['COUNTY', 'UAT', 'OBSERVED_STATUS'] as const)(
    '%s: every bucket key selects exactly that bucket, and money is counted once',
    async (dimension) => {
      const { deps } = setup();
      const b = (
        await companyAnalysisBreakdown(deps, { dimension, topN: 100, metric: 'TURNOVER' })
      )._unsafeUnwrap();
      const field =
        dimension === 'COUNTY' ? 'county' : dimension === 'UAT' ? 'uat' : 'observedStatus';
      let companies = 0n;
      let bani = 0n;
      for (const g of b.groups) {
        const stats = (
          await companyAnalysisStats(deps, { scope: { [field]: { in: [g.key] } } })
        )._unsafeUnwrap();
        expect([stats.companies, stats.filers, stats.metrics[0]]).toEqual([
          g.companies,
          g.filers,
          g.metric,
        ]);
        companies += BigInt(g.companies);
        bani += BigInt((g.metric?.sum ?? '0').replace('.', ''));
      }
      const all = (await companyAnalysisStats(deps, {}))._unsafeUnwrap();
      expect(companies.toString()).toBe(all.companies);
      expect(bani).toBe(BigInt((all.metrics[0]?.sum ?? '0').replace('.', '')));
      // includeUnknown = the union of the basis buckets (never an absence).
      const bases = b.groups.filter((g) => g.basis !== null);
      const unknown = (
        await companyAnalysisStats(deps, { scope: { [field]: { includeUnknown: true } } })
      )._unsafeUnwrap();
      expect(unknown.companies).toBe(
        bases.reduce((sum, g) => sum + BigInt(g.companies), 0n).toString()
      );
    }
  );

  it('refuses a malformed bucket key and canonicalizes basis keys before values', () => {
    expect(
      parseScopeShape({ county: { in: ['(multiple_values'] } })._unsafeUnwrapErr()
    ).toMatchObject({ type: 'InvalidInput' });
    expect(parseScopeShape({ county: { in: ['(nope)'] } })._unsafeUnwrapErr().type).toBe(
      'InvalidInput'
    );
    const shape = parseScopeShape({
      observedStatus: { in: ['1048', '(missing)', '(multiple_values)', '1048'] },
    })._unsafeUnwrap();
    expect(shape.observedStatus).toEqual({
      values: ['1048'],
      bases: ['MULTIPLE_VALUES', 'MISSING'],
      includeUnknown: false,
    });
  });
});

// ── explicit partial / unresolved / complete_empty controls ──────────────────

describe('source-shaped controls: partial, unresolved and complete_empty evidence', () => {
  const CONTROLS_RELEASE = releaseRow(8, ONRC_CONTROLS.companies, ONRC_CONTROLS.statements);
  const controls = () => {
    const engine = makeInMemoryEngine(ONRC_CONTROLS.companies, ONRC_CONTROLS.statements, [8]);
    return analyticsDeps(engine, fakeReleases(CONTROLS_RELEASE), fakeLabels());
  };
  const controlCuis = async (scope: Record<string, unknown>): Promise<string[]> => {
    const page = (
      await companyAnalysisRecords(controls(), { scope, sort: 'CUI', first: 100 })
    )._unsafeUnwrap();
    return page.edges.map((e) => e.node.cui);
  };

  it.each(['COUNTY', 'UAT', 'OBSERVED_STATUS'] as const)(
    '%s: a value group and three null-value basis groups, each company and its money once',
    async (dimension) => {
      const b = (
        await companyAnalysisBreakdown(controls(), { dimension, topN: 10, metric: 'TURNOVER' })
      )._unsafeUnwrap();
      const value = dimension === 'COUNTY' ? 'CJ' : dimension === 'UAT' ? '54975' : '1048';
      expect(
        Object.fromEntries(b.groups.map((g) => [g.key, [g.basis, g.companies, g.metric?.sum]]))
      ).toEqual({
        [value]: [null, '1', '40.00'],
        '(partial_observations)': ['PARTIAL_OBSERVATIONS', '1', '10.00'],
        '(unresolved)': ['UNRESOLVED', '1', '20.00'],
        '(missing)': ['MISSING', '1', '30.00'],
      });
      expect(b.unknown).toMatchObject({ companies: '0', filers: '0' });
      expect(b.totals).toMatchObject({ companies: '4', filers: '4' });
      expect(b.totals.metric?.sum).toBe('100.00');
    }
  );

  it.each(['county', 'uat', 'observedStatus'] as const)(
    '%s: the exact basis keys select their companies; includeUnknown is their union',
    async (field) => {
      const value = field === 'county' ? 'CJ' : field === 'uat' ? '54975' : '1048';
      expect(await controlCuis({ [field]: { in: ['(partial_observations)'] } })).toEqual(['701']);
      expect(await controlCuis({ [field]: { in: ['(unresolved)'] } })).toEqual(['702']);
      expect(await controlCuis({ [field]: { in: ['(missing)'] } })).toEqual(['703']);
      expect(
        await controlCuis({ [field]: { in: ['(partial_observations)', '(unresolved)'] } })
      ).toEqual(['701', '702']);
      // includeUnknown = partial ∪ unresolved ∪ missing, never the value group.
      expect(await controlCuis({ [field]: { includeUnknown: true } })).toEqual([
        '701',
        '702',
        '703',
      ]);
      expect(await controlCuis({ [field]: { in: [value], includeUnknown: true } })).toEqual([
        '701',
        '702',
        '703',
        '704',
      ]);
    }
  );

  it.each([
    ['701', 'partial', { status: ['1048'] }, ['701', '704']],
    ['701', 'partial', { caenCode: ['6201'] }, ['701', '704']],
    ['702', 'unresolved', { status: ['1070'] }, ['702']],
    ['702', 'unresolved', { onrcCaen: ['rev0:0111'] }, ['702']],
  ] as const)(
    '%s (%s coverage): a known public observation still matches positively %j',
    async (_cui, _coverage, onrc, expected) => {
      expect(await controlCuis({ onrc })).toEqual(expected);
    }
  );

  it.each(['partial', 'unresolved'] as const)(
    '%s status/CAEN coverage abstains from every negative filter; complete_empty is a known absence',
    async (coverage) => {
      const abstaining = coverage === 'partial' ? '701' : '702';
      // A code nobody observes: only complete or complete_empty evidence proves its absence.
      for (const exclude of [{ status: ['9999'] }, { caenCode: ['9999'] }]) {
        const cuis = await controlCuis({ onrc: { exclude } });
        expect(cuis).toEqual(['703', '704']);
        expect(cuis).not.toContain(abstaining);
      }
    }
  );

  it('negative filters keep their observed meaning: 704 observes 1048, 703 observes nothing', async () => {
    expect(await controlCuis({ onrc: { exclude: { status: ['1048'] } } })).toEqual(['703']);
    expect(await controlCuis({ onrc: { exclude: { caenCode: ['6201'] } } })).toEqual(['703']);
    // A county exclusion needs a known county: only 704 (CJ) has one.
    expect(await controlCuis({ onrc: { exclude: { county: ['B'] } } })).toEqual(['704']);
  });

  it('703 keeps one resolved identifier with no child observations: no positive match, a known absence', async () => {
    expect(ONRC_CONTROLS.companies.find((c) => c.cui === '703')?.identifiers).toEqual([
      { key: 'J12/703/2010', status: [], county: [], caen: [], keys: [] },
    ]);
    expect(await controlCuis({ onrc: { status: ['1048', '1070'] } })).toEqual([
      '701',
      '702',
      '704',
    ]);
    expect(await controlCuis({ onrc: { county: ['CJ'] } })).toEqual(['701', '704']);
    expect(await controlCuis({ onrc: { caenCode: ['6201', '0111'] } })).toEqual([
      '701',
      '702',
      '704',
    ]);
    // 701/702 abstain (partial/unresolved), 704 observes 1048 and 6201: only 703 passes.
    expect(await controlCuis({ onrc: { exclude: { status: ['1048', '1070'] } } })).toEqual(['703']);
    expect(await controlCuis({ onrc: { exclude: { caenCode: ['6201', '0111'] } } })).toEqual([
      '703',
    ]);
  });

  it('records carry the null values with their bases and coverage', async () => {
    const page = (
      await companyAnalysisRecords(controls(), { sort: 'CUI', first: 10 })
    )._unsafeUnwrap();
    const byCui = new Map(page.edges.map((e) => [e.node.cui, e.node]));
    expect(byCui.get('701')).toMatchObject({
      county: null,
      countyBasis: 'PARTIAL_OBSERVATIONS',
      uat: null,
      uatBasis: 'PARTIAL_OBSERVATIONS',
      observedStatus: null,
      observedStatusBasis: 'PARTIAL_OBSERVATIONS',
      observedStatusCoverage: 'PARTIAL',
      onrcCaenCoverage: 'PARTIAL',
    });
    expect(byCui.get('702')).toMatchObject({
      county: null,
      countyBasis: 'UNRESOLVED',
      uatBasis: 'UNRESOLVED',
      observedStatusBasis: 'UNRESOLVED',
      observedStatusCoverage: 'UNRESOLVED',
      onrcCaenCoverage: 'UNRESOLVED',
    });
    expect(byCui.get('703')).toMatchObject({
      countyBasis: 'MISSING',
      observedStatusBasis: 'MISSING',
      observedStatusCoverage: 'COMPLETE_EMPTY',
      onrcCaenCoverage: 'COMPLETE_EMPTY',
    });
    expect(byCui.get('704')).toMatchObject({
      county: { code: 'CJ' },
      countyBasis: 'SINGLE_OBSERVATION',
      observedStatus: { code: '1048', label: 'funcțiune', labelSource: 'api_nomenclature' },
      observedStatusCoverage: 'COMPLETE',
    });
  });
});

// ── observation filters ──────────────────────────────────────────────────────

describe('ONRC observation filters hold on ONE identifier', () => {
  it('status and county must hold on the same identifier: a split never satisfies the conjunction', async () => {
    // 400: 1048 in AB on one identifier, 1070 in CJ on another.
    expect(await cuisOf({ onrc: { status: ['1048'], county: ['CJ'] } })).toEqual(['100', '600']);
    expect(await cuisOf({ onrc: { status: ['1048'], county: ['AB'] } })).toEqual(['400']);
    expect(await cuisOf({ onrc: { status: ['1070'], county: ['CJ'] } })).toEqual(['400']);
  });

  it('a public 1048 next to a conflicting 1070 is still a 1048 observation; the bucket says multiple_values', async () => {
    expect(await cuisOf({ onrc: { status: ['1070'] } })).toEqual(['300', '400']);
    expect(await cuisOf({ onrc: { status: ['1048'] } })).toEqual([
      '100',
      '200',
      '300',
      '400',
      '500',
      '600',
    ]);
    // The consensus bucket is a different question: 300/400 multiple_values,
    // 500 partial_observations (its public 1048 still matches above).
    expect(await cuisOf({ observedStatus: { in: ['1048'] } })).toEqual(['100', '200', '600']);
  });

  it('exact rev<N>:<code> keeps rev0 distinct and never matches a code of unknown revision', async () => {
    expect(await cuisOf({ onrc: { onrcCaen: ['rev0:0111'] } })).toEqual(['400']);
    // 400's 6201 and 500's 6201 have no known revision: no exact key.
    expect(await cuisOf({ onrc: { onrcCaen: ['rev2:6201'] } })).toEqual(['100', '200', '600']);
    // The broad code matches every revision state.
    expect(await cuisOf({ onrc: { caenCode: ['6201'] } })).toEqual([
      '100',
      '200',
      '400',
      '500',
      '600',
    ]);
  });

  it('exclusions need complete evidence: partial or unknown evidence abstains, never counts as absence', async () => {
    // 300/400 carry 1070; 500's status coverage is partial: it abstains.
    expect(await cuisOf({ onrc: { exclude: { status: ['1070'] } } })).toEqual([
      '100',
      '200',
      '600',
    ]);
    // CAEN coverage is partial for 300, 400 and 500 (a code of unknown revision
    // or hidden rows): all three abstain; 400 also carries 0111.
    expect(await cuisOf({ onrc: { exclude: { caenCode: ['0111'] } } })).toEqual([
      '100',
      '200',
      '600',
    ]);
    // A county exclusion needs a known county: 300 (missing) and 400 (multiple_values) abstain.
    expect(await cuisOf({ onrc: { exclude: { county: ['CJ'] } } })).toEqual(['200', '500']);
    expect(await cuisOf({ onrc: { exclude: { legalForm: ['SRL'] } } })).toEqual(['400']);
  });

  it.each([
    ['an exact-revision exclusion', { exclude: { onrcCaen: ['rev2:6201'] } }],
    ['an unknown field', { name: 'x' }],
    ['an unknown exclusion', { exclude: { uat: ['1'] } }],
    ['an empty filter', {}],
    ['an empty exclusion', { exclude: {} }],
    ['a revision outside rev0..rev3', { onrcCaen: ['rev4:6201'] }],
    ['a five-digit CAEN', { caenCode: ['62011'] }],
    ['a non-numeric status', { status: ['abc'] }],
    ['an empty list', { status: [] }],
  ])('refuses %s before any I/O', async (_label, onrc) => {
    const { deps, engine, releases } = setup();
    const result = await companyAnalysisStats(deps, { scope: { onrc } });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field: expect.stringMatching(/^scope\.onrc/u) as unknown,
    });
    expect([...engine.calls, ...releases.calls]).toEqual([]);
  });

  it('explains why an exact-revision exclusion is refused (absence of an unknown revision is never known)', () => {
    expect(
      parseScopeShape({ onrc: { exclude: { onrcCaen: ['rev2:6201'] } } })._unsafeUnwrapErr()
    ).toEqual({
      type: 'InvalidInput',
      message:
        'scope.onrc.exclude.onrcCaen is not supported: an observation of unknown revision may carry the same code, so its absence is never known (exclude the broad caenCode instead)',
      field: 'scope.onrc.exclude',
    });
  });

  it('binds the observation filter into the scope echo, its hash and the cursor', async () => {
    const { deps } = setup();
    const scope = { onrc: { county: ['CJ'], status: ['1048', '1048'] } };
    const page = (await companyAnalysisRecords(deps, { scope, first: 1 }))._unsafeUnwrap();
    expect(page.scope['onrc']).toEqual({ status: ['1048'], county: ['CJ'] });
    const after = page.pageInfo.endCursor;
    const elsewhere = await companyAnalysisRecords(deps, { first: 1, after });
    expect(elsewhere._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'after' });
  });
});

// ── records ──────────────────────────────────────────────────────────────────

describe('records carry the bases and the exact recorded civil date', () => {
  const nodes = async () => {
    const { deps } = setup();
    const page = (await companyAnalysisRecords(deps, { sort: 'CUI', first: 6 }))._unsafeUnwrap();
    return new Map(page.edges.map((e) => [e.node.cui, e.node]));
  };

  it('serves the recorded date as exact text over years 0001–9999, with its year only', async () => {
    const byCui = await nodes();
    expect(byCui.get('400')).toMatchObject({
      onrcRecordedDate: '0001-01-01',
      onrcRecordedYear: 1,
      onrcRecordedDateBasis: 'SINGLE_OBSERVATION',
    });
    expect(byCui.get('500')).toMatchObject({
      onrcRecordedDate: '9999-12-31',
      onrcRecordedYear: 9999,
    });
    expect(byCui.get('300')).toMatchObject({
      onrcRecordedDate: null,
      onrcRecordedYear: null,
      onrcRecordedDateBasis: 'MISSING',
    });
    for (const node of byCui.values()) expect(node).not.toHaveProperty('registrationYear');
  });

  it('a NULL consensus value is explained by its basis; coverage is explicit', async () => {
    const byCui = await nodes();
    expect(byCui.get('300')).toMatchObject({
      county: null,
      countyBasis: 'MISSING',
      observedStatus: null,
      observedStatusBasis: 'MULTIPLE_VALUES',
      observedStatusCoverage: 'COMPLETE',
      onrcCaenCoverage: 'PARTIAL',
    });
    expect(byCui.get('200')).toMatchObject({
      uat: null,
      uatBasis: 'MISSING',
      observedStatus: { code: '1048', label: 'funcțiune', labelSource: 'api_nomenclature' },
      observedStatusBasis: 'CONSISTENT_OBSERVATIONS',
      legalFormBasis: 'SINGLE_OBSERVATION',
    });
  });

  it.each([
    ['a non-calendar date', { recordedDate: '2024-02-30', recordedYear: '2024' }],
    ['a year that is not the date’s', { recordedDate: '2010-05-17', recordedYear: '2011' }],
    ['a year without a date', { recordedDate: null, recordedYear: '2010' }],
    ['a date without a year', { recordedDate: '2010-05-17', recordedYear: null }],
    ['an unknown basis', { countyBasis: 'guessed' }],
    ['an unknown coverage', { statusCoverage: 'mostly' }],
  ])('fails fast on %s from the engine', async (_label, over) => {
    const { deps, engine } = setup();
    const broken: CompanyAnalysisEngine = {
      ...engine,
      records: async (release, scope, request) =>
        (await engine.records(release, scope, request)).map((rows) =>
          rows.map((row) => ({ ...row, ...over }))
        ),
    };
    const result = await companyAnalysisRecords({ ...deps, engine: broken }, { first: 1 });
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'Database' });
  });
});

// ── exact large integers ─────────────────────────────────────────────────────

describe('exact large sums (Decimal128 money, Int128 headcount)', () => {
  it('keeps sums beyond Int64 and 2^63 bani exact, and a mean exact to the bani', async () => {
    const { deps, engine } = setup();
    const statuses = (reported: string, missing: string) => ({
      REPORTED: reported,
      MISSING: missing,
      NOT_ADMITTED: '0',
      HELD_PROFILE: '0',
      HELD_OBSERVATION: '0',
      HELD_QUALITY: '0',
      HELD_COMPONENT: '0',
    });
    const huge: CompanyAnalysisEngine = {
      ...engine,
      aggregateFilers: () =>
        Promise.resolve(
          ok({
            filers: '5',
            metrics: new Map([
              // Int128: two Int64 maxima, beyond what sum(Int64) could hold.
              ['EMPLOYEES' as const, { sum: '18446744073709551614', statuses: statuses('2', '3') }],
              // Decimal128: beyond 2^63 bani.
              [
                'TURNOVER' as const,
                { sum: '99999999999999999999.99', statuses: statuses('3', '2') },
              ],
            ]),
          })
        ),
    };
    const stats = (
      await companyAnalysisStats({ ...deps, engine: huge }, { metrics: ['TURNOVER', 'EMPLOYEES'] })
    )._unsafeUnwrap();
    expect(stats.metrics.map((m) => [m.metric, m.sum, m.contributors, m.mean])).toEqual([
      ['TURNOVER', '99999999999999999999.99', '3', '33333333333333333333.33'],
      ['EMPLOYEES', '18446744073709551614', '2', '9223372036854775807.00'],
    ]);
  });
});
