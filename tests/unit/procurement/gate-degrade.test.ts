/**
 * Capability gate v2 (design §5.4): spend is STRICT (allow or abstain — money is
 * nulled, never zeroed, never degraded); count/time answers degrade with
 * disclosure down to the floor; a grain without a quality verdict abstains.
 */

import { describe, expect, it } from 'vitest';

import {
  COUNT_TIME_DEGRADE_FLOOR,
  decideAnswer,
  type GenerationQuality,
} from '@/modules/procurement/core/gate-v2.js';

import { verdict } from './analysis-fakes.js';

const quality = (over: Parameters<typeof verdict>[0]): GenerationQuality => ({
  direct_acquisition: verdict(over),
});

describe('count class', () => {
  it('is ALWAYS allowed — even without any quality verdict', () => {
    expect(decideAnswer(undefined, 'direct_acquisition', 'count')).toEqual({
      allow: true,
      degraded: false,
      caveats: [],
    });
    expect(decideAnswer({}, 'procedure', 'count').allow).toBe(true);
  });
});

describe('spend class (strict, no degrade path)', () => {
  it('allows on classes.spend=allow with no caveat', () => {
    expect(decideAnswer(quality({}), 'direct_acquisition', 'spend')).toEqual({
      allow: true,
      degraded: false,
      caveats: [],
    });
  });

  it('abstains with a coverage-disclosing caveat on classes.spend=abstain', () => {
    const d = decideAnswer(
      quality({ spend: 'abstain', value: 0.76 }),
      'direct_acquisition',
      'spend'
    );
    expect(d.allow).toBe(false);
    expect(d.degraded).toBe(false);
    expect(d.reason).toBe('SPEND_COVERAGE_BELOW_GATE');
    expect(d.caveats[0]).toContain('spend answers abstain');
    expect(d.caveats[0]).toContain('0.76');
    expect(d.caveats[0]).toContain('omitted, not zeroed');
  });
});

describe('time class (disclosed degradation)', () => {
  it('allow → clean', () => {
    expect(decideAnswer(quality({}), 'direct_acquisition', 'time').allow).toBe(true);
  });

  it('degraded → served, flagged, coverage disclosed', () => {
    const d = decideAnswer(quality({ time: 'degraded', date: 0.65 }), 'direct_acquisition', 'time');
    expect(d.allow).toBe(true);
    expect(d.degraded).toBe(true);
    expect(d.reason).toBe('TIME_COVERAGE_DEGRADED');
    expect(d.caveats[0]).toContain('degraded');
    expect(d.caveats[0]).toContain('0.65');
    expect(d.caveats[0]).toContain(String(COUNT_TIME_DEGRADE_FLOOR));
  });

  it('abstain → blocked with the floor named', () => {
    const d = decideAnswer(quality({ time: 'abstain', date: 0.3 }), 'direct_acquisition', 'time');
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('TIME_COVERAGE_BELOW_FLOOR');
    expect(d.caveats[0]).toContain('abstain');
    expect(d.caveats[0]).toContain(String(COUNT_TIME_DEGRADE_FLOOR));
  });
});

describe('geo class', () => {
  it('follows classes.geo through allow/degraded/abstain', () => {
    expect(decideAnswer(quality({}), 'direct_acquisition', 'geo').allow).toBe(true);
    const degraded = decideAnswer(quality({ geo: 'degraded' }), 'direct_acquisition', 'geo');
    expect(degraded.allow).toBe(true);
    expect(degraded.degraded).toBe(true);
    expect(degraded.reason).toBe('GEO_COVERAGE_DEGRADED');
    const abstained = decideAnswer(quality({ geo: 'abstain' }), 'direct_acquisition', 'geo');
    expect(abstained.allow).toBe(false);
    expect(abstained.reason).toBe('GEO_COVERAGE_BELOW_FLOOR');
  });
});

describe('classes are the contract; coverage numbers are descriptive', () => {
  it('classes win when they contradict the coverage numbers (low coverage, allow class)', () => {
    const d = decideAnswer(quality({ time: 'allow', date: 0.2 }), 'direct_acquisition', 'time');
    expect(d).toEqual({ allow: true, degraded: false, caveats: [] });
    const s = decideAnswer(quality({ spend: 'allow', value: 0.1 }), 'direct_acquisition', 'spend');
    expect(s.allow).toBe(true);
  });

  it('exactly-at-floor coverage serves when the class says degraded', () => {
    const d = decideAnswer(
      quality({ time: 'degraded', date: COUNT_TIME_DEGRADE_FLOOR }),
      'direct_acquisition',
      'time'
    );
    expect(d.allow).toBe(true);
    expect(d.degraded).toBe(true);
  });

  it('just-below-floor coverage blocks when the class says abstain', () => {
    const d = decideAnswer(quality({ time: 'abstain', date: 0.49 }), 'direct_acquisition', 'time');
    expect(d.allow).toBe(false);
    expect(d.caveats[0]).toContain('0.49');
  });
});

describe('missing quality verdicts', () => {
  it('a grain absent from the quality jsonb abstains for every non-count class', () => {
    for (const gateClass of ['spend', 'time', 'geo'] as const) {
      const d = decideAnswer(quality({}), 'contract', gateClass);
      expect(d.allow).toBe(false);
      expect(d.reason).toBe('MISSING_QUALITY_VERDICT');
      expect(d.caveats[0]).toContain("no quality verdict for grain 'contract'");
    }
  });

  it('no quality at all (no active generation payload) abstains the same way', () => {
    const d = decideAnswer(undefined, 'direct_acquisition', 'spend');
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('MISSING_QUALITY_VERDICT');
    expect(d.caveats[0]).toContain('no quality verdict');
  });
});
