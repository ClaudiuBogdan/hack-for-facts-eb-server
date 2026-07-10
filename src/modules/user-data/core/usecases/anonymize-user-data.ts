import { type Result } from 'neverthrow';

import { type UserDataError } from '../errors.js';
import { type UserDataErasurePort } from '../ports.js';
import { type CategoryRegistry } from '../registry/registry.js';
import { type ResolvedRedactors } from '../types.js';
import { type LoggerPort } from './shared.js';

export interface AnonymizeUserDataDeps {
  erasurePort: UserDataErasurePort;
  registry: CategoryRegistry;
  logger: LoggerPort;
}

export interface AnonymizeUserDataInput {
  ownerId: string;
  anonymizedOwnerId: string;
  now: Date;
}

export const anonymizeUserData = (
  deps: AnonymizeUserDataDeps,
  input: AnonymizeUserDataInput
): Promise<Result<{ records: number; events: number; receipts: number }, UserDataError>> => {
  const payloadByCategory: Record<
    string,
    (payload: Record<string, unknown>) => Record<string, unknown>
  > = {};
  const annotationsByCategory: Record<
    string,
    Record<string, (annotation: Record<string, unknown>) => Record<string, unknown>>
  > = {};
  for (const definition of deps.registry.list()) {
    payloadByCategory[definition.category] = definition.redactor;
    annotationsByCategory[definition.category] = Object.fromEntries(
      definition.annotationNamespaces.map((namespace) => [namespace.namespace, namespace.redactor])
    );
  }
  const redactors: ResolvedRedactors = { payloadByCategory, annotationsByCategory };
  return deps.erasurePort.eraseOwner({ ...input, redactors });
};
