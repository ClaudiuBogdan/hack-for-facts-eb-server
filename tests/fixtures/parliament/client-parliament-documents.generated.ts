/**
 * GENERATED — do not edit. Regenerate with:
 *   node scripts/extract-client-parliament-documents.mjs [path-to-client-repo]
 *
 * Verbatim copies of EVERY parliament GraphQL document the transparenta.eu
 * client ships, with fragments inlined. Consumed by
 * client-parliament-contract.test.ts, which validates each against the built
 * SDL. See the generator for why this is generated and not hand-picked.
 *
 * Extracted 33 documents from 4 client modules.
 */

export interface ClientDocument {
  readonly file: string;
  readonly name: string;
  readonly body: string;
}

export const CLIENT_PARLIAMENT_DOCUMENTS: readonly ClientDocument[] = [
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_GROUPS_QUERY',
    body: '\n  query ParliamentGroups(\n    $legislature: String\n    $chamber: String\n    $current: Boolean\n  ) {\n    parliamentGroups(\n      legislature: $legislature\n      chamber: $chamber\n      current: $current\n    ) {\n      groupId\n      chamber\n      name\n      memberCount\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_VOTE_COHESION_QUERY',
    body: '\n  query ParliamentVoteCohesion(\n    $chamber: ParliamentChamber\n    $from: Date\n    $to: Date\n  ) {\n    parliamentVoteCohesion(chamber: $chamber, from: $from, to: $to) {\n      groupName\n      forPct\n      againstPct\n      abstainPct\n      absentPct\n      conflictingPct\n      unknownPct\n      cohesionIndex\n      voteCount\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_MEMBERS_QUERY',
    body: '\n  query ParliamentMembers(\n    $filter: ParliamentMembersFilter\n    $page: Int\n    $pageSize: Int\n  ) {\n    parliamentMembers(filter: $filter, page: $page, pageSize: $pageSize) {\n      total\n      totalEstimated\n      members {\n        mandateKey\n        chamber\n        legislature\n        fullName\n        groupName\n        constituencyName\n        birthDate\n        # SC-1: the directory lists every MANDATE row, including seats that have\n        # ended (replacement/death). Without these, a citizen searching their\n        # county sees a former member indistinguishable from the sitting one.\n        isCurrent\n        mandateEndDate\n        mandateEndReason\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_MEMBER_QUERY',
    body: '\n  query ParliamentMember($mandateKey: ID!) {\n    parliamentMember(mandateKey: $mandateKey) {\n      mandateKey\n      chamber\n      legislature\n      fullName\n      groupName\n      constituencyName\n      birthDate\n      profileUrl\n      cvPdfUrl\n      # SC-1 seat lifecycle: a mandate row survives the seat ending, so the\n      # profile must be able to say "mandat încheiat" instead of presenting a\n      # replaced member as a sitting representative.\n      isCurrent\n      mandateEndDate\n      mandateEndReason\n      committeeMemberships { \n  membershipKey role joinedDate leftDate isBureau sourceUrl\n  committee { committeeKey chamber name sourceUrl }\n }\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_GROUP_MEMBERS_QUERY',
    body: '\n  query ParliamentGroupMembers(\n    $groupId: ID!\n    $legislature: String\n    $current: Boolean\n  ) {\n    parliamentGroupMembers(\n      groupId: $groupId\n      legislature: $legislature\n      current: $current\n    ) {\n      mandateKey\n      chamber\n      legislature\n      fullName\n      groupName\n      constituencyName\n      birthDate\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_VOTES_QUERY',
    body: '\n  query ParliamentVotes(\n    $filter: ParliamentVotesFilter\n    $sort: ParliamentVoteSort\n    $dir: ParliamentSortDir\n    $first: Int\n    $after: String\n  ) {\n    parliamentVotes(\n      filter: $filter\n      sort: $sort\n      dir: $dir\n      first: $first\n      after: $after\n    ) {\n      # How many votes the ACTIVE FILTER matches — capped by the server at\n      # 10,000, with totalEstimated flagging that the cap bit.\n      total\n      totalEstimated\n      edges {\n        cursor\n        node {\n          voteKey\n          chamber\n          voteDate\n          voteSubject\n          # What the chamber was voting ON where no subject was printed — which\n          # is most of the corpus outside the legislative bucket.\n          kind\n          title\n          outcome\n          divisionNumber\n          billKey\n          tally {\n            pentru\n            impotriva\n            abtinere\n            nuAVotat\n            present\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_VOTE_KIND_COUNTS_QUERY',
    body: '\n  query ParliamentVoteKindCounts($chamber: ParliamentVotesChamberFilter) {\n    legislative: parliamentVotes(\n      filter: { chamber: $chamber, kind: { in: ["legislative"] } }\n      first: 1\n    ) {\n      total\n      totalEstimated\n    }\n    amendment: parliamentVotes(\n      filter: { chamber: $chamber, kind: { in: ["amendment"] } }\n      first: 1\n    ) {\n      total\n      totalEstimated\n    }\n    procedural: parliamentVotes(\n      filter: { chamber: $chamber, kind: { in: ["procedural"] } }\n      first: 1\n    ) {\n      total\n      totalEstimated\n    }\n    chamber_decision: parliamentVotes(\n      filter: { chamber: $chamber, kind: { in: ["chamber_decision"] } }\n      first: 1\n    ) {\n      total\n      totalEstimated\n    }\n    attendance: parliamentVotes(\n      filter: { chamber: $chamber, kind: { in: ["attendance"] } }\n      first: 1\n    ) {\n      total\n      totalEstimated\n    }\n    unclassified: parliamentVotes(\n      filter: { chamber: $chamber, kind: { in: ["unclassified"] } }\n      first: 1\n    ) {\n      total\n      totalEstimated\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_VOTE_QUERY',
    body: '\n  query ParliamentVote($voteKey: ID!, $ballotsFirst: Int, $after: String) {\n    parliamentVote(voteKey: $voteKey) {\n      voteKey\n      chamber\n      voteDate\n      # The clock time the chamber PRINTED against this division ("20.12.2023\n      # 16:16"), on all 14,158 CDep + joint divisions and none of the 6,702\n      # Senate ones. voteDate is a DATE column parsed OUT of this string, so it\n      # carries no time at all — this is the only place the hour exists.\n      voteDateTimeText\n      voteSubject\n      kind\n      title\n      outcome\n      divisionNumber\n      billKey\n      sourceUrl\n      # The ROLE-BEARING edges of THIS division. billKey holds at most one bill\n      # and no role at all; role is the only field that says what the division\n      # was procedurally for. It names the MOTION, not the result — the verdict\n      # is role composed with outcome.\n      voteLinks {\n        billKey\n        role\n        resolutionStatus\n        bill {\n          billKey\n          title\n          plxNumber\n          plxYear\n          senateNumber\n          senateYear\n        }\n      }\n      tally {\n        pentru\n        impotriva\n        abtinere\n        nuAVotat\n        present\n      }\n      groupBreakdown {\n        groupName\n        pentru\n        impotriva\n        abtinere\n        nuAVotat\n        conflicting\n        unknown\n      }\n      ballots(first: $ballotsFirst, after: $after) {\n        edges {\n          node {\n            positionKey\n            rowIndex\n            memberName\n            groupName\n            choice\n            positionStatus\n            observationCount\n            observedChoices\n            mandateKey\n            matchMethod\n            constituencyName\n          }\n        }\n        pageInfo {\n          hasNextPage\n          endCursor\n        }\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_VOTE_BALLOTS_QUERY',
    body: '\n  query ParliamentVoteBallots($voteKey: ID!, $first: Int, $after: String) {\n    parliamentVote(voteKey: $voteKey) {\n      ballots(first: $first, after: $after) {\n        edges {\n          node {\n            positionKey\n            rowIndex\n            memberName\n            groupName\n            choice\n            positionStatus\n            observationCount\n            observedChoices\n            mandateKey\n            matchMethod\n            constituencyName\n          }\n        }\n        pageInfo {\n          hasNextPage\n          endCursor\n        }\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_MEMBER_VOTES_QUERY',
    body: '\n  query ParliamentMemberVotes(\n    $mandateKey: ID!\n    $first: Int\n    $after: String\n    $filter: ParliamentMemberVotesFilter\n  ) {\n    parliamentMember(mandateKey: $mandateKey) {\n      mandateKey\n      votes(first: $first, after: $after, filter: $filter) {\n        total\n        edges {\n          node {\n            positionKey\n            voteKey\n            chamber\n            voteDate\n            title\n            outcome\n            choice\n            positionStatus\n            observationCount\n            observedChoices\n            billKey\n          }\n        }\n        pageInfo {\n          hasNextPage\n          endCursor\n        }\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_MEMBER_VOTE_ACTIVITY_QUERY',
    body: '\n  query ParliamentMemberVoteActivity(\n    $mandateKey: ID!\n    $year: Int!\n    $filter: ParliamentMemberVotesFilter\n  ) {\n    parliamentMember(mandateKey: $mandateKey) {\n      mandateKey\n      voteActivity(year: $year, filter: $filter) {\n        year\n        availableYears\n        days {\n          date\n          total\n          pentru\n          impotriva\n          abtinere\n          nuAVotat\n          conflicting\n          unknown\n        }\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_VOTE_ACTIVITY_QUERY',
    body: '\n  query ParliamentVoteActivity($year: Int!, $filter: ParliamentVotesFilter) {\n    parliamentVoteActivity(year: $year, filter: $filter) {\n      year\n      availableYears\n      days {\n        date\n        total\n        camera\n        senat\n        comun\n      }\n      coverage {\n        chamber\n        sourceSystem\n        scope\n        sourceUrl\n        sourceAvailableFrom\n        observedFrom\n        observedThrough\n        finalizedThrough\n        asOf\n        ranges {\n          from\n          to\n        }\n        gaps {\n          date\n          status\n          reason\n        }\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_BILL_ACTIVITY_QUERY',
    body: '\n  query ParliamentBillActivity($year: Int!, $filter: ParliamentBillsFilter) {\n    parliamentBillActivity(year: $year, filter: $filter) {\n      year\n      availableYears\n      days {\n        date\n        total\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_MEMBER_SPEECHES_QUERY',
    body: '\n  query ParliamentMemberSpeeches(\n    $mandateKey: ID!\n    $first: Int\n    $after: String\n    $filter: ParliamentMemberSpeechesFilter\n    $q: String\n  ) {\n    parliamentMember(mandateKey: $mandateKey) {\n      mandateKey\n      speechesConnection(first: $first, after: $after, filter: $filter, q: $q) {\n        total\n        edges {\n          cursor\n          node {\n            speechKey\n            spokenAt\n            title\n            summary\n            chamber\n            sourceUrl\n            sourceUrlKind\n            fullText\n            isCanonical\n            sessionKey\n            position\n          }\n        }\n        pageInfo {\n          hasNextPage\n          endCursor\n        }\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_MEMBER_SPEECH_ACTIVITY_QUERY',
    body: '\n  query ParliamentMemberSpeechActivity(\n    $mandateKey: ID!\n    $year: Int!\n    $filter: ParliamentMemberSpeechesFilter\n    $q: String\n  ) {\n    parliamentMember(mandateKey: $mandateKey) {\n      mandateKey\n      speechActivity(year: $year, filter: $filter, q: $q) {\n        year\n        availableYears\n        days {\n          date\n          total\n          proprie\n          comun\n        }\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_MEMBER_PROFILE_QUERY',
    body: '\n  query ParliamentMemberProfile($mandateKey: ID!, $controlPageSize: Int) {\n    parliamentMember(mandateKey: $mandateKey) {\n      mandateKey\n      fullName\n      constituencyName\n      legislature\n      controlItems(page: 1, pageSize: $controlPageSize) {\n        total\n        items {\n          itemKey controlType title recipient itemDate responseStatus sourceUrl\n          aiMetadata { \n  summary policyDomains issueTypes urgency keywords\n  configKey promptVersion schemaVersion model\n  validationStatus confidence sourceUpdatedAt loadedAt\n  privacyClass trustClass disclaimer\n }\n        }\n      }\n      declarations { declarationType declarationDate label fileUrl }\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_MEMBER_INITIATIVES_QUERY',
    body: '\n  query ParliamentMemberInitiatives(\n    $mandateKey: ID!\n    $page: Int\n    $pageSize: Int\n  ) {\n    parliamentMember(mandateKey: $mandateKey) {\n      mandateKey\n      initiatives(page: $page, pageSize: $pageSize) {\n        total\n        initiatives {\n          initiativeKey\n          billKey\n          title\n          status\n          registrationDate\n          promulgatedLawNumber\n          promulgatedLawYear\n        }\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_BILLS_QUERY',
    body: "\n  query ParliamentBills(\n    $filter: ParliamentBillsFilter\n    $sort: ParliamentBillSort\n    $page: Int\n    $pageSize: Int\n  ) {\n    parliamentBills(\n      filter: $filter\n      sort: $sort\n      page: $page\n      pageSize: $pageSize\n    ) {\n      total\n      totalEstimated\n      bills {\n        billKey\n        plxNumber\n        plxYear\n        senateNumber\n        senateYear\n        title\n        finalLawNumber\n        finalLawYear\n        statusText\n        billType\n        lastEventDate\n        # The two prose fields the list can afford. lastEventDescription says\n        # WHAT the last move was (the list already sorts by WHEN); the object of\n        # regulation is the bill's own statement of what it does. Each row must\n        # read correctly without either, but NEITHER is rare on the page people\n        # actually land on: the default sort is last_event_date desc, and on the\n        # first page of 10 that means ~95% carry a description and half carry an\n        # object of regulation — against 49% and 2.4% corpus-wide. Cost measured\n        # on that real page: 2,897 bytes, ~290 B/row.\n        lastEventDescription\n        objectOfRegulation\n        # DERIVED classification — preferred over the client's title-prefix\n        # heuristic wherever present. See classifyBillType.\n        initiatorType\n      }\n    }\n  }\n",
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_BILL_QUERY',
    body: "\n  query ParliamentBill($billKey: ID!) {\n    parliamentBill(billKey: $billKey) {\n      billKey\n      plxNumber\n      plxYear\n      senateNumber\n      senateYear\n      title\n      finalLawNumber\n      finalLawYear\n      statusText\n      billType\n      lastEventDate\n      lastEventDescription\n      objectOfRegulation\n      initiatorType\n      # ── How the bill is being handled (attrs.procedure) ──────────────────\n      # decisionChamber says which chamber casts the final, unappealable vote\n      # (art. 75) — the single fact that says where the bill's fate is decided.\n      # OPEN STRING: 11 rows carry parser-welded prose, so the client matches a\n      # known vocabulary before it renders one.\n      decisionChamber\n      lawCharacter\n      # TRI-STATE: true (4,697) / false (16,051) / null (21,242 with no\n      # procedure block at all). Null must never be shown as \"not urgent\".\n      procedureUrgency\n      procedureRegime\n      # ── Timeline bounds + provenance ────────────────────────────────────\n      firstEventDate\n      lastEventSource\n      sourceUpdatedAt\n      # ── The four human-openable source pages ────────────────────────────\n      cdepProjectUrl\n      senateDetailUrl\n      senateFileUrl\n      senateOpinionsUrl\n      # ── Cross-source identifiers ────────────────────────────────────────\n      senateCod\n      governmentENumber\n      governmentEYear\n      # DERIVED BY US, never printed by the chamber — rendered as our\n      # classification with the rule that produced it, never as a source fact.\n      initiatorTypeConfidence\n      initiatorTypeMethod\n      dossierBillKeys\n      events {\n        sourceBillKey position eventDate eventDateText description chamberCode committee voteIdv docs\n        rowKind parentPosition stepKind actorKind\n        links { linkKind targetKey sourceHref sourceText resolutionStatus }\n      }\n      documents { sourceBillKey url label kind position }\n      initiators { mandateKey fullName groupName }\n      relatedVotes {\n        voteKey\n        chamber\n        voteDate\n        # What the chamber voted ON. The title field here is the BILL's title on\n        # every one of these rows, so without this the cards cannot be told apart.\n        voteSubject\n        title\n        outcome\n        divisionNumber\n        sourceUrl\n        tally { pentru impotriva abtinere nuAVotat present }\n      }\n      # The ROLE-BEARING edge (bill_vote_links.role). Only an explicit\n      # 'final_adoption' / 'final_rejection' role proves a vote was the final one\n      # — chronological order does not.\n      voteLinks {\n        voteKey\n        role\n        resolutionStatus\n      }\n      actLinks {\n        relationshipKind\n        resolutionStatus\n        confidenceLabel\n        legalAct { actId title actType }\n      }\n      aiMetadata { \n  summary topic domains keywords valueClass\n  configKey promptVersion schemaVersion model\n  validationStatus confidence sourceUpdatedAt loadedAt\n  privacyClass trustClass disclaimer\n }\n    }\n  }\n",
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_RESOLVE_QUERY',
    body: '\n  query ParliamentResolve(\n    $dim: ParliamentFilterDim!\n    $q: String!\n    $legislature: String\n  ) {\n    parliamentResolveFilter(dim: $dim, q: $q, legislature: $legislature) {\n      dim\n      value\n      label\n      kind\n      score\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_FRESHNESS_QUERY',
    body: '\n  query ParliamentDataFreshness {\n    parliamentDataFreshness {\n      latestVoteDate\n      lastLoadedAt\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_COMMITTEES_QUERY',
    body: '\n  query ParliamentCommittees(\n    $chamber: String\n    $legislature: String\n    $first: Int\n    $after: String\n  ) {\n    parliamentCommittees(\n      chamber: $chamber\n      legislature: $legislature\n      first: $first\n      after: $after\n    ) {\n      edges {\n        cursor\n        node {\n          committeeKey\n          chamber\n          name\n          legislature\n          committeeType\n          sourceUrl\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_COMMITTEE_QUERY',
    body: '\n  query ParliamentCommittee($committeeKey: ID!) {\n    parliamentCommittee(committeeKey: $committeeKey) {\n      committeeKey\n      chamber\n      name\n      legislature\n      committeeType\n      sourceUrl\n      members {\n        membershipKey\n        role\n        joinedDate\n        leftDate\n        isBureau\n        sourceUrl\n        member {\n          mandateKey\n          fullName\n          chamber\n          groupName\n        }\n      }\n      linkedBills {\n        billKey\n        plxNumber\n        plxYear\n        senateNumber\n        senateYear\n        title\n        finalLawNumber\n        finalLawYear\n        statusText\n        billType\n        lastEventDate\n      }\n      linkedBillsTotal\n      meetingsCount\n    }\n  }\n',
  },
  {
    file: 'parliament-queries.ts',
    name: 'PARLIAMENT_COMMITTEE_DOCUMENTS_QUERY',
    body: '\n  query ParliamentCommitteeDocuments(\n    $committeeKey: ID!\n    $first: Int\n    $after: String\n  ) {\n    parliamentCommittee(committeeKey: $committeeKey) {\n      committeeKey\n      documents(first: $first, after: $after) {\n        total\n        edges {\n          node {\n            committeeDocumentKey\n            title\n            docType\n            docDate\n            documentUrl\n            sourceUrl\n            billKey\n          }\n        }\n        pageInfo {\n          hasNextPage\n          endCursor\n        }\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-stenograms-queries.ts',
    name: 'PARLIAMENT_STENOGRAM_SESSIONS_QUERY',
    body: '\n  query ParliamentStenogramSessions(\n    $first: Int\n    $after: String\n    $filter: ParliamentStenogramSessionsFilter\n    $q: String\n  ) {\n    parliamentStenogramSessions(\n      first: $first\n      after: $after\n      filter: $filter\n      q: $q\n    ) {\n      total\n      totalEstimated\n      edges {\n        cursor\n        node { \n  sessionKey\n  chamber\n  sessionDate\n  sessionDateSource\n  title\n  sourceSystem\n  availability\n  sourceUrl\n  sourceUrlKind\n  sittingKey\n  presidingText\n  startTimeText\n  endTimeText\n  segmentCount\n  speechCount\n  speakerCount\n  sourceUpdatedAt\n  canonicalDigest\n  captureDigest\n }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-stenograms-queries.ts',
    name: 'PARLIAMENT_STENOGRAM_SESSION_QUERY',
    body: '\n  query ParliamentStenogramSession(\n    $sessionKey: ID!\n    $offset: Int\n    $limit: Int\n  ) {\n    parliamentStenogramSession(\n      sessionKey: $sessionKey\n      offset: $offset\n      limit: $limit\n    ) {\n      totalSegments\n      session { \n  sessionKey\n  chamber\n  sessionDate\n  sessionDateSource\n  title\n  sourceSystem\n  availability\n  sourceUrl\n  sourceUrlKind\n  sittingKey\n  presidingText\n  startTimeText\n  endTimeText\n  segmentCount\n  speechCount\n  speakerCount\n  sourceUpdatedAt\n  canonicalDigest\n  captureDigest\n }\n      segments { \n  segmentKey\n  sessionKey\n  position\n  kind\n  text\n  textChars\n  speakerName\n  speakerRef\n  mandateKey\n  speechKey\n  agendaRef\n  sourceUrl\n  sourceUrlKind\n  personId\n  speakerResolution\n  speakerMethod\n  speakerConfidence\n }\n      navigation {\n        previous { \n  sessionKey\n  chamber\n  sessionDate\n  title\n  availability\n  sourceUrl\n  sourceUrlKind\n }\n        next { \n  sessionKey\n  chamber\n  sessionDate\n  title\n  availability\n  sourceUrl\n  sourceUrlKind\n }\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-stenograms-queries.ts',
    name: 'PARLIAMENT_SPEECH_CONTEXT_QUERY',
    body: '\n  query ParliamentSpeechContext($speechKey: ID!) {\n    parliamentSpeechContext(speechKey: $speechKey) {\n      speechKey\n      session { \n  sessionKey\n  chamber\n  sessionDate\n  sessionDateSource\n  title\n  sourceSystem\n  availability\n  sourceUrl\n  sourceUrlKind\n  sittingKey\n  presidingText\n  startTimeText\n  endTimeText\n  segmentCount\n  speechCount\n  speakerCount\n  sourceUpdatedAt\n  canonicalDigest\n  captureDigest\n }\n      segment { \n  segmentKey\n  sessionKey\n  position\n  kind\n  text\n  textChars\n  speakerName\n  speakerRef\n  mandateKey\n  speechKey\n  agendaRef\n  sourceUrl\n  sourceUrlKind\n  personId\n  speakerResolution\n  speakerMethod\n  speakerConfidence\n }\n      previousContribution { \n  segmentKey\n  sessionKey\n  position\n  kind\n  text\n  textChars\n  speakerName\n  speakerRef\n  mandateKey\n  speechKey\n  agendaRef\n  sourceUrl\n  sourceUrlKind\n  personId\n  speakerResolution\n  speakerMethod\n  speakerConfidence\n }\n      nextContribution { \n  segmentKey\n  sessionKey\n  position\n  kind\n  text\n  textChars\n  speakerName\n  speakerRef\n  mandateKey\n  speechKey\n  agendaRef\n  sourceUrl\n  sourceUrlKind\n  personId\n  speakerResolution\n  speakerMethod\n  speakerConfidence\n }\n      redirect {\n        legacySpeechKey\n        sessionKey\n        canonicalSpeechKey\n        canonicalSegmentKey\n        canonicalPosition\n        mappingKind\n        matchMethod\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-speeches-queries.ts',
    name: 'PARLIAMENT_SPEECHES_QUERY',
    body: '\n  query ParliamentSpeeches(\n    $first: Int\n    $after: String\n    $filter: ParliamentSpeechesFilter\n    $q: String\n  ) {\n    parliamentSpeeches(first: $first, after: $after, filter: $filter, q: $q) {\n      total\n      totalEstimated\n      searchDepth\n      edges {\n        cursor\n        node {\n          speechKey\n          spokenAt\n          title\n          summary\n          chamber\n          sourceUrl\n          sourceUrlKind\n          fullText\n          isCanonical\n          sessionKey\n          position\n          speakerName\n          member {\n            mandateKey\n            fullName\n            chamber\n            groupName\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-speeches-queries.ts',
    name: 'PARLIAMENT_SPEECH_ACTIVITY_QUERY',
    body: '\n  query ParliamentSpeechActivity(\n    $year: Int!\n    $filter: ParliamentSpeechesFilter\n    $q: String\n  ) {\n    parliamentSpeechActivity(year: $year, filter: $filter, q: $q) {\n      year\n      availableYears\n      searchDepth\n      days {\n        date\n        total\n        proprie\n        comun\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-speeches-queries.ts',
    name: 'PARLIAMENT_SPEECH_QUERY',
    body: '\n  query ParliamentSpeech($speechKey: ID!) {\n    parliamentSpeech(speechKey: $speechKey) {\n      speechKey\n      spokenAt\n      title\n      summary\n      chamber\n      sourceUrl\n      sourceUrlKind\n      fullText\n      isCanonical\n      sessionKey\n      position\n      speakerName\n      member {\n        mandateKey\n        fullName\n        chamber\n        groupName\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-agenda-queries.ts',
    name: 'PARLIAMENT_AGENDAS_QUERY',
    body: '\n  query ParliamentAgendas($filter: ParliamentAgendaFilter, $offset: Int, $limit: Int) {\n    parliamentAgendas(filter: $filter, offset: $offset, limit: $limit) {\n      total\n      nodes {\n        \n  agendaKey\n  chamber\n  title\n  approvedDate\n  approvedDateText\n  pdfUrl\n  sourceUrl\n  itemCount\n  billCount\n  namedBillCount\n  sittings {\n    sittingKey\n    chamber\n    date\n    dateSource\n    title\n    stenogramSessionKey\n    resolutionStatus\n  }\n\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-agenda-queries.ts',
    name: 'PARLIAMENT_AGENDA_QUERY',
    body: '\n  query ParliamentAgenda($agendaKey: ID!) {\n    parliamentAgenda(agendaKey: $agendaKey) {\n      agenda {\n        \n  agendaKey\n  chamber\n  title\n  approvedDate\n  approvedDateText\n  pdfUrl\n  sourceUrl\n  itemCount\n  billCount\n  namedBillCount\n  sittings {\n    sittingKey\n    chamber\n    date\n    dateSource\n    title\n    stenogramSessionKey\n    resolutionStatus\n  }\n\n      }\n      items {\n        agendaItemKey\n        rowIndex\n        numberText\n        itemKind\n        billKey\n        billLabel\n        billFamily\n        titleText\n        descriptionText\n        lawCategory\n        senateDisposition\n        senateDispositionDate\n        committeeRapporteurs\n        procedureUrgency\n        decisionalChamber\n        debateReservation\n        resolutionStatus\n        documents {\n          url\n          label\n          date\n          manifestSide\n        }\n      }\n    }\n  }\n',
  },
  {
    file: 'parliament-agenda-queries.ts',
    name: 'PARLIAMENT_BILL_SCHEDULING_QUERY',
    body: '\n  query ParliamentBillScheduling($billKey: ID!) {\n    parliamentBillScheduling(billKey: $billKey) {\n      agendaKey\n      agendaItemKey\n      agendaTitle\n      sittingKey\n      sittingDate\n      sittingDateSource\n      chamber\n      relationshipKind\n      resolutionStatus\n      itemNumberText\n      stenogramSessionKey\n    }\n  }\n',
  },
];
