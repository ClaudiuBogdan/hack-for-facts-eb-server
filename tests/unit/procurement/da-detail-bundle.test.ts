/**
 * The direct-acquisition detail bundle: which of the four availability states a
 * given (source family, lookup outcome) pair produces, and what survives when
 * the optional half fails.
 *
 * Each case is a way the page could lie or die:
 *   - querying a family that has no detail feed at all (wasted work, and its
 *     failure modes leak into a record whose answer is already known);
 *   - reporting a permanent "the source publishes nothing" for a gap a backfill
 *     is still closing, or vice versa;
 *   - letting a failed optional lookup erase an acquisition that loaded fine.
 */

import { describe, expect, it } from 'vitest';

import {
  assembleDirectAcquisitionDetail,
  daDetailFeedExists,
} from '@/modules/procurement/shell/repo/da-detail-bundle.js';

import type {
  DaDetailBody,
  DuplicateRef,
  ProcurementDirectAcquisition,
} from '@/modules/procurement/core/types.js';

const DA_ID = '71690399';

const da = (sourceSystem: string): ProcurementDirectAcquisition =>
  ({
    daId: DA_ID,
    sourceSystem,
    valueRon: '1200.00',
    title: 'Furnizare hartie',
  }) as unknown as ProcurementDirectAcquisition;

const duplicates: readonly DuplicateRef[] = [{ sourceSystem: 'elicitatie_da', id: '999' }];

const body = { itemCount: 2, description: 'Hartie A4' } as unknown as DaDetailBody;

/** Records what the code logged, at which level — no mocking library. */
const recordingLogger = (): {
  calls: { level: 'warn' | 'error'; obj: Record<string, unknown>; msg: string }[];
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
} => {
  const calls: { level: 'warn' | 'error'; obj: Record<string, unknown>; msg: string }[] = [];
  return {
    calls,
    warn: (obj, msg) => {
      calls.push({ level: 'warn', obj, msg });
    },
    error: (obj, msg) => {
      calls.push({ level: 'error', obj, msg });
    },
  };
};

/** A loader that must never run; calling it fails the test loudly. */
const forbiddenLoader = (): Promise<DaDetailBody | null> => {
  throw new Error('procurement.da_details must not be queried for this source family');
};

describe('daDetailFeedExists', () => {
  it('is true only for the one family with a detail feed behind it', () => {
    expect(daDetailFeedExists('elicitatie_da')).toBe(true);
    expect(daDetailFeedExists('seap_da')).toBe(false);
    expect(daDetailFeedExists('seap_dan')).toBe(false);
  });
});

describe('a source family that can never have details is not queried at all', () => {
  it.each(['seap_da', 'seap_dan'])(
    '%s → not_available_for_source, with no detail lookup',
    async (sourceSystem) => {
      const bundle = await assembleDirectAcquisitionDetail({
        da: da(sourceSystem),
        duplicates,
        loadDetailBody: forbiddenLoader,
      });

      expect(bundle.detailAvailability).toBe('not_available_for_source');
      expect(bundle.detail).toBeNull();
      // The base answer is intact — that is the whole point of the short-circuit.
      expect(bundle.directAcquisition.daId).toBe(DA_ID);
      expect(bundle.duplicates).toEqual(duplicates);
    }
  );
});

describe('an e-licitatie record, whose family DOES have a feed', () => {
  it('no detail row → not_captured (the closable backfill gap, not a source limit)', async () => {
    const bundle = await assembleDirectAcquisitionDetail({
      da: da('elicitatie_da'),
      duplicates,
      loadDetailBody: () => Promise.resolve(null),
    });

    expect(bundle.detailAvailability).toBe('not_captured');
    expect(bundle.detail).toBeNull();
    expect(bundle.duplicates).toEqual(duplicates);
  });

  it('a detail row → available, serving the body', async () => {
    const bundle = await assembleDirectAcquisitionDetail({
      da: da('elicitatie_da'),
      duplicates,
      loadDetailBody: () => Promise.resolve(body),
    });

    expect(bundle.detailAvailability).toBe('available');
    expect(bundle.detail).toBe(body);
  });
});

describe('a failure isolated to the OPTIONAL detail lookup', () => {
  const failing = (): Promise<DaDetailBody | null> =>
    Promise.reject(new Error('canceling statement due to statement timeout'));

  it('keeps the valid base record and duplicates, and says the gap is transient', async () => {
    const logger = recordingLogger();
    const bundle = await assembleDirectAcquisitionDetail({
      da: da('elicitatie_da'),
      duplicates,
      loadDetailBody: failing,
      logger,
    });

    expect(bundle.detailAvailability).toBe('temporarily_unavailable');
    expect(bundle.detail).toBeNull();
    // The half that loaded is still served — a detail outage is not a dead page.
    expect(bundle.directAcquisition.daId).toBe(DA_ID);
    expect(bundle.duplicates).toEqual(duplicates);
  });

  it('never masquerades as a permanent source limitation or a capture gap', async () => {
    const bundle = await assembleDirectAcquisitionDetail({
      da: da('elicitatie_da'),
      duplicates,
      loadDetailBody: failing,
      logger: recordingLogger(),
    });

    // Both wrong answers here are user-visible lies: one claims the source
    // publishes no detail, the other that a backfill will eventually supply it.
    expect(bundle.detailAvailability).not.toBe('not_available_for_source');
    expect(bundle.detailAvailability).not.toBe('not_captured');
  });

  it('logs the underlying failure with the record it happened on', async () => {
    const logger = recordingLogger();
    await assembleDirectAcquisitionDetail({
      da: da('elicitatie_da'),
      duplicates,
      loadDetailBody: failing,
      logger,
    });

    expect(logger.calls).toHaveLength(1);
    const [call] = logger.calls;
    expect(call?.level).toBe('error');
    expect(call?.obj).toMatchObject({
      daId: DA_ID,
      sourceSystem: 'elicitatie_da',
      err: { message: 'canceling statement due to statement timeout' },
    });
    expect(call?.msg).toContain('temporarily_unavailable');
  });

  it('falls back to warn when the logger has no error level, and tolerates none', async () => {
    const warned: string[] = [];
    const warnOnly = await assembleDirectAcquisitionDetail({
      da: da('elicitatie_da'),
      duplicates,
      loadDetailBody: failing,
      logger: {
        warn: (_obj, msg) => {
          warned.push(msg);
        },
      },
    });
    expect(warnOnly.detailAvailability).toBe('temporarily_unavailable');
    expect(warned).toHaveLength(1);

    const noLogger = await assembleDirectAcquisitionDetail({
      da: da('elicitatie_da'),
      duplicates,
      loadDetailBody: failing,
    });
    expect(noLogger.detailAvailability).toBe('temporarily_unavailable');
  });
});
