import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AllowlistValidationError,
  applyAllowlist,
  entryFullPattern,
  entryId,
  entryMatchesDifference,
  findStaleEntries,
  fingerprintOf,
  fingerprintSha256,
  isStrictAllowlist,
  loadAllowlist,
  pathPatternRegex,
  predicateHolds,
  resolveAllowlistPath,
  summarizeAllowed,
  validateAllowlist,
  type AllowlistEntry,
} from '../../golden-master/allowlist.js';
import { LosslessNumber } from '../../golden-master/envelope.js';

import type { Difference, DifferenceKind } from '../../golden-master/compare.js';

const KEY = `${'a'.repeat(64)}:${'b'.repeat(64)}`;
const OTHER_KEY = `${'c'.repeat(64)}:${'d'.repeat(64)}`;

const parity = (path: string, expected: unknown = 'old', actual: unknown = 'new'): Difference => ({
  class: 'data-parity',
  kind: 'value-change',
  path,
  expected,
  actual,
  message: 'differs',
});
const numeric = (path: string, expected: number, actual: number): Difference =>
  parity(path, new LosslessNumber(String(expected)), new LosslessNumber(String(actual)));
const contractBreak: Difference = {
  class: 'contract-break',
  kind: 'missing-key',
  path: '$.data.x.y',
  message: 'missing',
};
const nullLoss: Difference = {
  class: 'contract-break',
  kind: 'null-loss',
  path: '$.data.entity.uat',
  expected: { name: 'X' },
  actual: null,
  message: 'gone',
};
const arrayOrder: Difference = {
  class: 'contract-break',
  kind: 'array-order',
  path: '$.data.entities.nodes',
  expected: 0,
  actual: 3,
  message: 'reordered',
};
const rounding: Difference = {
  class: 'rounding',
  kind: 'value-change',
  path: '$.data.amount',
  message: 'rounding',
};

function pinned(
  path: string,
  before: unknown,
  after: unknown,
  key = KEY,
  kind: DifferenceKind = 'value-change'
) {
  return { type: 'pinned', key, path, kind, before, after, reason: 'pinned' };
}

const systematic: AllowlistEntry = {
  type: 'systematic',
  deltaId: 'per-capita-denominator',
  root: 'entityAnalytics',
  pathPattern: 'nodes[*].per_capita_amount',
  kind: 'value-change',
  predicate: { ratio: { min: 1.85, max: 1.95 } },
  reason: 'resident vs domicile population',
};

const drift: AllowlistEntry = {
  type: 'drift',
  deltaId: 'f0-aggregated',
  root: 'aggregatedLineItems',
  pathPattern: 'nodes[*].amount',
  kind: 'value-drift',
  explanation: 'Chronos re-statements',
};

