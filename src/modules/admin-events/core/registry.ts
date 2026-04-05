import { err, ok, type Result } from 'neverthrow';

import { createValidationError, type AdminEventError } from './errors.js';

import type { AnyAdminEventDefinition, AdminEventType } from './types.js';

export interface AdminEventRegistry {
  get(eventType: AdminEventType): Result<AnyAdminEventDefinition, AdminEventError>;
  list(): readonly AnyAdminEventDefinition[];
}

export const makeAdminEventRegistry = (
  definitions: readonly AnyAdminEventDefinition[]
): AdminEventRegistry => {
  const definitionMap = new Map<AdminEventType, AnyAdminEventDefinition>();

  for (const definition of definitions) {
    definitionMap.set(definition.eventType, definition);
  }

  return {
    get(eventType) {
      const definition = definitionMap.get(eventType);
      if (definition === undefined) {
        return err(createValidationError(`Unknown admin event type "${eventType}".`));
      }

      return ok(definition);
    },
    list() {
      return [...definitionMap.values()];
    },
  };
};
