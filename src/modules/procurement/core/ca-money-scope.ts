/**
 * The scope fields the money-build contract grain (PROC-KB0Z) does not answer yet. Its own
 * module so routing (`combinations.ts`) can refuse them without importing the source's core.
 */

import type { AnalysisScope } from './analysis-scope.js';

/** Scope fields this source does not answer yet: refused, never answered without them. */
const UNSERVED: readonly (readonly [keyof AnalysisScope, string])[] = [
  ['supplierRegion', 'supplier geography'],
  ['supplierCounty', 'supplier geography'],
  ['supplierSiruta', 'supplier geography'],
  ['buyerRegion', 'buyer region'],
  ['buyerCounty', 'buyer county'],
  ['buyerSiruta', 'buyer SIRUTA'],
  ['status', 'status'],
  ['procedureType', 'procedure type'],
  ['q', 'title search'],
  ['valueMin', 'value bounds'],
  ['valueMax', 'value bounds'],
];

/** Why the money-build contract grain cannot answer this scope, or undefined. */
export const caMoneyExclusion = (scope: AnalysisScope): string | undefined => {
  const field = UNSERVED.find(([key]) => scope[key] !== undefined);
  return field === undefined
    ? undefined
    : `${field[1]} is not available for contract awards from the money build yet`;
};

/**
 * The shapes the money-build contract grain answers (stats and the anchor series); the others
 * abstain in the usecases, so routing never refuses them on this source's account.
 */
export const caMoneyServes = (shape: string, measure: string | undefined): boolean =>
  shape === 'stats' ||
  (shape === 'series' && measure !== 'distinctSuppliers' && measure !== 'distinctAuthorities');
