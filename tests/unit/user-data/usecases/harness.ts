import { makeCategoryRegistry } from '@/modules/user-data/core/registry/registry.js';
import {
  type AnnotateCommand,
  type DeleteCommand,
  type MigrateCommand,
  type ReplaceCommand,
  type RestoreCommand,
} from '@/modules/user-data/core/types.js';

import {
  makeFakeMutationRateLimiter,
  makeFakeUserDataStore,
} from '../../../fixtures/user-data/index.js';
import { expectOk, makeSequentialIds, makeTestClock } from '../../../support/index.js';
import { identity, makeDefinition, receipt } from '../fixtures.js';

export const logger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

export const makeUsecaseHarness = () => {
  const clock = makeTestClock(new Date('2026-01-01T00:00:00.000Z'));
  const ids = makeSequentialIds('usecase');
  const store = makeFakeUserDataStore({ clock, ids });
  const rateLimiter = makeFakeMutationRateLimiter();
  const registry = expectOk(makeCategoryRegistry([makeDefinition()]));
  return {
    clock,
    ids,
    store,
    rateLimiter,
    registry,
    deps: { mutationPort: store, rateLimiter, registry, ids, logger },
  };
};

export const replaceCommand = (overrides: Partial<ReplaceCommand> = {}): ReplaceCommand => ({
  identity,
  expectedRevision: 0,
  schemaVersion: 1,
  payload: { value: 'one' },
  target: null,
  clientOccurredAt: null,
  receipt,
  ...overrides,
});
export const annotateCommand = (overrides: Partial<AnnotateCommand> = {}): AnnotateCommand => ({
  identity,
  expectedRevision: 1,
  namespace: 'review',
  annotation: { status: 'approved' },
  clientOccurredAt: null,
  receipt: {
    ...receipt,
    requesterId: 'system',
    idempotencyKeyHash: 'annotation',
    canonicalRequestHash: 'annotation',
  },
  ...overrides,
});
export const deleteCommand = (overrides: Partial<DeleteCommand> = {}): DeleteCommand => ({
  identity,
  expectedRevision: 1,
  clientOccurredAt: null,
  receipt: { ...receipt, idempotencyKeyHash: 'delete', canonicalRequestHash: 'delete' },
  ...overrides,
});
export const restoreCommand = (overrides: Partial<RestoreCommand> = {}): RestoreCommand => ({
  identity,
  expectedRevision: 2,
  schemaVersion: 1,
  payload: { value: 'restored' },
  target: null,
  clientOccurredAt: null,
  receipt: { ...receipt, idempotencyKeyHash: 'restore', canonicalRequestHash: 'restore' },
  ...overrides,
});
export const migrateCommand = (overrides: Partial<MigrateCommand> = {}): MigrateCommand => ({
  identity,
  expectedRevision: 1,
  schemaVersion: 1,
  payload: { value: 'migrated' },
  clientOccurredAt: null,
  receipt: {
    ...receipt,
    requesterId: 'system',
    idempotencyKeyHash: 'migrate',
    canonicalRequestHash: 'migrate',
  },
  ...overrides,
});
