import { describe, expect, it } from 'vitest';

import { assertedBillKeyForVote } from '../../../src/modules/parliament/core/vote-resolution.js';

/**
 * The read-path enforcement of the W1.3 contract. Each case below is a real
 * population measured on live prod 2026-08-08, not a hypothetical.
 */
describe('assertedBillKeyForVote', () => {
  it('asserts the resolved bill for resolved and adjudicated votes', () => {
    // 12,512 votes.
    expect(
      assertedBillKeyForVote({
        resolutionStatus: 'resolved',
        resolvedDisplayBillKey: '23458',
      })
    ).toBe('23458');
    expect(
      assertedBillKeyForVote({
        resolutionStatus: 'adjudicated',
        resolvedDisplayBillKey: '23457',
      })
    ).toBe('23457');
  });

  it('asserts NOTHING for unresolved votes — the resolver abstained', () => {
    // 8,341 votes (39.95%). "No evidence", not "no bill exists".
    expect(
      assertedBillKeyForVote({
        resolutionStatus: 'unresolved',
        resolvedDisplayBillKey: null,
      })
    ).toBeNull();
  });

  it('asserts NOTHING for conflict votes even though links exist', () => {
    // 18 votes, each spanning 2-3 DIFFERENT cases. Showing any one of them as
    // the bill is the exact false assertion this contract removes.
    expect(
      assertedBillKeyForVote({
        resolutionStatus: 'conflict',
        resolvedDisplayBillKey: null,
      })
    ).toBeNull();
  });

  it('asserts nothing while a vote is unstamped', () => {
    // The derive is all-or-nothing, so a blocked batch leaves whole cohorts
    // NULL — 5 votes were in exactly this state on 2026-08-07.
    expect(
      assertedBillKeyForVote({
        resolutionStatus: null,
        resolvedDisplayBillKey: null,
      })
    ).toBeNull();
  });

  /**
   * The regression guard. A "helpful" fallback to the legacy billKey would
   * restore the defect wholesale, so the rule must refuse even when a display
   * key is absent on an asserting status, and must never consult billKey — note
   * this input carries no billKey field at all, by design.
   */
  it('never invents a bill when an asserting status has no resolved key', () => {
    expect(
      assertedBillKeyForVote({
        resolutionStatus: 'resolved',
        resolvedDisplayBillKey: null,
      })
    ).toBeNull();
  });

  it('refuses an unknown future status rather than assuming it asserts', () => {
    // Fail closed: a status added to the derive but not to the read path must
    // not silently start asserting bills.
    expect(
      assertedBillKeyForVote({
        resolutionStatus: 'provisional_something_new',
        resolvedDisplayBillKey: '999',
      })
    ).toBeNull();
  });
});
