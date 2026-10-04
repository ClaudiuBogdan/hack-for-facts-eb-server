/**
 * Registry scope fixtures for the companies tests (no I/O). A published scope
 * pins edition 7 at publication epoch 3 and access epoch 11.
 */

import {
  REGISTRY_STATE_REASON,
  unavailableRegistry,
  type CompanyRegistryEnvelope,
  type CompanyRegistryRecheck,
} from '@/modules/companies/core/registry.js';

export const PUBLISHED_SCOPE: CompanyRegistryEnvelope = {
  source: 'onrc',
  state: 'published',
  editionId: '7',
  sourceSnapshotId: 'onrc:2026-07-08',
  sourcePublishedAt: '2026-07-08',
  interpretationVersion: 'onrc-interpretation-v1',
  dimensionPolicyVersion: 'onrc-dimension-v1',
  eligibilityPolicyVersion: 'public-legal-person-v1',
  publicationEpoch: '3',
  accessEpoch: '11',
  reason: null,
};

/** The same edition after a later publication event (e.g. a rollback away and back). */
export const MOVED_SCOPE: CompanyRegistryEnvelope = { ...PUBLISHED_SCOPE, publicationEpoch: '4' };

/** A different edition published. */
export const NEXT_EDITION_SCOPE: CompanyRegistryEnvelope = {
  ...PUBLISHED_SCOPE,
  editionId: '8',
  sourceSnapshotId: 'onrc:2026-08-05',
  sourcePublishedAt: '2026-08-05',
  publicationEpoch: '4',
  accessEpoch: '12',
};

const notPublished = (
  state: 'unpublished' | 'withdrawn',
  publicationEpoch: string
): CompanyRegistryEnvelope => ({
  source: 'onrc',
  state,
  editionId: null,
  sourceSnapshotId: null,
  sourcePublishedAt: null,
  interpretationVersion: null,
  dimensionPolicyVersion: null,
  eligibilityPolicyVersion: null,
  publicationEpoch,
  accessEpoch: '11',
  reason: REGISTRY_STATE_REASON[state],
});

export const UNPUBLISHED_SCOPE = notPublished('unpublished', '0');
export const WITHDRAWN_SCOPE = notPublished('withdrawn', '4');
export const UNAVAILABLE_SCOPE: CompanyRegistryEnvelope = unavailableRegistry();

/** A fresh recheck reading `current` (default: the scope itself, i.e. it holds). */
export const recheckOf = (
  current: CompanyRegistryEnvelope | null,
  privateCuis: readonly string[] = []
): CompanyRegistryRecheck => ({
  current:
    current === null
      ? null
      : {
          state: current.state,
          editionId: current.editionId,
          publicationEpoch: current.publicationEpoch,
          accessEpoch: current.accessEpoch,
        },
  privateCuis,
});
