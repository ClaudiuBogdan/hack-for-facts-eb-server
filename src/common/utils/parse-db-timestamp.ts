/**
 * Strict timestamp parser for database rows.
 *
 * Repositories should fail loudly on corrupt temporal data instead of silently
 * manufacturing "now", which can mask audit and recovery issues.
 */

const isValidDate = (value: Date): boolean => !Number.isNaN(value.getTime());

export const parseDbTimestamp = (value: unknown, fieldName: string): Date => {
  if (value instanceof Date) {
    if (isValidDate(value)) {
      return value;
    }

    throw new Error(`Invalid timestamp for ${fieldName}`);
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);

    if (isValidDate(parsed)) {
      return parsed;
    }

    throw new Error(`Invalid timestamp string for ${fieldName}`);
  }

  if (typeof value === 'object' && value !== null && 'toISOString' in value) {
    const isoValue = (value as { toISOString: () => string }).toISOString();
    const parsed = new Date(isoValue);

    if (isValidDate(parsed)) {
      return parsed;
    }

    throw new Error(`Invalid timestamp object for ${fieldName}`);
  }

  throw new Error(`Unsupported timestamp value for ${fieldName}`);
};
