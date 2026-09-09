/** The native (kernel build) money factors: factor set 2, promoted only (moved from `src/app`, X/F6). */
import { makeFactorSetReader } from '@/modules/normalization/index.js';

import { makeFactorSetSource } from '../factors/factor-set-source.js';

import type { FactorSource } from '../../core/legacy-analytics/ports.js';
import type { ProdDatabase } from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

// Immutable authorities snapshot; admission requires a recorded promotion.
// See scrapper prod-db/evidence/factor-cpi-witness-2026-09-08/acceptance.md.
export const NATIVE_FACTOR_SET_ID = '2';
export const NATIVE_FACTOR_SET_DIGEST =
  '5f2948ec1c350530b43d38b76dbad34bdf3251c9d451d255a41ca015067c3195';

export const makeNativeBudgetFactors = (db: Kysely<ProdDatabase>): FactorSource =>
  makeFactorSetSource(
    makeFactorSetReader(db, { requirePromotion: true }),
    NATIVE_FACTOR_SET_ID,
    NATIVE_FACTOR_SET_DIGEST
  );
