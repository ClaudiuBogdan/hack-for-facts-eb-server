/**
 * Companies GraphQL — the fields an operation selects directly under the field
 * being resolved, as GraphQL execution will collect them: every field node of
 * the response key (aliases and repeated selections merged by the executor),
 * named fragments and inline fragments followed, `@skip` / `@include`
 * evaluated against the operation's variables. Used to prepare the selected
 * lazy parts of one owning result inside its own pin.
 */

import {
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  Kind,
  getDirectiveValues,
  type GraphQLResolveInfo,
  type SelectionNode,
  type SelectionSetNode,
} from 'graphql';

export const selectedFieldNames = (info: GraphQLResolveInfo | undefined): ReadonlySet<string> => {
  const names = new Set<string>();
  if (info === undefined) return names;
  const included = (node: SelectionNode): boolean => {
    if (getDirectiveValues(GraphQLSkipDirective, node, info.variableValues)?.['if'] === true) {
      return false;
    }
    return getDirectiveValues(GraphQLIncludeDirective, node, info.variableValues)?.['if'] !== false;
  };
  const visited = new Set<string>();
  const walk = (set: SelectionSetNode | undefined): void => {
    for (const selection of set?.selections ?? []) {
      if (!included(selection)) continue;
      if (selection.kind === Kind.FIELD) {
        names.add(selection.name.value);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        walk(selection.selectionSet);
      } else if (!visited.has(selection.name.value)) {
        visited.add(selection.name.value);
        walk(info.fragments[selection.name.value]?.selectionSet);
      }
    }
  };
  for (const node of info.fieldNodes) walk(node.selectionSet);
  return names;
};
