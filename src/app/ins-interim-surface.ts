/**
 * S1-7 interim — the legacy INS module on the redesign surface.
 *
 * The legacy `/graphql` endpoint cannot retire while it is the only surface that
 * serves the INS roots the client sends (golden-master cutover run 1,
 * 2026-09-02: 23 of the 62 failing corpus documents are INS/statistics
 * documents). The Chronos-reading INS kernel module (program slice 3.2) does
 * not exist yet, so the user decided (scrapper
 * `prod-db/BUDGET_REDESIGN_TASK_OVERVIEW_2026-09-02.md` §0, decision S1-7) to
 * mount the EXISTING legacy INS module — its resolvers, its cache-wrapped repo,
 * still reading `INS_DATABASE_URL` — on `/api/v1/graphql` as well.
 *
 * This is an explicit, temporary waiver of "no legacy DB code on the kernel":
 * the `insDb` pool and `src/modules/ins` stay until slice 3.2 lands, and this
 * file is deleted with them. Nothing here is a kernel module: the slice does not
 * touch `ProdDatabase`, registers no contributor and exposes no MCP tool.
 *
 * The SDL is the legacy `InsSchema` plus what the kernel base declares under
 * the same names with a DIFFERENT contract (docs/server-redesign/13 §3):
 *  - `PageInfo`: the kernel type has only `hasNextPage`/`endCursor`; the legacy
 *    connections and the client documents read `totalCount`, `hasPreviousPage`
 *    (and the legacy SDL also declares `startCursor`, which the INS resolvers
 *    never populate — it is null on both endpoints, kept so a document that
 *    selects it still validates). Per design 13 §3 the slice EXTENDS the kernel
 *    `PageInfo` with those fields, nullable on the type (the INS resolvers
 *    populate `totalCount` and `hasPreviousPage`; kernel connections leave all
 *    three null). The type name is unchanged, so fragments on `PageInfo` and
 *    `__typename` answer exactly as on the legacy endpoint. When the budget
 *    legacy slice (design 13) needs the same extension, it moves there — the
 *    merge gate rejects two slices adding the same field, so this cannot be
 *    silently duplicated.
 *  - `Date` → `InsDate`, `DateTime` → `InsDateTime`: the legacy endpoint
 *    declares these scalars without an implementation, so a JS `Date` from the
 *    INS pool is serialized by `JSON.stringify` (`toJSON()` → ISO string). The
 *    kernel scalars pass strings through and REJECT objects. The interim
 *    scalars keep the legacy wire bytes. Both are output-only in the INS SDL
 *    (their input parsing is unreachable) and a scalar name is observable only
 *    through introspection — no client document introspects.
 * `JSON` is not rewritten (the kernel `JSON` is the same identity scalar) and
 * `PeriodDate` / `ReportPeriodInput` are defined on the kernel by the budget
 * module's legacy slice — the budget module must be in the mounted set.
 * `tests/unit/app/ins-interim-surface.test.ts` pins the SDL rules;
 * `tests/integration/ins-interim-dual-endpoint.test.ts` replays the INS corpus
 * documents against both endpoints with one fake repository.
 */

import { GraphQLScalarType, Kind, parse, print, visit, type DocumentNode } from 'graphql';

import { InsSchema } from '@/modules/ins/index.js';

import type { GraphqlSlice } from '@/modules/shared/index.js';
import type { IResolvers } from 'mercurius';

/** The slice name the kernel merge gate reports in a conflict message. */
export const INS_INTERIM_SLICE_SOURCE = 'ins-legacy-interim';

/** Legacy scalar name → interim scalar name. */
export const INS_INTERIM_SCALAR_RENAMES: Readonly<Record<string, string>> = {
  Date: 'InsDate',
  DateTime: 'InsDateTime',
};

/**
 * The legacy `PageInfo` fields the kernel `PageInfo` lacks
 * (src/infra/graphql/common/types.ts vs src/modules/shared/shell/graphql/typedefs.ts).
 */
