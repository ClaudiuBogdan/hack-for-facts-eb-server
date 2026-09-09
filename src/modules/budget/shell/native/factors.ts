/**
 * The native (kernel build) money factors: factor set 2, promoted only (moved from
 * `src/app`, X/F6). The reader comes from the composition root through the
 * budget module's own port (review B/F20): build it with `requirePromotion: true`
 * — the promotion requirement is part of the native admission semantics.
 */
import { makeFactorSetSource } from '../factors/factor-set-source.js';

import type { FactorSetReaderPort } from '../../core/legacy-analytics/factor-set-port.js';
import type { FactorSource } from '../../core/legacy-analytics/ports.js';

// Immutable authorities snapshot; admission requires a recorded promotion.
// See scrapper prod-db/evidence/factor-cpi-witness-2026-09-08/acceptance.md.
export const NATIVE_FACTOR_SET_ID = '2';
export const NATIVE_FACTOR_SET_DIGEST =
  '5f2948ec1c350530b43d38b76dbad34bdf3251c9d451d255a41ca015067c3195';

export const makeNativeBudgetFactors = (
  promotedReader: Pick<FactorSetReaderPort, 'load'>
): FactorSource =>
  makeFactorSetSource(promotedReader, NATIVE_FACTOR_SET_ID, NATIVE_FACTOR_SET_DIGEST);
