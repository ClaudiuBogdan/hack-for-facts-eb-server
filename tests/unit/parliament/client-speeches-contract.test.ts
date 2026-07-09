/**
 * Client↔server contract guard for the global stenograme surface (no DB).
 *
 * The transparenta.eu client ships hand-written GraphQL documents for
 * `parliamentSpeeches` / `parliamentSpeechActivity` / `parliamentSpeech`
 * (src/features/parliament/api/graphql/parliament-speeches-queries.ts). Those
 * documents are the real consumer of this module's SDL, but they live in
 * another repo, so a renamed field or a tightened nullability here would only
 * break at runtime, in the browser.
 *
 * The documents are INLINED below (verbatim copies, kept in sync deliberately)
 * and validated against the built parliament schema. A failure here means the
 * client would 400 against this server — fix the SDL or ship a client change
 * with it.
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

/** Verbatim from the client's parliament-speeches-queries.ts. */
const CLIENT_SPEECHES_QUERY = `
  query ParliamentSpeeches(
    $first: Int
    $after: String
    $filter: ParliamentSpeechesFilter
    $q: String
  ) {
    parliamentSpeeches(first: $first, after: $after, filter: $filter, q: $q) {
      total
      totalEstimated
      searchDepth
      edges {
        cursor
        node {
          speechKey
          spokenAt
          title
          summary
          chamber
          sourceUrl
          sourceUrlKind
          fullText
          speakerName
          member {
            mandateKey
            fullName
            chamber
            groupName
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const CLIENT_SPEECH_ACTIVITY_QUERY = `
  query ParliamentSpeechActivity(
    $year: Int!
    $filter: ParliamentSpeechesFilter
    $q: String
  ) {
    parliamentSpeechActivity(year: $year, filter: $filter, q: $q) {
      year
      availableYears
      searchDepth
      days {
        date
        total
        proprie
        comun
      }
    }
  }
`;

const CLIENT_SPEECH_QUERY = `
  query ParliamentSpeech($speechKey: ID!) {
    parliamentSpeech(speechKey: $speechKey) {
      speechKey
      spokenAt
      title
      summary
      chamber
      sourceUrl
      sourceUrlKind
      fullText
      speakerName
      member {
        mandateKey
        fullName
        chamber
        groupName
      }
    }
  }
`;

describe('client stenograme documents validate against the parliament SDL', () => {
  it.each([
    ['ParliamentSpeeches', CLIENT_SPEECHES_QUERY],
    ['ParliamentSpeechActivity', CLIENT_SPEECH_ACTIVITY_QUERY],
    ['ParliamentSpeech', CLIENT_SPEECH_QUERY],
  ])('%s', (_name, document) => {
    const errors = validate(schema, parse(document));
    expect(errors.map((e) => e.message)).toEqual([]);
  });
});

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
