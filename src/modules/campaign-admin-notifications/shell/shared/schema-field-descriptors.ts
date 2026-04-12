import type { CampaignNotificationFieldDescriptor } from '../../core/types.js';
import type { TSchema } from '@sinclair/typebox';

const describeSchemaType = (schema: unknown): string => {
  if (typeof schema !== 'object' || schema === null) {
    return 'unknown';
  }

  const typeValue = (schema as { type?: unknown }).type;
  if (typeof typeValue === 'string') {
    return typeValue;
  }

  const constValue = (schema as { const?: unknown }).const;
  if (typeof constValue === 'string') {
    return `literal:${constValue}`;
  }

  const anyOfValue = (schema as { anyOf?: unknown }).anyOf;
  if (Array.isArray(anyOfValue)) {
    return anyOfValue.map((value) => describeSchemaType(value)).join('|');
  }

  return 'unknown';
};

export const listSchemaFields = (
  schema: TSchema,
  input?: { requiredOnly?: boolean }
): readonly CampaignNotificationFieldDescriptor[] => {
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  const requiredNames = new Set(
    Array.isArray((schema as unknown as { required?: unknown }).required)
      ? (schema as unknown as { required: unknown[] }).required.filter(
          (value): value is string => typeof value === 'string'
        )
      : []
  );

  if (properties === undefined) {
    return [];
  }

  return Object.entries(properties)
    .filter(([name]) => input?.requiredOnly !== true || requiredNames.has(name))
    .map(([name, propertySchema]) => ({
      name,
      type: describeSchemaType(propertySchema),
      required: requiredNames.has(name),
    }));
};
