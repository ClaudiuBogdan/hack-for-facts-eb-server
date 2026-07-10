/**
 * Judicial module — public API (plan 08 §11). **PRIVACY-CRITICAL.** Surface =
 * GraphQL + MCP only (no REST). Owns the `justice.*` tables.
 *
 * `makeJudicialModule(deps)` wires repos → usecases → GraphQL slice + MCP tools +
 * the `judicial` contributor. `build-redesign-app.ts` merges the slice, registers
 * the tools + contributor.
 *
 * Importing this barrel pulls in `shell/db/schema.ts`, whose `declare module`
 * augments `ProdDatabase` with the `justice.*` tables (with the structural
 * privacy omissions — case_hearings has no solution/solution_summary slot).
 *
 * CROSS-MODULE: `JudicialLegalRef.targetAct` resolves `target_act_id → LegalAct`
 * through the kernel `legalActLoader()` (registered by the legal module 05). The
 * module never imports the legal module; it reads the loader lazily at resolve
 * time and tolerates `undefined` (legal not wired) + dangling ids → null.
 */

import './shell/db/schema.js';

import { makeJudicialContributor } from './shell/contributor.js';
import { makeJudicialResolvers } from './shell/graphql/resolvers.js';
import { judicialTypeDefs } from './shell/graphql/typedefs.js';
import { makeJudicialMcpTools } from './shell/mcp/tools.js';
import { makeJudicialCaseRepo } from './shell/repo/cases-repo.js';
import {
  makeJudicialAppealRepo,
  makeJudicialHearingRepo,
  makeJudicialPartyRepo,
} from './shell/repo/children-repo.js';
import { makeJudicialCompanyLinkRepo } from './shell/repo/company-link-repo.js';
import { makeJudicialCourtRepo } from './shell/repo/courts-repo.js';
import { makeJudicialLegalRefRepo } from './shell/repo/legal-ref-repo.js';
import { makeJudicialLineageRepo } from './shell/repo/lineage-repo.js';
import { makeJudicialPartyDictionaryRepo } from './shell/repo/party-dictionary-repo.js';

import type { JudicialRepos } from './core/usecases.js';
import type {
  ContributorRegistry,
  GraphqlSlice,
  KernelMcpTool,
  LegalActByIdLoader,
  ProdDatabase,
  SourceContributor,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface JudicialModuleDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly registry: ContributorRegistry;
  /**
   * Lazily resolves the kernel cross-module legal-act loader (registered by the
   * legal module 05). Read at GraphQL resolve time so registration order is
   * data-independent; tolerates `undefined` → targetAct null.
   */
  readonly legalActLoader: () => LegalActByIdLoader | undefined;
  readonly clientBaseUrl?: string;
}

export interface JudicialModule {
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  readonly contributor: SourceContributor;
  readonly repos: JudicialRepos;
}

export const makeJudicialModule = (deps: JudicialModuleDeps): JudicialModule => {
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';

  // 1. repos. The party dictionary is the GATED name surface; the company-link
  //    repo composes its publishable name through it (never candidate_company_name).
  const dictionary = makeJudicialPartyDictionaryRepo(deps.db);
  const repos: JudicialRepos = {
    courts: makeJudicialCourtRepo(deps.db),
    cases: makeJudicialCaseRepo(deps.db),
    hearings: makeJudicialHearingRepo(deps.db),
    appeals: makeJudicialAppealRepo(deps.db),
    parties: makeJudicialPartyRepo(deps.db),
    dictionary,
    companyLinks: makeJudicialCompanyLinkRepo(deps.db, dictionary),
    legalRefs: makeJudicialLegalRefRepo(deps.db),
    lineage: makeJudicialLineageRepo(deps.db),
  };

  // 2. GraphQL + MCP (call the SAME usecases — tri-surface equivalence).
  const graphqlResolvers = makeJudicialResolvers({ repos, legalActLoader: deps.legalActLoader });
  const mcpTools = makeJudicialMcpTools({ repos, clientBaseUrl });

  // 3. the privacy-safe contributor (company-litigation only; empty v1).
  const contributor = makeJudicialContributor(repos);

  return {
    graphqlSlice: { source: 'judicial', typeDefs: judicialTypeDefs },
    graphqlResolvers,
    mcpTools,
    contributor,
    repos,
  };
};

export * from './core/types.js';
export {
  JUDICIAL_FILTER_SPECS,
  judicialCasesSpec,
  judicialCourtsSpec,
} from './shell/filters/judicial.spec.js';
export { PUBLISHABLE_RULES, CLASSIFIER_VERSION } from './shell/repo/constants.js';
