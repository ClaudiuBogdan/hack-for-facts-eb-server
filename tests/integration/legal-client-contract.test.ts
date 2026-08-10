import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '@/app/build-app.js';

import { makeTestConfig } from '../fixtures/builders.js';
import { makeFakeBudgetDb, makeFakeDatasetRepo, makeFakeInsDb } from '../fixtures/fakes.js';

import type { FastifyInstance } from 'fastify';

/**
 * Schema-validation contract for the CLIENT's legal GraphQL documents.
 *
 * The client repo (hack-for-facts-eb-client, src/features/legal/api/*.live.ts)
 * unit-tests its adapters against a MOCKED transport, so nothing there ever
 * validates the documents against this server's real schema — which is
 * exactly how a `tree(depth: 1)` selection on a field that never shipped
 * reached production (fixed 2026-08-10). These are verbatim copies of the
 * client's five live documents, injected against the mounted redesign schema:
 * a document that fails GraphQL VALIDATION (unknown field/argument/type) fails
 * here, while resolver-time failures (the kernel points at a fast-fail DB on
 * purpose) are fine — they mean the shape passed validation.
 *
 * If a client query changes, update the copy here in the same review.
 */

const ACT_DETAIL_QUERY = /* GraphQL */ `
  query LegalActDetail(
    $actId: BigInt
    $citation: String
    $outFirst: Int!
    $inFirst: Int!
    $anchorsFirst: Int!
  ) {
    legalAct(actId: $actId, citation: $citation) {
      actId
      displayCitation
      actType
      actNumber
      actYear
      issuerSlug
      status
      statusEvidence
      entryIntoForce
      inDegree
      aliases
      amendedAfterPublication
      canonicalDocumentId
      canonical {
        documentId
        versionKind
        versionDate
        den
        title
        issuerRaw
        publicationRaw
        firstPublicationDate
        extractionStatus
        compatibilityTier
      }
      summary {
        description
        plainLanguageSummary
        documentCategory
        domains
        affectedAudiences
        keywords
        keyDates
        penaltiesMentioned
        fiscalImpact
        confidence
      }
      timeline {
        kind
        effectiveDate
        label
        eventSource
        relatedActId
      }
      gazettePublications {
        moIssueId
        resolution
        matchedVia
        sourcePdfUrl
        issue {
          partCode
          issueNumber
          issueYear
          issueDate
        }
      }
      outLinks: links(direction: OUT, first: $outFirst) {
        totalCount
        edges {
          relation
          resolution
          confidence
          targetRaw
          targetAct {
            actId
            displayCitation
            actType
            actNumber
            actYear
            issuerSlug
            status
            inDegree
          }
        }
      }
      inLinks: links(direction: IN, first: $inFirst) {
        totalCount
        edges {
          relation
          resolution
          confidence
          targetRaw
          sourceAct {
            actId
            displayCitation
            actType
            actNumber
            actYear
            issuerSlug
            status
            inDegree
          }
        }
      }
      incomingAnchors(first: $anchorsFirst) {
        totalCount
        edges {
          node {
            sourceDocumentId
            linkText
            targetFragment
            targetResolution
            sourceAct {
              actId
              displayCitation
              actType
              actNumber
              actYear
              issuerSlug
              status
              inDegree
            }
          }
        }
      }
      documents {
        documentId
        versionKind
        versionDate
        isCanonical
        title
        firstPublicationDate
        render {
          renderStatus
          chunkCount
        }
      }
    }
  }
`;

const OUTLINE_QUERY = /* GraphQL */ `
  query LegalDocumentOutline($documentId: String!, $maxDepth: Int!, $first: Int!, $after: String) {
    legalDocumentOutline(
      documentId: $documentId
      maxDepth: $maxDepth
      first: $first
      after: $after
    ) {
      entries {
        documentId
        path
        nodeKind
        label
        numberKey
        numberStatus
        depth
        orderIndex
        charStart
        charEnd
      }
      next
    }
  }
`;

const ACTS_DIRECTORY_QUERY = /* GraphQL */ `
  query LegalActsDirectory($filter: LegalActsFilter, $first: Int!, $after: String) {
    legalActs(filter: $filter, first: $first, after: $after) {
      totalCount
      pageInfo {
        endCursor
        hasNextPage
      }
      edges {
        node {
          actId
          displayCitation
          actType
          actNumber
          actYear
          issuerSlug
          status
          inDegree
        }
      }
    }
  }
`;

