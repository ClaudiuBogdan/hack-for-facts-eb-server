/**
 * Source-reported amounts and source catalogue recency (R8): each grain reads
 * only its own stage's catalogue receipt; the notes say catalogue recency, not
 * loaded coverage; a missing receipt is unknown; the amount note is true for
 * any build.
 */

import { describe, expect, it } from 'vitest';

import { analysisStats } from '@/modules/procurement/core/analysis-usecases.js';
import {
  SOURCE_REPORTED_NOTE,
  sourceNotes,
  type SourceCaptureReceipts,
  type SourceCaptureSummary,
} from '@/modules/procurement/core/source-capture.js';

import { fakeAnalysisRepo, generation } from './analysis-fakes.js';

const DA_RECEIPT: SourceCaptureSummary = {
  seap: {
    direct_acquisition: { latestYear: 2025 },
    direct_award_notification: { latestYear: 2026 },
    contract: { latestYear: 2024 },
  },
  elicitatie: {
    elicitatie_direct_acquisition_page: {
      status: 'recency_only',
      latestSucceededWindowEnd: '2026-06-30',
      latestCompletedAt: '2026-07-02 10:00:00+00',
      unfinishedWindowsBefore: 3209,
    },
    elicitatie_ca_notice_list: { status: 'unknown' },
  },
};

const RECEIPTS: SourceCaptureReceipts = {
  'procurement.direct_acquisitions': DA_RECEIPT,
  'procurement.contracts': DA_RECEIPT,
};

const PREFIX = 'source catalogue, not loaded coverage';

describe('sourceNotes', () => {
  it('states catalogue recency for the grain’s own families and listing, never coverage', () => {
    expect(sourceNotes('direct_acquisition', RECEIPTS)).toEqual([
      SOURCE_REPORTED_NOTE,
      `${PREFIX}: latest completed e-licitatie direct acquisitions listing window ends 2026-06-30; 3209 earlier windows unfinished`,
      `${PREFIX}: SEAP direct acquisition export files listed up to year 2026`,
    ]);
    // The contract grain reads the contract family only (2024), not the
    // catalogue-wide latest year, and its route has no completed listing.
    expect(sourceNotes('contract', RECEIPTS)).toEqual([
      SOURCE_REPORTED_NOTE,
      `${PREFIX}: e-licitatie award notices listing unknown`,
      `${PREFIX}: SEAP contract export files listed up to year 2024`,
    ]);
  });

  it('says unknown without the grain’s own stage receipt', () => {
    const unknown = `${PREFIX}: unknown for this build`;
    // Procedures have no receipt here: another stage's receipt is not used.
    expect(sourceNotes('procedure', RECEIPTS)).toEqual([SOURCE_REPORTED_NOTE, unknown]);
    expect(sourceNotes('direct_acquisition', null)).toEqual([SOURCE_REPORTED_NOTE, unknown]);
    // Counts-only grain without a receipting stage: no amount note.
    expect(sourceNotes('modification', RECEIPTS)).toEqual([unknown]);
    expect(sourceNotes('direct_acquisition', undefined)).toEqual([]);
  });

  it('makes no claim about how amounts were judged', () => {
    expect(SOURCE_REPORTED_NOTE).not.toMatch(/capped|kept|corrected/);
  });

  it('reaches the answer envelope caveats', async () => {
    const { repo } = fakeAnalysisRepo({
      generation: { ...generation(), sourceCapture: RECEIPTS },
    });
    const result = await analysisStats(
      { analysisRepo: repo },
      { scope: { grain: 'direct_acquisition' } }
    );
    const [block] = result._unsafeUnwrap().blocks;
    expect(block?.meta.caveats).toEqual(
      expect.arrayContaining([...sourceNotes('direct_acquisition', RECEIPTS)])
    );
  });
});
