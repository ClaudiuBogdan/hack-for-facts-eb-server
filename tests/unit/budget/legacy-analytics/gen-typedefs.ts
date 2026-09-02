/**
 * Maintenance helper (not a test): prints the byte-identical legacy SDL
 * definitions the kernel slice `budget/shell/graphql/legacy/typedefs.ts` must
 * carry — the same parser-`loc` extraction the identity test applies — as one
 * SDL document, in the order the slice declares them. Its output IS the pinned
 * fixture `fixtures/legacy-execution-analytics.graphql` (codex 2026-09-02
 * finding 6): regenerate it ONLY when a legacy definition changes before the
 * legacy modules are deleted, and review the diff:
 *
 *   pnpm exec tsx tests/unit/budget/legacy-analytics/gen-typedefs.ts \
 *     > tests/unit/budget/legacy-analytics/fixtures/legacy-execution-analytics.graphql
 *
 * After the legacy modules are deleted, delete this helper too; the fixture
 * stays as the frozen surface's evidence.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractDefinitions } from './extract-sdl.js';
import { CommonDirectives } from '../../../../src/infra/graphql/common/directives.js';
import { CommonEnums } from '../../../../src/infra/graphql/common/enums.js';
import { CommonScalars } from '../../../../src/infra/graphql/common/scalars.js';
import { BUDGET_LEGACY_SDL_PROVENANCE } from '../../../../src/modules/budget/shell/graphql/legacy/typedefs.js';
import { ExecutionAnalyticsSchema } from '../../../../src/modules/execution-analytics/shell/graphql/schema.js';

const LEGACY_SOURCES: Record<keyof typeof BUDGET_LEGACY_SDL_PROVENANCE, string> = {
  'src/infra/graphql/common/directives.ts': CommonDirectives,
  'src/infra/graphql/common/scalars.ts': CommonScalars,
  'src/infra/graphql/common/enums.ts': CommonEnums,
  'src/modules/execution-analytics/shell/graphql/schema.ts': ExecutionAnalyticsSchema,
};

/** The fixture document: every provenance definition, byte-identical, in order. */
export const renderLegacyFixture = (): string => {
  const parts: string[] = [];
  for (const [file, keys] of Object.entries(BUDGET_LEGACY_SDL_PROVENANCE)) {
    const defs = extractDefinitions(LEGACY_SOURCES[file as keyof typeof LEGACY_SOURCES]);
    for (const key of keys) {
      const text = defs.get(key);
      if (text === undefined) throw new Error(`legacy source ${file} lacks ${key}`);
      parts.push(`# ${key} <- ${file}\n${text}`);
    }
  }
  return `${parts.join('\n\n')}\n`;
};

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.stdout.write(renderLegacyFixture());
