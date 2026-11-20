/**
 * The client's live legal GraphQL documents (hack-for-facts-eb-client,
 * src/features/legal/api/*.live.ts), verbatim. Shared by the mounted-schema
 * validation (tests/integration/legal-client-contract.test.ts) and the
 * real-DDL execution against fixtures (tests/integration/legal/legal-v2.pg.test.ts).
 * If a client query changes, update the copy here in the same review.
 */

export const ACT_DETAIL_QUERY = /* GraphQL */ `
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
      dataSource
      bridgedFields
      newerNotAvailable
      defaultBasis
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
        readable
        caveat
        portalLabelRaw
        portalLabelDate
        held
        formKey
        sourceUrl
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
        readable
        caveat
        portalLabelRaw
        portalLabelDate
        held
        formKey
        sourceUrl
        render {
          renderStatus
          chunkCount
        }
      }
    }
  }
`;

export const OUTLINE_QUERY = /* GraphQL */ `
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

export const ACTS_DIRECTORY_QUERY = /* GraphQL */ `
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

export const RESOLVE_QUERY = /* GraphQL */ `
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

export const OVERVIEW_QUERY = /* GraphQL */ `
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

export const FINDER_SEARCH_QUERY = /* GraphQL */ `
  query LegislationFinderSearch($q: String!, $includeHistorical: Boolean!, $limit: Int!) {
    legalSearch(q: $q, includeHistorical: $includeHistorical, channel: docs, limit: $limit) {
      acts {
        score
        act {
          actId
          displayCitation
          actType
          actNumber
          actYear
          issuerSlug
          status
          inDegree
        }
        summary {
          description
        }
      }
      caveats
      engine
      actsTotal
      totalsExhaustive
      degraded
      asOf
      unhydratedHits
    }
  }
`;

export const STATUS_COUNTS_QUERY = /* GraphQL */ `
  query LegislationStatusCounts {
    legalActCounts(groupBy: STATUS) {
      bucketsTruncated
      otherCount
      buckets {
        key
        count
      }
    }
  }
`;

export const CHANGES_FEED_QUERY = /* GraphQL */ `
  query LegislationChangesFeed(
    $since: String
    $until: String
    $kinds: [String!]
    $eventSource: String
    $undatedOnly: Boolean
    $first: Int!
    $after: String
  ) {
    legalRecentChanges(
      since: $since
      until: $until
      kinds: $kinds
      eventSource: $eventSource
      undatedOnly: $undatedOnly
      first: $first
      after: $after
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          eventId
          eventKind
          effectiveDate
          eventSource
          sourceAct {
            actId
            displayCitation
          }
          actId
          displayCitation
          status
        }
      }
    }
  }
`;

export const LEGAL_CLIENT_CASES: readonly {
  name: string;
  query: string;
  variables: Record<string, unknown>;
}[] = [
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
      filter: {
        actType: { in: ['lege'] },
        year: { eq: 2015 },
        status: { in: ['in-vigoare'] },
        // The domain-grid tiles emit this family — the whole reason this
        // suite exists is an unshipped filter reaching the client.
        domain: { in: ['fiscal-si-bugetar'] },
      },
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
  {
    name: 'finder search (legal-search-api.live.ts)',
    query: FINDER_SEARCH_QUERY,
    variables: { q: 'impozit pe venit', includeHistorical: false, limit: 20 },
  },
  {
    name: 'status counts (legal-status-counts-api.live.ts)',
    query: STATUS_COUNTS_QUERY,
    variables: {},
  },
  {
    name: 'changes feed (legal-changes-api.live.ts)',
    query: CHANGES_FEED_QUERY,
    variables: { first: 20 },
  },
];

// The same documents against both legal sources: LEGAL_SOURCE=legacy (the
// default) and LEGAL_SOURCE=v2 (legal_v2 + the bridge). One SDL serves both.