describe('golden-master allowlist: schema', () => {
  it('validates the three entry kinds and rejects unknown types and legacy id-only entries', () => {
    expect(validateAllowlist({ entries: [] })).toEqual({ entries: [] });
    expect(
      validateAllowlist({ entries: [pinned('$.data.a', 1, 2), systematic, drift] }).entries
    ).toHaveLength(3);
    expect(() => validateAllowlist({ entries: [{ id: 'x', reason: 'r' }] })).toThrow(
      AllowlistValidationError
    );
    expect(() => validateAllowlist({ entries: [{ ...systematic, type: 'other' }] })).toThrow(
      AllowlistValidationError
    );
  });

  it('pinned: requires key, exact path, pinnable kind, reason and a complete before/after pin', () => {
    const good = pinned('$.data.a', 1, 2);
    for (const missing of ['key', 'path', 'kind', 'reason'] as const) {
      const broken = Object.fromEntries(
        Object.entries(good).filter(([field]) => field !== missing)
      );
      expect(() => validateAllowlist({ entries: [broken] }), missing).toThrow(
        AllowlistValidationError
      );
    }
    expect(() => validateAllowlist({ entries: [{ ...good, reason: '' }] })).toThrow(
      AllowlistValidationError
    );
    expect(() => validateAllowlist({ entries: [{ ...good, key: 'short' }] })).toThrow(
      AllowlistValidationError
    );
    expect(() => validateAllowlist({ entries: [{ ...good, path: 'data.a' }] })).toThrow(
      AllowlistValidationError
    );
    // Contract-break kinds are not pinnable at all.
    expect(() => validateAllowlist({ entries: [{ ...good, kind: 'missing-key' }] })).toThrow(
      AllowlistValidationError
    );
    expect(() => validateAllowlist({ entries: [{ ...good, kind: 'null-loss' }] })).toThrow(
      AllowlistValidationError
    );
    expect(() => validateAllowlist({ entries: [{ ...good, kind: 'array-order' }] })).toThrow(
      AllowlistValidationError
    );

    const base = { type: 'pinned', key: KEY, path: '$.data.a', kind: 'value-change', reason: 'r' };
    expect(() => validateAllowlist({ entries: [base] })).toThrow(/must pin the difference/);
    expect(() => validateAllowlist({ entries: [{ ...base, before: 1 }] })).toThrow(
      /only one of "before"\/"after"/
    );
    expect(() =>
      validateAllowlist({ entries: [{ ...base, beforeSha256: 'a'.repeat(64) }] })
    ).toThrow(/only one of "beforeSha256"\/"afterSha256"/);
  });

  it('systematic: requires a delta id, root, pattern, value-change kind and a bounded predicate', () => {
    for (const missing of ['deltaId', 'root', 'pathPattern', 'predicate', 'reason'] as const) {
      const broken = Object.fromEntries(
        Object.entries(systematic).filter(([field]) => field !== missing)
      );
      expect(() => validateAllowlist({ entries: [broken] }), missing).toThrow(
        AllowlistValidationError
      );
    }
    expect(() => validateAllowlist({ entries: [{ ...systematic, kind: 'null-change' }] })).toThrow(
      AllowlistValidationError
    );
    expect(() =>
      validateAllowlist({ entries: [{ ...systematic, predicate: { ratio: { min: 2, max: 1 } } }] })
    ).toThrow(/empty or non-finite ratio range/);
    expect(() =>
      validateAllowlist({
        entries: [{ ...systematic, predicate: { ratio: { min: 0.5, max: 2 } } }],
      })
    ).toThrow(/contains 1/);
    expect(() =>
      validateAllowlist({ entries: [{ ...systematic, predicate: { relativeTolerance: -1 } }] })
    ).toThrow(AllowlistValidationError);
    expect(() =>
      validateAllowlist({ entries: [{ ...systematic, pathPattern: 'nodes[*]..amount' }] })
    ).toThrow(AllowlistValidationError);
    expect(() => validateAllowlist({ entries: [{ ...systematic, deltaId: 'Bad Id' }] })).toThrow(
      AllowlistValidationError
    );
    expect(
      validateAllowlist({
        entries: [{ ...systematic, predicate: { relativeTolerance: 1e-9 } }],
      }).entries
    ).toHaveLength(1);
    expect(
      validateAllowlist({ entries: [{ ...systematic, predicate: { absoluteTolerance: 0.01 } }] })
        .entries
    ).toHaveLength(1);
  });

  it('drift: allows only value-drift / array-cardinality and needs an explanation', () => {
    expect(() => validateAllowlist({ entries: [{ ...drift, kind: 'value-change' }] })).toThrow(
      AllowlistValidationError
    );
    expect(() => validateAllowlist({ entries: [{ ...drift, kind: 'missing-key' }] })).toThrow(
      AllowlistValidationError
    );
    expect(() => validateAllowlist({ entries: [{ ...drift, explanation: '' }] })).toThrow(
      AllowlistValidationError
    );
    expect(() => validateAllowlist({ entries: [{ ...drift, predicate: {} }] })).toThrow(
      AllowlistValidationError
    );
  });

  it('rejects duplicate entries', () => {
    expect(() => validateAllowlist({ entries: [drift, drift] })).toThrow(
      /duplicates an earlier entry/
    );
    expect(() =>
      validateAllowlist({ entries: [pinned('$.data.a', 1, 2), pinned('$.data.a', 3, 4)] })
    ).toThrow(/duplicates/);
  });
});

