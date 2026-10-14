/**
 * Companies GraphQL — the fields an operation selects under the field being
 * resolved, as GraphQL execution will collect them: every field node of the
 * response key (aliases and repeated selections merged by the executor),
 * named fragments and inline fragments followed, `@skip` / `@include`
 * evaluated against the operation's variables. Used to prepare the selected
 * lazy parts of one owning result inside its own pin.
 *
 * `selectedFieldNames` sees the DIRECT children; `selectedSubfieldNames`
 * one level deeper under every node of a named child field (aliases of the
 * child included), so `caenActivities { isMainCaen }` alone, or through any
 * fragment, alias or directive, prepares the part those flags need.
 */

import {
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  Kind,
  getDirectiveValues,
  type FieldNode,
  type GraphQLResolveInfo,
  type SelectionNode,
  type SelectionSetNode,
} from 'graphql';

/** The field nodes a selection set collects (fragments followed, directives evaluated). */
const collectFields = (
  info: GraphQLResolveInfo,
  sets: readonly (SelectionSetNode | undefined)[]
): FieldNode[] => {
  const included = (node: SelectionNode): boolean => {
    if (getDirectiveValues(GraphQLSkipDirective, node, info.variableValues)?.['if'] === true) {
      return false;
    }
    return getDirectiveValues(GraphQLIncludeDirective, node, info.variableValues)?.['if'] !== false;
  };
  const fields: FieldNode[] = [];
  const visited = new Set<string>();
  const walk = (set: SelectionSetNode | undefined): void => {
    for (const selection of set?.selections ?? []) {
      if (!included(selection)) continue;
      if (selection.kind === Kind.FIELD) {
        fields.push(selection);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        walk(selection.selectionSet);
      } else if (!visited.has(selection.name.value)) {
        visited.add(selection.name.value);
        walk(info.fragments[selection.name.value]?.selectionSet);
      }
    }
  };
  for (const set of sets) walk(set);
  return fields;
};

export const selectedFieldNames = (info: GraphQLResolveInfo | undefined): ReadonlySet<string> => {
  if (info === undefined) return new Set();
  return new Set(
    collectFields(
      info,
      info.fieldNodes.map((node) => node.selectionSet)
    ).map((field) => field.name.value)
  );
};

/**
 * The field names selected under every node of the direct child `child`
 * (whatever its alias), with the same collection rules.
 */
export const selectedSubfieldNames = (
  info: GraphQLResolveInfo | undefined,
  child: string
): ReadonlySet<string> => {
  if (info === undefined) return new Set();
  const childNodes = collectFields(
    info,
    info.fieldNodes.map((node) => node.selectionSet)
  ).filter((field) => field.name.value === child);
  return new Set(
    collectFields(
      info,
      childNodes.map((node) => node.selectionSet)
    ).map((field) => field.name.value)
  );
};
