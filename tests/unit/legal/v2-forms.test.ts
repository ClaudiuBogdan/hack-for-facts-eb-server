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

let nextId = 100;
const form = (over: Partial<V2FormState>): V2FormState => ({
  formId: String((nextId += 1)),
  actId: '1',
  formKind: 'consolidation',
  formKey: `k${String(nextId)}`,
  portalOrderDate: '2020-01-01',
  orderRank: null,
  accepted: true,
  bodyResolved: true,
  ended: false,
  readable: true,
  held: false,
  portalListPosition: null,
  maxPageId: null,
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

describe('default form: latest_any_kind (owner decision 2026-11-12, p2a_default_form)', () => {
  it('makes a republication newer than the latest consolidation the default', () => {
    const cons = form({ portalOrderDate: '2014-01-01', portalListPosition: 1 });
    const rep = form({
      formKind: 'republication',
      portalOrderDate: '2015-08-28',
      portalListPosition: 2,
    });
    const def = computeDefaultForm('1', [original(), cons, rep], null);
    expect(def).toMatchObject({
      posture: 'current',
      defaultFormId: rep.formId,
      positionDate: '2015-08-28',
      orderReviewed: true,
      newerNotAvailable: 0,
    });
  });

  it('never chooses a newer form without text: it is counted and the latest available is named', () => {
    const shown = form({ portalOrderDate: '2021-01-01', portalListPosition: 1 });
    const noText = form({ portalOrderDate: '2023-01-01', readable: false, portalListPosition: 2 });
    const def = computeDefaultForm('1', [original(), shown, noText], null);
    expect(def).toMatchObject({
      posture: 'latest_not_available',
      defaultFormId: null,
      chosenFormId: noText.formId,
      latestAvailableFormId: shown.formId,
      newerNotAvailable: 1,
    });
  });

  it('leaves same-date unranked forms unreviewed, picking by the fixed rule', () => {
    const a = form({ portalOrderDate: '2024-01-01', portalListPosition: 3 });
    const b = form({ portalOrderDate: '2024-01-01', portalListPosition: 5 });
    const byList = computeDefaultForm('1', [original(), a, b], null);
    expect(byList).toMatchObject({
      defaultFormId: b.formId,
      orderReviewed: false,
      tieBasis: 'portal_list_position',
      formsAtPosition: 2,
    });
    // the original (unlisted) and a listed form on one date: the listed one
    const o = original({ portalOrderDate: '2024-01-01' });
    const listed = form({ portalOrderDate: '2024-01-01', portalListPosition: 1 });
    expect(computeDefaultForm('1', [o, listed], null)).toMatchObject({
      defaultFormId: listed.formId,
      tieBasis: 'listed_over_unlisted',
    });
    const p1 = form({ portalOrderDate: '2024-01-01', maxPageId: '90' });
    const p2 = form({ portalOrderDate: '2024-01-01', maxPageId: '100' });
    expect(computeDefaultForm('1', [p1, p2], null)).toMatchObject({
      defaultFormId: p2.formId,
      tieBasis: 'highest_page_id',
    });
    const k1 = form({ portalOrderDate: '2024-01-01', formKey: 'cons:a' });
    const k2 = form({ portalOrderDate: '2024-01-01', formKey: 'cons:b' });
    expect(computeDefaultForm('1', [k1, k2], null)).toMatchObject({
      defaultFormId: k2.formId,
      tieBasis: 'form_key',
    });
  });

  it('orders a reviewed same-date pair by rank, whatever their kinds', () => {
    const rep = form({ formKind: 'republication', portalOrderDate: '2024-01-01', orderRank: 2 });
    const cons = form({ portalOrderDate: '2024-01-01', orderRank: 1, portalListPosition: 9 });
    expect(computeDefaultForm('1', [rep, cons], null)).toMatchObject({
      defaultFormId: rep.formId,
      orderReviewed: true,
      tieBasis: null,
    });
  });

  it('reads future-dated forms by default, and a day reads the act as of that day', () => {
    const past = form({ portalOrderDate: '2021-01-01' });
    const future = form({ portalOrderDate: '2027-01-01' });
    expect(computeDefaultForm('1', [past, future], null).defaultFormId).toBe(future.formId);
    expect(computeDefaultForm('1', [past, future], '2026-11-20').defaultFormId).toBe(past.formId);
  });

  it('counts undated forms, ignores ended ones, and has no default without a dated form', () => {
    const undated = form({ portalOrderDate: null });
    const ended = form({ portalOrderDate: '2025-01-01', ended: true });
    expect(computeDefaultForm('1', [undated, ended], null)).toMatchObject({
      posture: 'no_known_form',
      defaultFormId: null,
      formsWithoutPosition: 1,
    });
  });

  it('keeps the literal policy selectable: the latest consolidation, else the original', () => {
    const o = original();
    const cons = form({ portalOrderDate: '2014-01-01' });
    const rep = form({ formKind: 'republication', portalOrderDate: '2015-08-28' });
    expect(
      computeDefaultForm('1', [o, cons, rep], null, 'latest_consolidation_or_original')
    ).toMatchObject({ defaultFormId: cons.formId, laterOtherKind: 1 });
    expect(
      computeDefaultForm('1', [o, rep], null, 'latest_consolidation_or_original')
    ).toMatchObject({ defaultFormId: o.formId, laterOtherKind: 1 });
  });
});