describe('golden-master allowlist: patterns and predicates', () => {
  it('expands root + pattern to a full JSONPath and matches [*] / * wildcards only', () => {
    expect(entryFullPattern(systematic)).toBe('$.data.entityAnalytics.nodes[*].per_capita_amount');
    expect(entryFullPattern({ ...drift, pathPattern: '' })).toBe('$.data.aggregatedLineItems');
    expect(entryFullPattern({ ...drift, pathPattern: '[*].amount' })).toBe(
      '$.data.aggregatedLineItems[*].amount'
    );
    const regex = pathPatternRegex('$.data.entityAnalytics.nodes[*].per_capita_amount');
    expect(regex.test('$.data.entityAnalytics.nodes[0].per_capita_amount')).toBe(true);
    expect(regex.test('$.data.entityAnalytics.nodes[1234].per_capita_amount')).toBe(true);
    expect(regex.test('$.data.entityAnalytics.nodes[0].amount')).toBe(false);
    expect(regex.test('$.data.entityAnalytics.nodes[0].per_capita_amount.x')).toBe(false);
    expect(regex.test('$.data.entityAnalytics.pageInfo.totalCount')).toBe(false);
    const star = pathPatternRegex('$.data.heatmap.*.value');
    expect(star.test('$.data.heatmap.CJ.value')).toBe(true);
    expect(star.test('$.data.heatmap.CJ.extra.value')).toBe(false);
  });

  it('evaluates ratio, relative and absolute predicates on exact decimals only', () => {
    expect(predicateHolds({ ratio: { min: 1.85, max: 1.95 } }, 100, 190)).toBe(true);
    expect(predicateHolds({ ratio: { min: 1.85, max: 1.95 } }, 100, 196)).toBe(false);
    expect(predicateHolds({ ratio: { min: 1.85, max: 1.95 } }, 0, 190)).toBe(false);
    expect(
      predicateHolds(
        { relativeTolerance: 1e-9 },
        new LosslessNumber('123456789012.34'),
        new LosslessNumber('123456789012.3400001')
      )
    ).toBe(true);
    expect(predicateHolds({ relativeTolerance: 1e-9 }, 100, 100.01)).toBe(false);
    expect(predicateHolds({ absoluteTolerance: 0.5 }, 10, 10.4)).toBe(true);
    expect(predicateHolds({ absoluteTolerance: 0.5 }, 10, 10.6)).toBe(false);
    expect(predicateHolds({ absoluteTolerance: 0.5 }, '10', '10.4')).toBe(false);
  });
});

describe('golden-master allowlist: fingerprints', () => {
  it('renders numbers as decimal text so lossless and plain numbers fingerprint alike', () => {
    expect(fingerprintOf(1.5)).toBe('"1.5"');
    expect(fingerprintOf(new LosslessNumber('1.50'))).toBe('"1.5"');
    expect(fingerprintOf({ b: new LosslessNumber('9007199254740993'), a: 'x' })).toBe(
      '{"a":"x","b":"9007199254740993"}'
    );
    expect(fingerprintOf(undefined)).toBe('"<absent>"');
    expect(fingerprintSha256(1.5)).toBe(fingerprintSha256(new LosslessNumber('1.5')));
  });
});

