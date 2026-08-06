/**
 * Filter-INPUT contract guard for the global stenograme surface (no DB).
 *
 * This file used to also inline the client's three speeches documents as
 * hand-typed copies and validate them. Those copies had DRIFTED — they omitted
 * `isCanonical`, `sessionKey` and `position`, which the real client does select
 * — so removing one of those SDL fields would have left this guard green while
 * the deployed client 400s. A hand-maintained copy of someone else's file is a
 * guard that decays silently.
 *
 * Document validation now lives in `client-parliament-contract.test.ts`, which
 * validates ALL 32 client parliament documents from a fixture GENERATED out of
 * the client repo, so it cannot drift or omit.
 *
 * What stays here is what that generated guard does NOT cover: the shape of the
 * filter INPUT the client constructs at runtime. A document proves the client
 * can ask; these prove the server accepts the argument literal it actually
 * sends.
 */

import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';

import { parliamentTypeDefs } from '@/modules/parliament/shell/graphql/typedefs.js';

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

describe('the filter input the client builds is accepted', () => {
  it('exposes ParliamentSpeechesFilter with mandateKey/chamber/spokenAt', () => {
    const filter = schema.getType('ParliamentSpeechesFilter');
    expect(filter, 'ParliamentSpeechesFilter').toBeDefined();
    // `getFields` exists on input object types; the cast keeps this a pure guard.
    const fields = (filter as { getFields: () => Record<string, unknown> }).getFields();
    for (const name of ['mandateKey', 'chamber', 'spokenAt']) {
      expect(fields[name], name).toBeDefined();
    }
  });

  it('the client-sent bounded filter shape type-checks as a variable', () => {
    // A query whose default value exercises the exact literal the client sends:
    // mandateKey {eq}, chamber {eq}, spokenAt {gte, lte}.
    const document = `
      query ClientBoundedFilter(
        $filter: ParliamentSpeechesFilter = {
          mandateKey: { eq: "2:2020:12" }
          chamber: { eq: "camera_deputatilor" }
          spokenAt: { gte: "2026-01-01", lte: "2026-12-31" }
        }
      ) {
        parliamentSpeeches(filter: $filter, first: 20) { total }
      }
    `;
    expect(validate(schema, parse(document)).map((e) => e.message)).toEqual([]);
  });
});
