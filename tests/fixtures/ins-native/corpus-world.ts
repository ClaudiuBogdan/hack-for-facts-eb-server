/**
 * Map the golden-master corpus's real-world identifiers onto the fake INS
 * world of `fake-repo.ts`: dataset codes (POP107D → POPTEST, FOM104D →
 * CNTTEST, SOM101F → EMPTYTEST, LOC101B → POPTEST), the legacy classification
 * type slugs the landing document still embeds (`SEX`/`AGE_GROUP` → `D1`/`D0`,
 * the client change of plan §5) and the measured decade years (the fake holds
 * 2019–2021). Applied to the document text AND the variables, so a corpus
 * entry runs against the fake exactly as the client sends it against Chronos.
 */

export const toFakeInsWorld = (text: string): string =>
  text
    .replaceAll('POP107D', 'POPTEST')
    .replaceAll('FOM104D', 'CNTTEST')
    .replaceAll('SOM101F', 'EMPTYTEST')
    .replaceAll('LOC101B', 'POPTEST')
    .replaceAll('"SEX"', '"D1"')
    .replaceAll('"AGE_GROUP"', '"D0"')
    .replaceAll('"2016"', '"2019"')
    .replaceAll('"2025"', '"2021"');

export const toFakeInsVariables = (
  vars: Record<string, unknown> | undefined
): Record<string, unknown> => {
  // eslint-disable-next-line no-restricted-syntax -- re-parsing a JSON.stringify of test variables
  const parsed: unknown = JSON.parse(toFakeInsWorld(JSON.stringify(vars ?? {})));
  return parsed as Record<string, unknown>;
};