export const INS_INTERIM_PAGE_INFO_EXTENSION = /* GraphQL */ `
  extend type PageInfo {
    "Total count of items matching the query (legacy INS connections; null on kernel connections)"
    totalCount: Int
    "Indicates if there are more pages before the current page (legacy INS connections; null on kernel connections)"
    hasPreviousPage: Boolean
    "Cursor of the first edge in the page (legacy INS connections; null on kernel connections)"
    startCursor: String
  }
`;

const TYPE_DEFINITION_KINDS: ReadonlySet<string> = new Set([
  Kind.SCALAR_TYPE_DEFINITION,
  Kind.OBJECT_TYPE_DEFINITION,
  Kind.INTERFACE_TYPE_DEFINITION,
  Kind.UNION_TYPE_DEFINITION,
  Kind.ENUM_TYPE_DEFINITION,
  Kind.INPUT_OBJECT_TYPE_DEFINITION,
]);

/**
 * Rewrite the renamed scalars in TYPE positions only — type references
 * (`NamedType`) and type definitions — never a field, argument or enum value
 * that happens to share the name.
 */
const renameScalars = (doc: DocumentNode): DocumentNode =>
  visit(doc, {
    enter(node) {
      if (node.kind !== Kind.NAMED_TYPE && !TYPE_DEFINITION_KINDS.has(node.kind)) return undefined;
      const name = (node as { name: { value: string } }).name;
      const renamed = INS_INTERIM_SCALAR_RENAMES[name.value];
      return renamed === undefined ? undefined : { ...node, name: { ...name, value: renamed } };
    },
  });

/**
 * Legacy serialization for a scalar the legacy endpoint left unimplemented:
 * graphql-js identity, then the transport's `JSON.stringify` — which is what
 * `toJSON()` yields for a `Date`. Anything else passes through unchanged.
 */
const legacyIdentityScalar = (name: string, description: string): GraphQLScalarType =>
  new GraphQLScalarType({
    name,
    description,
    serialize: (value) => (value instanceof Date ? value.toJSON() : value),
    parseValue: (value) => value,
    parseLiteral: (ast) => (ast.kind === Kind.STRING || ast.kind === Kind.INT ? ast.value : null),
  });

export const InsDateScalar = legacyIdentityScalar(
  'InsDate',
  'Legacy INS `Date` (ISO 8601 date string; a JS Date serializes as its toJSON()).'
);
export const InsDateTimeScalar = legacyIdentityScalar(
  'InsDateTime',
  'Legacy INS `DateTime` (ISO 8601 datetime string; a JS Date serializes as its toJSON()).'
);

/**
 * The interim SDL: `InsSchema` with the scalar renames, the `PageInfo`
 * extension and the two scalar declarations. Computed on demand (not at
 * import) so a failure here surfaces inside the redesign mount's try/catch in
 * build-app.ts, never at legacy boot.
 */
export const makeInsInterimTypeDefs = (): string =>
  [
    print(renameScalars(parse(InsSchema))),
    INS_INTERIM_PAGE_INFO_EXTENSION.trim(),
    `scalar ${InsDateScalar.name}\nscalar ${InsDateTimeScalar.name}`,
  ].join('\n\n');

/** What `registerRedesignSurface` takes to mount the interim INS roots. */
export interface InsInterimSurface {
  readonly graphqlSlices: readonly GraphqlSlice[];
  readonly graphqlResolvers: Record<string, unknown>;
}

/**
 * Build the interim surface from the SAME resolver map the legacy `/graphql`
 * uses (cache-wrapped repo included), so both endpoints answer identically.
 */
export const makeInsInterimSurface = (insResolvers: IResolvers): InsInterimSurface => ({
  graphqlSlices: [{ source: INS_INTERIM_SLICE_SOURCE, typeDefs: makeInsInterimTypeDefs() }],
  graphqlResolvers: {
    ...insResolvers,
    [InsDateScalar.name]: InsDateScalar,
    [InsDateTimeScalar.name]: InsDateTimeScalar,
  },
});
