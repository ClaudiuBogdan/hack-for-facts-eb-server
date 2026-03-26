function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item));
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, nestedValue]) => [key, normalizeJsonValue(nestedValue)] as const)
  );
}

export function jsonValuesAreEqual(leftValue: unknown, rightValue: unknown): boolean {
  return (
    JSON.stringify(normalizeJsonValue(leftValue)) === JSON.stringify(normalizeJsonValue(rightValue))
  );
}
