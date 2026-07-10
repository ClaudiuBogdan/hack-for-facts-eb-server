import { err, ok, type Result } from 'neverthrow';

import { createValidationError, type ValidationError } from '../shared/errors.js';

import type { KindDefinition } from './kind-definition.js';

export interface KindRegistry {
  getByKindId(kindId: string): KindDefinition | undefined;
  getByEventType(eventType: string): KindDefinition | undefined;
  list(): readonly KindDefinition[];
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isValidTemplateRef = (template: unknown): boolean => {
  if (template === null || typeof template !== 'object') {
    return false;
  }
  const candidate = template as { templateId?: unknown; version?: unknown };
  return isNonEmptyString(candidate.templateId) && isNonEmptyString(candidate.version);
};

const validateKind = (kind: KindDefinition): ValidationError | null => {
  if (!isNonEmptyString(kind.kindId)) {
    return createValidationError('Kind has an empty kindId', 'kindId');
  }
  if (!isNonEmptyString(kind.eventType)) {
    return createValidationError(`Kind ${kind.kindId} has an empty eventType`, 'eventType');
  }
  if (!Number.isInteger(kind.kindVersion) || kind.kindVersion < 1) {
    return createValidationError(`Kind ${kind.kindId} has an invalid kindVersion`, 'kindVersion');
  }
  if (!Number.isInteger(kind.eventSchemaVersion) || kind.eventSchemaVersion < 1) {
    return createValidationError(
      `Kind ${kind.kindId} has an invalid eventSchemaVersion`,
      'eventSchemaVersion'
    );
  }
  if (kind.deliveryExpiryHours !== null && kind.deliveryExpiryHours <= 0) {
    return createValidationError(
      `Kind ${kind.kindId} has a non-positive deliveryExpiryHours`,
      'deliveryExpiryHours'
    );
  }

  if (kind.supportedChannels.length === 0) {
    return createValidationError(`Kind ${kind.kindId} supports no channels`, 'supportedChannels');
  }
  if (new Set(kind.supportedChannels).size !== kind.supportedChannels.length) {
    return createValidationError(
      `Kind ${kind.kindId} declares duplicate supported channels`,
      'supportedChannels'
    );
  }

  const cadence = (
    kind as {
      cadence?: {
        allowed?: readonly string[];
        defaultByChannel?: Partial<Record<'inbox' | 'email', string>>;
      };
    }
  ).cadence;
  if (cadence?.allowed === undefined || cadence.defaultByChannel === undefined) {
    return createValidationError(`Kind ${kind.kindId} has no cadence policy`, 'cadence');
  }
  if (cadence.allowed.length === 0) {
    return createValidationError(`Kind ${kind.kindId} allows no cadences`, 'cadence.allowed');
  }

  for (const channel of kind.supportedChannels) {
    const defaultCadence = cadence.defaultByChannel[channel];
    if (defaultCadence === undefined) {
      return createValidationError(
        `Kind ${kind.kindId} has no default cadence for channel ${channel}`,
        `cadence.defaultByChannel.${channel}`
      );
    }
    if (!cadence.allowed.includes(defaultCadence)) {
      return createValidationError(
        `Kind ${kind.kindId} has a default cadence not present in its allowed cadences`,
        `cadence.defaultByChannel.${channel}`
      );
    }

    const templates = (kind as { templates?: Partial<Record<'inbox' | 'email', unknown>> })
      .templates;
    if (!isValidTemplateRef(templates?.[channel])) {
      return createValidationError(
        `Kind ${kind.kindId} has no template for channel ${channel}`,
        `templates.${channel}`
      );
    }
  }

  const ordering = (
    kind as {
      ordering?: { streamKey?: unknown; streamSequence?: unknown } | null;
    }
  ).ordering;
  if (
    ordering !== null &&
    (ordering === undefined ||
      typeof ordering.streamKey !== 'function' ||
      typeof ordering.streamSequence !== 'function')
  ) {
    return createValidationError(
      `Kind ${kind.kindId} ordering requires streamKey and streamSequence`,
      'ordering'
    );
  }

  return null;
};

export const makeKindRegistry = (
  kinds: readonly KindDefinition[]
): Result<KindRegistry, ValidationError> => {
  const byKindId = new Map<string, KindDefinition>();
  const byEventType = new Map<string, KindDefinition>();

  for (const kind of kinds) {
    if (byKindId.has(kind.kindId)) {
      return err(createValidationError(`Duplicate notification kindId: ${kind.kindId}`, 'kindId'));
    }
    if (byEventType.has(kind.eventType)) {
      return err(
        createValidationError(`Duplicate notification eventType: ${kind.eventType}`, 'eventType')
      );
    }

    const validationError = validateKind(kind);
    if (validationError !== null) {
      return err(validationError);
    }

    byKindId.set(kind.kindId, kind);
    byEventType.set(kind.eventType, kind);
  }

  const registeredKinds = [...kinds];
  return ok({
    getByKindId: (kindId) => byKindId.get(kindId),
    getByEventType: (eventType) => byEventType.get(eventType),
    list: () => registeredKinds,
  });
};
