import { describe, expect, it } from 'vitest';

import { makeFaultPlan } from '../../support/index.js';

type Method = 'create' | 'read';

describe('makeFaultPlan', () => {
  it('fails once by default and records every intercepted call', () => {
    const plan = makeFaultPlan<Method, string>();
    plan.fail('create', { error: 'boom' });

    expect(plan.intercept('create')).toBe('boom');
    expect(plan.intercept('create')).toBeUndefined();
    expect(plan.callCount('create')).toBe(2);
  });

  it('starts on the requested 1-indexed call and spends a consecutive times budget', () => {
    const plan = makeFaultPlan<Method, string>();
    plan.fail('read', { error: 'offline', onCall: 3, times: 2 });

    expect([
      plan.intercept('read'),
      plan.intercept('read'),
      plan.intercept('read'),
      plan.intercept('read'),
      plan.intercept('read'),
    ]).toEqual([undefined, undefined, 'offline', 'offline', undefined]);
    expect(plan.callCount('read')).toBe(5);
  });

  it('supports always faults until the method is cleared', () => {
    const plan = makeFaultPlan<Method, string>();
    plan.fail('create', { error: 'persistent', times: 'always' });

    expect(plan.intercept('create')).toBe('persistent');
    expect(plan.intercept('create')).toBe('persistent');
    plan.clear('create');
    expect(plan.callCount('create')).toBe(0);
    expect(plan.intercept('create')).toBeUndefined();
  });

  it('keeps methods independent and clear without a method resets the plan', () => {
    const plan = makeFaultPlan<Method, string>();
    plan.fail('create', { error: 'create failed', times: 'always' });
    plan.fail('read', { error: 'read failed', times: 'always' });

    expect(plan.intercept('create')).toBe('create failed');
    expect(plan.intercept('read')).toBe('read failed');
    plan.clear();
    expect(plan.callCount('create')).toBe(0);
    expect(plan.callCount('read')).toBe(0);
    expect(plan.intercept('create')).toBeUndefined();
    expect(plan.intercept('read')).toBeUndefined();
  });
});
