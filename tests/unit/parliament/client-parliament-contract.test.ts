/**
 * Client↔server contract guard for EVERY parliament GraphQL document the
 * transparenta.eu client ships (no DB).
 *
 * The client hand-writes its documents — there is no codegen there — and lives
 * in another repository, so this module's SDL has a consumer CI cannot see. A
 * renamed field or a tightened nullability surfaces only in a browser, and not
 * gently: an unknown field fails VALIDATION, which 400s the whole operation.
 * The page goes blank; it does not lose a line.
 *
 * WHY ALL 32 AND NOT A CHOSEN FEW. The first version of this guard inlined
 * three documents picked by hand. That is exactly what allowed 9d36f95a to
 * delete `ParliamentStenogramSession.sourceUpdatedAt` — as collateral from a
 * whole-file regex — while typecheck passed, 487 tests passed, and the contract
 * guard passed, because the stenogram document was not one of the three. A
 * guard over a hand-picked subset answers a narrower question than the one you
 * think you are asking. The documents are now GENERATED from the client
 * (`scripts/extract-client-parliament-documents.mjs`), so the set cannot drift
 * out of coverage by omission.
 *
 * When this fails: the deployed client would break against this server. Ship
 * the SDL change first, or ship both together — never the client first.
 */

import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';

import { parliamentTypeDefs } from '@/modules/parliament/shell/graphql/typedefs.js';

import { CLIENT_PARLIAMENT_DOCUMENTS } from '../../fixtures/parliament/client-parliament-documents.generated.js';

/**
 * The kernel pieces the parliament slice extends. Stubbed rather than imported
 * so this stays a pure SDL check with no app wiring.
 */
const KERNEL_STUBS = `
  scalar Date
  scalar DateTime
  scalar BigInt
  scalar JSON
  type PageInfo { hasNextPage: Boolean!  endCursor: String }
  type Entity { cui: String! }
  type Query { _root: Boolean }
`;

const schema = buildSchema(`${KERNEL_STUBS}\n${parliamentTypeDefs}`);

const errorsFor = (document: string): readonly string[] =>
  validate(schema, parse(document)).map((e) => e.message);

describe('every client parliament document validates against this SDL', () => {
  it('covers the whole client surface, not a sample', () => {
    // A count pin. If the client gains a document and the fixture is not
    // regenerated, the new one is unguarded — and silence would look identical
    // to coverage. Measured 2026-08-06: 23 in parliament-queries.ts, 3 each in
    // the stenograms/speeches/agenda modules.
    expect(CLIENT_PARLIAMENT_DOCUMENTS).toHaveLength(32);
    const files = new Set(CLIENT_PARLIAMENT_DOCUMENTS.map((d) => d.file));
    expect(files.size).toBe(4);
  });

  it.each(CLIENT_PARLIAMENT_DOCUMENTS.map((d) => [d.name, d] as const))(
    'accepts %s',
    (_name, document) => {
      expect(errorsFor(document.body)).toEqual([]);
    }
  );

  it('fires on a field this schema does not define', () => {
    // Positive control. Without it, a validate() that stopped reporting — or a
    // stub schema that accidentally permitted anything — would leave every
    // assertion above green while protecting nothing.
    const errors = errorsFor(`
      query Bad {
        parliamentBill(billKey: "1") { billKey fieldThatDoesNotExist }
      }
    `);
    expect(errors).not.toEqual([]);
    expect(errors.join(' ')).toContain('fieldThatDoesNotExist');
  });

  it('fires on a field removed from a NON-bill type', () => {
    // The specific shape of the miss this file was rebuilt around: the change
    // was to ParliamentBill, the breakage was on ParliamentStenogramSession.
    const errors = errorsFor(`
      query BadSession {
        parliamentStenogramSession(sessionKey: "1") { sessionKey noSuchField }
      }
    `);
    expect(errors.join(' ')).toContain('noSuchField');
  });
});
