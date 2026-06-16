/**
 * Shared Kernel — search capability resolver (foundation §14.5, R4).
 *
 * Resolved once at boot. Engine reachability (meili/opensearch) is probed live;
 * per-domain semantic capability is policy-driven, NOT a single global boolean:
 *   - `legal`   → semantic LIVE (legal.document_embeddings / section_embeddings HNSW)
 *   - `judicial`→ policy-forced OFF even if pgvector lands (person-leak audit)
 *   - all others→ OFF (no vector column on search.documents yet)
 *
 * Semantic fields degrade (return null + caveat) when a domain's semantic=false;
 * they never error.
 */

import type {
  CapabilityResolver,
  DomainSearchCapabilities,
  MeiliClient,
  OpenSearchClient,
  SearchCapabilities,
} from '../../core/ports.js';

const SEMANTIC_LIVE = new Set(['legal']);
const SEMANTIC_FORCED_OFF: Record<string, string> = {
  judicial: 'policy: person-leak audit pending',
};

export const resolveCapabilities = async (clients: {
  meiliClient: MeiliClient;
  openSearchClient: OpenSearchClient;
}): Promise<CapabilityResolver> => {
  const [meiliHealth, osHealth] = await Promise.all([
    clients.meiliClient.healthCheck(),
    clients.openSearchClient.healthCheck(),
  ]);

  const engines: SearchCapabilities = {
    meili: meiliHealth.isOk(),
    opensearch: osHealth.isOk(),
  };

  return {
    engines,
    forDomain(domain: string): DomainSearchCapabilities {
      const forcedOff = SEMANTIC_FORCED_OFF[domain];
      if (forcedOff !== undefined) {
        return { semantic: false, reason: forcedOff };
      }
      if (SEMANTIC_LIVE.has(domain)) return { semantic: true };
      return { semantic: false, reason: 'no vector column on search.documents' };
    },
  };
};