describe('golden-master allowlist: matching', () => {
  it('never allowlists contract-breaks (null-loss, array-order included) and never blocks on rounding', () => {
    const allowlist = validateAllowlist({
      entries: [
        { ...drift, root: 'x', pathPattern: 'y' },
        { ...drift, root: 'entity', pathPattern: 'uat', deltaId: 'd2' },
        {
          ...drift,
          root: 'entities',
          pathPattern: 'nodes',
          kind: 'array-cardinality',
          deltaId: 'd3',
        },
      ],
    });
    const applied = applyAllowlist([contractBreak, nullLoss, arrayOrder, rounding], allowlist, KEY);
    expect(applied.blocking).toEqual([contractBreak, nullLoss, arrayOrder]);
    expect(applied.informational).toEqual([rounding]);
    expect(applied.allowed).toEqual([]);
  });

  it('pinned: exact key+path+kind+before/after only', () => {
    const difference = parity('$.data.entities.nodes[0].name', 'OLD', 'NEW');
    expect(applyAllowlist([difference], { entries: [] }, KEY).blocking).toEqual([difference]);

    const exact = validateAllowlist({
      entries: [pinned('$.data.entities.nodes[0].name', 'OLD', 'NEW')],
    });
    const applied = applyAllowlist([difference], exact, KEY);
    expect(applied.blocking).toEqual([]);
    expect(applied.allowed[0]?.entry.type).toBe('pinned');
    expect(applied.allowed[0]?.relativeDifference).toBeNull();

    for (const entry of [
      pinned('$.data.entities.nodes[0].name', 'OLD', 'NEW', OTHER_KEY),
      pinned('$.data.entities.nodes[1].name', 'OLD', 'NEW'),
      pinned('$.data.entities.nodes', 'OLD', 'NEW'),
      pinned('$.data.entities.nodes[0].name', 'OLD', 'NEW', KEY, 'null-change'),
      pinned('$.data.entities.nodes[0].name', 'OLD', 'NEWER'),
      pinned('$.data.entities.nodes[0].name', 'OLDER', 'NEW'),
    ]) {
      const result = applyAllowlist([difference], validateAllowlist({ entries: [entry] }), KEY);
      expect(result.blocking, JSON.stringify(entry)).toEqual([difference]);
    }
  });

  it('total-count-change: a contract-break that only an exact pin admits (never a pattern)', () => {
    const totalCount: Difference = {
      class: 'contract-break',
      kind: 'total-count-change',
      path: '$.data.economicClassifications.pageInfo.totalCount',
      expected: 23,
      actual: 19,
      message: 'pageInfo must match exactly',
    };
    const pageInfo: Difference = {
      ...totalCount,
      kind: 'page-info-change',
      path: '$.data.x.pageInfo.hasNextPage',
    };

    // Unpinned: blocking. Drift and systematic entries never cover it.
    expect(applyAllowlist([totalCount], { entries: [] }, KEY).blocking).toEqual([totalCount]);
    const patterns = validateAllowlist({
      entries: [
        { ...drift, root: 'economicClassifications', pathPattern: 'pageInfo.totalCount' },
        {
          type: 'systematic',
          deltaId: 's1',
          root: 'economicClassifications',
          pathPattern: 'pageInfo.totalCount',
          kind: 'value-change',
          predicate: { ratio: { min: 0.5, max: 0.9 } },
          reason: 'r',
        },
      ],
    });
    expect(applyAllowlist([totalCount], patterns, KEY).blocking).toEqual([totalCount]);

    // Exact pin: admitted and recorded as allowed; wrong numbers or key: blocking.
    const exact = validateAllowlist({
      entries: [pinned(totalCount.path, 23, 19, KEY, 'total-count-change')],
    });
    const applied = applyAllowlist([totalCount], exact, KEY);
    expect(applied.blocking).toEqual([]);
    expect(applied.allowed[0]?.entry.type).toBe('pinned');
    for (const entry of [
      pinned(totalCount.path, 23, 18, KEY, 'total-count-change'),
      pinned(totalCount.path, 23, 19, OTHER_KEY, 'total-count-change'),
      pinned(totalCount.path, 23, 19, KEY, 'value-change'),
    ]) {
      const result = applyAllowlist([totalCount], validateAllowlist({ entries: [entry] }), KEY);
      expect(result.blocking, JSON.stringify(entry)).toEqual([totalCount]);
    }

    // Other pageInfo changes stay unpinnable contract-breaks.
    expect(() =>
      validateAllowlist({ entries: [pinned(pageInfo.path, true, false, KEY, 'page-info-change')] })
    ).toThrow(AllowlistValidationError);
    expect(applyAllowlist([pageInfo], exact, KEY).blocking).toEqual([pageInfo]);
  });

  it('pinned: matches by sha256 fingerprints with lossless numbers', () => {
    const difference = numeric('$.data.total', 9007199254740992, 1);
    difference.actual = new LosslessNumber('9007199254740993');
    const byHash = validateAllowlist({
      entries: [
        {
          type: 'pinned',
          key: KEY,
          path: '$.data.total',
          kind: 'value-change',
          reason: 'r',
          beforeSha256: fingerprintSha256(difference.expected),
          afterSha256: fingerprintSha256(difference.actual),
        },
      ],
    });
    expect(entryMatchesDifference(byHash.entries[0]!, KEY, difference)).toBe(true);
  });

  it('systematic: covers numeric value-change under the pattern only when the predicate holds', () => {
    const inside = numeric('$.data.entityAnalytics.nodes[7].per_capita_amount', 100, 190);
    const outsideBound = numeric('$.data.entityAnalytics.nodes[8].per_capita_amount', 100, 250);
    const otherField = numeric('$.data.entityAnalytics.nodes[7].total_amount', 100, 190);
    const notNumeric = parity('$.data.entityAnalytics.nodes[7].per_capita_amount', '100', '190');
    const nullChange: Difference = {
      ...numeric('$.data.entityAnalytics.nodes[9].per_capita_amount', 0, 190),
      kind: 'null-change',
      expected: null,
    };
    const applied = applyAllowlist(
      [inside, outsideBound, otherField, notNumeric, nullChange],
      validateAllowlist({ entries: [systematic] }),
      KEY
    );
    expect(applied.allowed.map((a) => a.difference)).toEqual([inside]);
    expect(applied.allowed[0]?.relativeDifference).toBeCloseTo(0.4736842, 6);
    expect(applied.blocking).toEqual([outsideBound, otherField, notNumeric, nullChange]);

    const scoped = validateAllowlist({ entries: [{ ...systematic, caseKeys: [OTHER_KEY] }] });
    expect(applyAllowlist([inside], scoped, KEY).blocking).toEqual([inside]);
    expect(applyAllowlist([inside], scoped, OTHER_KEY).allowed).toHaveLength(1);
  });

  it('drift: value-drift covers value-change and null-change scalars, array-cardinality covers array-length, nothing else', () => {
    const amount = numeric('$.data.aggregatedLineItems.nodes[3].amount', 10, 12);
    const text = parity('$.data.aggregatedLineItems.nodes[3].amount', 'a', 'b');
    const gained: Difference = { ...amount, kind: 'null-change', expected: null };
    const other = numeric('$.data.aggregatedLineItems.nodes[3].count', 1, 2);
    const length: Difference = {
      class: 'data-parity',
      kind: 'array-length',
      path: '$.data.aggregatedLineItems.nodes',
      expected: 100,
      actual: 98,
      message: 'm',
    };
    const applied = applyAllowlist(
      [amount, text, gained, other, length],
      validateAllowlist({ entries: [drift] }),
      KEY
    );
    expect(applied.allowed.map((a) => a.difference)).toEqual([amount, text, gained]);
    expect(applied.blocking).toEqual([other, length]);

    const cardinality = validateAllowlist({
      entries: [{ ...drift, pathPattern: 'nodes', kind: 'array-cardinality', deltaId: 'f0-rows' }],
    });
    const lengths = applyAllowlist([length, amount], cardinality, KEY);
    expect(lengths.allowed.map((a) => a.difference)).toEqual([length]);
    expect(lengths.allowed[0]?.relativeDifference).toBeCloseTo(0.02, 6);
    expect(lengths.blocking).toEqual([amount]);
  });

  it('summarizes matches per entry with the largest relative difference and its path', () => {
    const applied = applyAllowlist(
      [
        numeric('$.data.aggregatedLineItems.nodes[0].amount', 100, 101),
        numeric('$.data.aggregatedLineItems.nodes[1].amount', 100, 150),
        numeric('$.data.aggregatedLineItems.nodes[2].amount', 100, 120),
      ],
      validateAllowlist({ entries: [drift] }),
      KEY
    );
    expect(summarizeAllowed(applied.allowed)).toEqual([
      {
        entryId: entryId(drift),
        type: 'drift',
        deltaId: 'f0-aggregated',
        matches: 3,
        maxRelativeDifference: 1 / 3,
        maxRelativeDifferencePath: '$.data.aggregatedLineItems.nodes[1].amount',
      },
    ]);
  });
});

