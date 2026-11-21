/**
 * The client's live legal GraphQL documents, verbatim (interpolated fragments
 * resolved): hack-for-facts-eb-client feat/legal-v2-dev at b608c8f39,
 * src/features/legal/api/*.live.ts. Shared by the mounted-schema validation
 * (tests/integration/legal-client-contract.test.ts, both legal sources) and
 * the real-DDL execution against fixtures
 * (tests/integration/legal/legal-v2.pg.test.ts). If a client query changes,
 * update the copy here in the same review.
 */

/**
 * legal-act-api.live.ts at client 75e36211f, plus `latestDocumentId` (server
 * field added after that revision; the client is to select it next).
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
      defaultOrderReviewed
      latestAvailableDocumentId
      latestDocumentId
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
      timelineComplete
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

/** legal-outline-api.live.ts */
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

/** legal-acts-api.live.ts */
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

/** legal-resolve-api.live.ts */
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

/** legal-resolve-document-api.live.ts */
export const RESOLVE_DOCUMENT_QUERY = /* GraphQL */ `
  query LegalResolveDocument($actId: BigInt!, $documentId: String!) {
    legalAct(actId: $actId) {
      actId
      resolveDocument(documentId: $documentId)
    }
  }
`;

/** legal-api.live.ts */
export const OVERVIEW_QUERY = /* GraphQL */ `
  query LegislationOverview($moYear: Int!) {
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

/** legal-api.live.ts */
export const FRONT_DOOR_QUERY = /* GraphQL */ `
  query LegislationFrontDoor($moYear: Int!) {
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

/** legal-search-api.live.ts */
export const FINDER_SEARCH_QUERY = /* GraphQL */ `
  query LegislationFinderSearch($q: String!, $includeHistorical: Boolean!, $limit: Int!) {
    legalSearch(q: $q, includeHistorical: $includeHistorical, channel: auto, limit: $limit) {
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
      sections {
        act {
          actId
        }
        documentId
        nodeLabel
        snippet
        servedForm {
          documentId
          versionKind
          versionDate
          caveat
          portalLabelRaw
          portalLabelDate
          sourceUrl
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

/** legal-status-counts-api.live.ts */
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

/** legal-domain-counts-api.live.ts */
export const DOMAIN_COUNTS_QUERY = /* GraphQL */ `
  query LegislationDomainCounts {
    legalActCounts(groupBy: DOMAIN) {
      bucketsTruncated
      otherCount
      buckets {
        key
        count
      }
    }
  }
`;

/** legal-changes-api.live.ts */
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

/** legal-changes-api.live.ts */
export const CHANGES_COUNT_QUERY = /* GraphQL */ `
  query LegislationChangesCount(
    $since: String
    $until: String
    $kinds: [String!]
    $eventSource: String
    $undatedOnly: Boolean
  ) {
    legalRecentChanges(
      since: $since
      until: $until
      kinds: $kinds
      eventSource: $eventSource
      undatedOnly: $undatedOnly
      first: 1
    ) {
      totalCount
    }
  }
`;

/** legal-freshness-api.live.ts */
export const FRESHNESS_QUERY = /* GraphQL */ `
  query LegislationFreshness($moYear: Int!, $today: String!) {
    latestIssue: moIssues(filter: { year: { eq: $moYear } }, pageSize: 1, sort: ISSUE_DATE_DESC) {
      edges {
        node {
          issueDate
        }
      }
    }
    latestChange: legalRecentChanges(until: $today, first: 1) {
      edges {
        node {
          effectiveDate
        }
      }
    }
    ccrDecisions: legalActCounts(
      groupBy: STATUS
      filter: { actType: { in: ["decizie"] }, issuerSlug: { in: ["curtea-constitutionala"] } }
    ) {
      bucketsTruncated
      otherCount
      buckets {
        count
      }
    }
  }
`;

/** legal-gazette-api.live.ts */
export const GAZETTE_DIRECTORY_QUERY = /* GraphQL */ `
  query LegislationGazetteDirectory($filter: MoIssuesFilter!, $page: Int!, $pageSize: Int!) {
    moIssues(filter: $filter, page: $page, pageSize: $pageSize, sort: ISSUE_DATE_DESC) {
      total
      pageInfo {
        hasNextPage
      }
      edges {
        node {
          moIssueId
          partCode
          issueLabel
          issueNumber
          issueYear
          issueDate
          pdfUrl
          hasArchiveIndex
          hasEmonitorLink
        }
      }
    }
  }
`;

/** legal-gazette-api.live.ts */
export const GAZETTE_ISSUE_CONTENTS_QUERY = /* GraphQL */ `
  query LegislationGazetteIssueContents($moIssueId: BigInt!, $first: Int!) {
    moIssue(moIssueId: $moIssueId) {
      moIssueId
      contents(first: $first) {
        pageInfo {
          hasNextPage
        }
        edges {
          node {
            moActKey
            title
            actType
            actNumberNorm
            actYear
            issuerSlug
            actDate
            resolution
            act {
              actId
              displayCitation
              status
            }
          }
        }
      }
    }
  }
`;

export interface LegalClientCase {
  readonly name: string;
  readonly query: string;
  readonly variables: Record<string, unknown>;
  /**
   * Monitorul-only documents: validated against the mounted schema, but not
   * executed by the real-DDL suite, which stubs Monitorul (unchanged by v2).
   */
  readonly monitorulOnly?: true;
}

export const LEGAL_CLIENT_CASES: readonly LegalClientCase[] = [
  {
    name: 'act detail (legal-act-api.live.ts)',
    query: ACT_DETAIL_QUERY,
    variables: { actId: '7', outFirst: 60, inFirst: 12, anchorsFirst: 12 },
  },
  {
    name: 'act detail, unbridged act (legal-act-api.live.ts)',
    query: ACT_DETAIL_QUERY,
    variables: { actId: '8', outFirst: 60, inFirst: 12, anchorsFirst: 12 },
  },
  {
    name: 'act detail by citation (legal-act-api.live.ts)',
    query: ACT_DETAIL_QUERY,
    variables: { citation: 'legea 1/2020', outFirst: 60, inFirst: 12, anchorsFirst: 12 },
  },
  {
    name: 'outline (legal-outline-api.live.ts)',
    query: OUTLINE_QUERY,
    variables: { documentId: 'f101', maxDepth: 7, first: 200, after: null },
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
    name: 'resolve document, a page that resolves (legal-resolve-document-api.live.ts)',
    query: RESOLVE_DOCUMENT_QUERY,
    variables: { actId: '7', documentId: '5101' },
  },
  {
    name: 'resolve document, a held page: null (legal-resolve-document-api.live.ts)',
    query: RESOLVE_DOCUMENT_QUERY,
    variables: { actId: '7', documentId: '5200' },
  },
  {
    name: 'overview (legal-api.live.ts)',
    query: OVERVIEW_QUERY,
    variables: { moYear: 2026 },
  },
  {
    name: 'front door (legal-api.live.ts)',
    query: FRONT_DOOR_QUERY,
    variables: { moYear: 2026 },
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
    name: 'domain counts (legal-domain-counts-api.live.ts)',
    query: DOMAIN_COUNTS_QUERY,
    variables: {},
  },
  {
    name: 'changes feed (legal-changes-api.live.ts)',
    query: CHANGES_FEED_QUERY,
    variables: { first: 20 },
  },
  {
    name: 'changes count (legal-changes-api.live.ts)',
    query: CHANGES_COUNT_QUERY,
    variables: { since: '2024-01-01', until: '2026-11-20' },
  },
  {
    name: 'freshness (legal-freshness-api.live.ts)',
    query: FRESHNESS_QUERY,
    variables: { moYear: 2026, today: '2026-11-20' },
  },
  {
    name: 'gazette directory (legal-gazette-api.live.ts)',
    query: GAZETTE_DIRECTORY_QUERY,
    variables: { filter: { year: { eq: 2026 } }, page: 1, pageSize: 20 },
    monitorulOnly: true,
  },
  {
    name: 'gazette issue contents (legal-gazette-api.live.ts)',
    query: GAZETTE_ISSUE_CONTENTS_QUERY,
    variables: { moIssueId: '1', first: 50 },
    monitorulOnly: true,
  },
];
