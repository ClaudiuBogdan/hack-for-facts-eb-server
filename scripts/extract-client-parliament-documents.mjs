/**
 * Regenerate the client's parliament GraphQL documents as a test fixture.
 *
 * WHY THIS EXISTS. The transparenta.eu client hand-writes its GraphQL documents
 * (no codegen) and lives in another repository, so this module's SDL has a
 * consumer that CI cannot see. A renamed field or a tightened nullability here
 * surfaces only in a browser, and not gently: an unknown field fails validation
 * and 400s the WHOLE operation, so the page goes blank rather than losing a
 * line.
 *
 * WHY IT IS GENERATED RATHER THAN HAND-COPIED. The first version of this guard
 * inlined three documents chosen by hand. That is what let 9d36f95a delete
 * `ParliamentStenogramSession.sourceUpdatedAt` with a clean typecheck, a clean
 * 487-test suite AND a passing contract guard: the stenogram document simply
 * was not among the three. A guard over a hand-picked subset silently answers a
 * narrower question than the one being asked of it. There are 32 documents;
 * this takes all of them.
 *
 * USAGE (manual, on demand — the client is not a build dependency):
 *   node scripts/extract-client-parliament-documents.mjs [path-to-client-repo]
 *
 * Then run the parliament tests. A failure means the deployed client would
 * break against this server: ship the SDL change first, or ship both together.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const clientRepo =
  process.argv[2] ??
  join(process.env['HOME'] ?? '', 'projects/devostack/hack-for-facts-eb-client');

const SOURCES = [
  'parliament-queries.ts',
  'parliament-stenograms-queries.ts',
  'parliament-speeches-queries.ts',
  'parliament-agenda-queries.ts',
];

/**
 * Body of the template literal assigned to `<decl> <name>`.
 *
 * The closing delimiter is the NEXT backtick, full stop. These files use both
 * `` `…` `` (fragments) and `` `…`; `` (exported documents); keying on "`;"
 * runs straight past a fragment into the following literal, which produced an
 * infinite fragment-resolution loop the first time this was written by hand.
 */
const literalBody = (source, decl) => {
  const at = source.indexOf(decl);
  if (at < 0) throw new Error(`not found: ${decl}`);
  const open = source.indexOf('`', at);
  const close = source.indexOf('`', open + 1);
  if (open < 0 || close < 0) throw new Error(`unterminated literal: ${decl}`);
  return source.slice(open + 1, close);
};

/** Inline `${FRAGMENT}` references, refusing to loop. */
const resolveFragments = (source, text, seen = new Set()) =>
  text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, name) => {
    if (seen.has(name)) throw new Error(`cyclic fragment: ${name}`);
    return resolveFragments(
      source,
      literalBody(source, `const ${name}`),
      new Set([...seen, name]),
    );
  });

const documents = [];
for (const file of SOURCES) {
  const path = join(clientRepo, 'src/features/parliament/api/graphql', file);
  const source = readFileSync(path, 'utf8');
  const names = [...source.matchAll(/export const ([A-Z][A-Z0-9_]*_QUERY)\s*=/gu)].map(
    (m) => m[1],
  );
  if (names.length === 0) throw new Error(`no documents found in ${file}`);
  for (const name of names) {
    const body = resolveFragments(
      source,
      literalBody(source, `export const ${name}`),
    );
    if (body.includes('`')) throw new Error(`unbalanced backtick in ${name}`);
    if (/\$\{/u.test(body)) throw new Error(`unresolved interpolation in ${name}`);
    documents.push({ file, name, body });
  }
}

const header = `/**
 * GENERATED — do not edit. Regenerate with:
 *   node scripts/extract-client-parliament-documents.mjs [path-to-client-repo]
 *
 * Verbatim copies of EVERY parliament GraphQL document the transparenta.eu
 * client ships, with fragments inlined. Consumed by
 * client-parliament-contract.test.ts, which validates each against the built
 * SDL. See the generator for why this is generated and not hand-picked.
 *
 * Extracted ${documents.length} documents from ${SOURCES.length} client modules.
 */

export interface ClientDocument {
  readonly file: string;
  readonly name: string;
  readonly body: string;
}

export const CLIENT_PARLIAMENT_DOCUMENTS: readonly ClientDocument[] = [
`;

const body = documents
  .map(
    (d) =>
      `  {\n    file: ${JSON.stringify(d.file)},\n    name: ${JSON.stringify(d.name)},\n    body: ${JSON.stringify(d.body)},\n  },`,
  )
  .join('\n');

const target = join(
  import.meta.dirname,
  '../tests/fixtures/parliament/client-parliament-documents.generated.ts',
);
writeFileSync(target, `${header}${body}\n];\n`);

// Format the output with the repo's own formatter before we finish.
//
// Without this the script is not idempotent: it emits JSON double quotes, the
// pre-commit hook rewrites them to single quotes, and so EVERY regeneration
// shows a ~94-line diff that is pure quote churn. That is worse than cosmetic —
// the whole point of committing this fixture is that a real client change shows
// up as a reviewable diff, and noise that large hides exactly that signal.
execFileSync('npx', ['prettier', '--write', target], {
  cwd: join(import.meta.dirname, '..'),
  stdio: 'inherit',
});

console.log(`extracted ${documents.length} documents:`);
for (const { file, name } of documents) console.log(`  ${file}  ${name}`);