describe('golden-master allowlist: loading from a file', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('loads all three kinds from JSON: predicate bounds as numbers, pinned values lossless', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-allowlist-'));
    const file = path.join(dir, 'allowlist.json');
    writeFileSync(
      file,
      JSON.stringify({
        entries: [
          systematic,
          { ...systematic, deltaId: 'tol', predicate: { relativeTolerance: 1e-9 } },
          drift,
          {
            type: 'pinned',
            key: KEY,
            path: '$.data.total',
            kind: 'value-change',
            before: 9007199254740992,
            after: 1,
            reason: 'r',
          },
        ],
      }).replace('"after":1', '"after":9007199254740993'),
      'utf8'
    );
    const loaded = loadAllowlist(file);
    expect(loaded.entries).toHaveLength(4);
    expect(loaded.entries[0]).toMatchObject({ predicate: { ratio: { min: 1.85, max: 1.95 } } });
    expect(loaded.entries[1]).toMatchObject({ predicate: { relativeTolerance: 1e-9 } });
    const pinnedEntry = loaded.entries[3];
    expect(pinnedEntry?.type).toBe('pinned');
    expect(fingerprintOf((pinnedEntry as { after: unknown }).after)).toBe('"9007199254740993"');
    // The lossless pinned value matches the lossless wire value exactly.
    const difference = numeric('$.data.total', 9007199254740992, 1);
    difference.actual = new LosslessNumber('9007199254740993');
    expect(entryMatchesDifference(pinnedEntry!, KEY, difference)).toBe(true);
  });
});

describe('golden-master allowlist: staleness and env', () => {
  it('reports entries of any kind that matched nothing as stale', () => {
    const used = pinned('$.data.a', 1, 2);
    const allowlist = validateAllowlist({ entries: [used, systematic, drift] });
    const stale = findStaleEntries(allowlist, new Set([entryId(allowlist.entries[0]!)]));
    expect(stale.map((e) => e.type)).toEqual(['systematic', 'drift']);
    expect(findStaleEntries(allowlist, new Set())).toHaveLength(3);
  });

  it('is strict unless TEST_GM_STRICT_ALLOWLIST is literally "false"; allowlist path is overridable', () => {
    expect(isStrictAllowlist({})).toBe(true);
    expect(isStrictAllowlist({ TEST_GM_STRICT_ALLOWLIST: 'true' })).toBe(true);
    expect(isStrictAllowlist({ TEST_GM_STRICT_ALLOWLIST: 'false' })).toBe(false);
    expect(resolveAllowlistPath({})).toMatch(/parity-allowlist\.json$/);
    expect(resolveAllowlistPath({ TEST_GM_ALLOWLIST_PATH: '/tmp/x.json' })).toBe('/tmp/x.json');
  });
});