const RESOLVE_QUERY = /* GraphQL */ `
  query LegalResolve($dim: String!, $q: String!, $limit: Int!) {
    legalResolve(dim: $dim, q: $q, limit: $limit) {
      kind
      value
      label
      score
      hint
    }
  }
`;

const OVERVIEW_QUERY = /* GraphQL */ `
  query LegislationOverview(
    $abrogatIn: [String!]!
    $inVigoareIn: [String!]!
    $modificatIn: [String!]!
    $moYear: Int!
  ) {
    all: legalActs(first: 1) {
      totalCount
    }
    inVigoare: legalActs(filter: { status: { in: $inVigoareIn } }, first: 1) {
      totalCount
    }
    modificat: legalActs(filter: { status: { in: $modificatIn } }, first: 1) {
      totalCount
    }
    abrogat: legalActs(filter: { status: { in: $abrogatIn } }, first: 1) {
      totalCount
    }
    mostCited: legalActs(sort: IN_DEGREE, dir: DESC, first: 7) {
      edges {
        node {
          actId
          displayCitation
          actType
          actNumber
          actYear
          issuerSlug
          status
          inDegree
        }
      }
    }
    moIssues(filter: { year: { eq: $moYear } }, pageSize: 5, sort: ISSUE_DATE_DESC) {
      edges {
        node {
          moIssueId
          partCode
          issueLabel
          issueNumber
          issueYear
          issueDate
          pdfUrl
          hasEmonitorLink
        }
      }
    }
  }
`;

const VALIDATION_ERROR =
  /Cannot query field|Unknown argument|Unknown type|Expected type|cannot represent|got invalid value|of required type|Unknown fragment/i;

const CASES: readonly { name: string; query: string; variables: Record<string, unknown> }[] = [
  {
    name: 'act detail (legal-act-api.live.ts)',
    query: ACT_DETAIL_QUERY,
    variables: { actId: '66150', outFirst: 60, inFirst: 12, anchorsFirst: 12 },
  },
  {
    name: 'outline (legal-outline-api.live.ts)',
    query: OUTLINE_QUERY,
    variables: { documentId: '171282', maxDepth: 7, first: 200, after: null },
  },
  {
    name: 'acts directory (legal-acts-api.live.ts)',
    query: ACTS_DIRECTORY_QUERY,
    variables: {
      filter: { actType: { in: ['lege'] }, year: { eq: 2015 }, status: { in: ['in-vigoare'] } },
      first: 20,
      after: null,
    },
  },
  {
    name: 'resolver (legal-resolve-api.live.ts)',
    query: RESOLVE_QUERY,
    variables: { dim: 'act', q: 'codul fiscal', limit: 8 },
  },
  {
    name: 'overview (legal-api.live.ts)',
    query: OVERVIEW_QUERY,
    variables: {
      inVigoareIn: ['in-vigoare'],
      modificatIn: ['modificat'],
      abrogatIn: ['abrogat', 'abrogat-partial'],
      moYear: 2026,
    },
  },
];

describe('legal client GraphQL documents validate against the mounted schema', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp({
      fastifyOptions: { logger: false },
      deps: {
        budgetDb: makeFakeBudgetDb(),
        insDb: makeFakeInsDb(),
        datasetRepo: makeFakeDatasetRepo(),
        config: makeTestConfig({ redesignSurface: { enabled: true } }),
        // Fast-fail endpoints: resolver-time DB errors are expected and fine;
        // only schema VALIDATION failures matter here.
        redesignKernelConfig: {
          prodDatabaseUrl: 'postgres://test:test@127.0.0.1:1/test',
          meiliHost: '',
          meiliApiKey: '',
          opensearchUrl: '',
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('mounts the redesign GraphQL route (precondition)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/graphql',
      payload: { query: '{ __typename }' },
    });
    expect(response.statusCode).toBe(200);
  });

  for (const testCase of CASES) {
    it(`validates: ${testCase.name}`, async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/graphql',
        payload: { query: testCase.query, variables: testCase.variables },
      });

      const body: { errors?: readonly { message: string }[] } = response.json();
      const validationErrors = (body.errors ?? []).filter((error) =>
        VALIDATION_ERROR.test(error.message)
      );
      expect(validationErrors).toEqual([]);
    });
  }
});
