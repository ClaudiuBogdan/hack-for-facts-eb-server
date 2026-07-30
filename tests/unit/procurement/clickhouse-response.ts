export const compactResponse = (
  rows: readonly Record<string, unknown>[],
  emptyColumns: readonly string[] = []
): Response => {
  const names = rows[0] === undefined ? emptyColumns : Object.keys(rows[0]);
  return Response.json({
    meta: names.map((name) => ({ name, type: 'String' })),
    data: rows.map((row) => names.map((name) => row[name])),
  });
};
