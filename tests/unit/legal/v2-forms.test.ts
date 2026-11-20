/**
 * legal_v2 forms: the version mapping, document ids, and the default-form rule
 * (rebuild-model.md §7, mirrored from `legal_v2.default_forms`).
 */

import { describe, expect, it } from 'vitest';

import {
  bucharestToday,
  computeDefaultForm,
  formDocumentId,
  parseDocumentRef,
  versionKindOf,
  type V2FormState,
} from '@/modules/legal/core/v2/forms.js';

const DAY = '2026-11-20';

let nextId = 100;
const form = (over: Partial<V2FormState>): V2FormState => ({
  formId: String((nextId += 1)),
  actId: '1',
  formKind: 'consolidation',
  formKey: 'k',
  portalOrderDate: '2020-01-01',
  orderRank: null,
  accepted: true,
  bodyResolved: true,
  ended: false,
  readable: true,
  held: false,
  ...over,
});

const original = (over: Partial<V2FormState> = {}): V2FormState =>
  form({ formKind: 'original', portalOrderDate: '2010-05-05', ...over });

describe('version mapping and document ids', () => {
  it('maps the form kinds onto the version kinds the client renders', () => {
    expect(versionKindOf('original')).toBe('original');
    expect(versionKindOf('republication')).toBe('republicare');
    expect(versionKindOf('consolidation')).toBe('consolidare');
    expect(versionKindOf('something-new')).toBe('something-new');
  });

  it('names a form f<form_id> and reads old page ids apart from form ids', () => {
    expect(formDocumentId('42')).toBe('f42');
    expect(parseDocumentRef('f42')).toEqual({ kind: 'form', formId: '42' });
    expect(parseDocumentRef('171282')).toEqual({ kind: 'page', pageId: '171282' });
    for (const bad of [
      'f',
      'f0',
      'f-1',
      'F42',
      'x',
      '',
      '0',
      '01',
      'f42x',
      'f1234567890123456789',
    ]) {
      expect(parseDocumentRef(bad)).toEqual({ kind: 'invalid' });
    }
  });

  it("computes today on the Portal's calendar", () => {
    expect(bucharestToday(new Date('2026-11-20T22:30:00Z'))).toBe('2026-11-21');
    expect(bucharestToday(new Date('2026-11-20T10:00:00Z'))).toBe('2026-11-20');
  });
});

describe('default form (rebuild-model §7)', () => {
  it('picks the latest available consolidation not after the day', () => {
    const o = original();
    const c1 = form({ portalOrderDate: '2019-01-01' });
    const c2 = form({ portalOrderDate: '2024-03-01' });
    const def = computeDefaultForm('1', [o, c1, c2], DAY);
    expect(def.defaultFormId).toBe(c2.formId);
    expect(def.basis).toBe('latest_consolidation');
    expect(def.defaultPortalDate).toBe('2024-03-01');
    expect(def.newerNotAvailable).toBe(0);
  });

  it('never picks a future consolidation, and counts it as a future form', () => {
    const o = original();
    const past = form({ portalOrderDate: '2021-01-01' });
    const future = form({ portalOrderDate: '2027-01-01' });
    const def = computeDefaultForm('1', [o, past, future], DAY);
    expect(def.defaultFormId).toBe(past.formId);
    expect(def.futureForms).toBe(1);
  });

  it('skips a newer consolidation without text and counts it as not available', () => {
    const o = original();
    const shown = form({ portalOrderDate: '2021-01-01' });
    const noText = form({ portalOrderDate: '2023-01-01', readable: false });
    const notAccepted = form({ portalOrderDate: '2024-01-01', accepted: false });
    const noBody = form({ portalOrderDate: '2025-01-01', bodyResolved: false });
    const def = computeDefaultForm('1', [o, shown, noText, notAccepted, noBody], DAY);
    expect(def.defaultFormId).toBe(shown.formId);
    expect(def.newerNotAvailable).toBe(3);
  });

  it('falls back to the original, counting every consolidation that cannot be shown', () => {
    const o = original();
    const c = form({ portalOrderDate: '2023-01-01', readable: false });
    const def = computeDefaultForm('1', [o, c], DAY);
    expect(def.defaultFormId).toBe(o.formId);
    expect(def.basis).toBe('original');
    expect(def.newerNotAvailable).toBe(1);
  });

  it('chooses neither of two same-date consolidations that are not both ranked', () => {
    const o = original();
    const older = form({ portalOrderDate: '2020-06-01' });
    const a = form({ portalOrderDate: '2024-01-01', orderRank: 1 });
    const b = form({ portalOrderDate: '2024-01-01', orderRank: null });
    const def = computeDefaultForm('1', [o, older, a, b], DAY);
    expect(def.defaultFormId).toBe(older.formId);
    expect(def.newerNotAvailable).toBe(2);
  });

  it('orders ranked same-date consolidations by rank', () => {
    const a = form({ portalOrderDate: '2024-01-01', orderRank: 1 });
    const b = form({ portalOrderDate: '2024-01-01', orderRank: 2 });
    expect(computeDefaultForm('1', [original(), a, b], DAY).defaultFormId).toBe(b.formId);
  });

  it('ignores ended forms and undated consolidations, and an ended act has no default', () => {
    const o = original();
    const ended = form({ portalOrderDate: '2025-01-01', ended: true });
    const undated = form({ portalOrderDate: null });
    const def = computeDefaultForm('1', [o, ended, undated], DAY);
    expect(def.defaultFormId).toBe(o.formId);
    expect(def.newerNotAvailable).toBe(0);
    expect(computeDefaultForm('1', [o], DAY, true).defaultFormId).toBeNull();
  });

  it('has no default when no form is readable', () => {
    const def = computeDefaultForm('1', [original({ readable: false })], DAY);
    expect(def.defaultFormId).toBeNull();
    expect(def.basis).toBeNull();
  });

  it('never makes a republication the default; it only counts the newer ones (owner question 6)', () => {
    const o = original({ portalOrderDate: '2001-01-01' });
    const rep = form({ formKind: 'republication', portalOrderDate: '2015-08-28' });
    const def = computeDefaultForm('1', [o, rep], DAY);
    expect(def.defaultFormId).toBe(o.formId);
    expect(def.newerRepublications).toBe(1);
    const cons = form({ portalOrderDate: '2020-01-01' });
    expect(computeDefaultForm('1', [o, rep, cons], DAY).newerRepublications).toBe(0);
  });
});
