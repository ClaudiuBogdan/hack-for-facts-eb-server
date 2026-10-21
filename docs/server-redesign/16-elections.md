# 16 — Elections

> Conforms to [`00-foundation-shared-kernel.md`](./00-foundation-shared-kernel.md),
> with the one deviation stated in §6. Module: `src/modules/elections/`. Flag:
> `ELECTIONS_ENABLED` (default `false`; `true` only in the Chronos dev overlay).

## 1. Summary & data status

Romanian election results, party-level: votes and mandates per competitor, turnout
and coverage at UAT, county, diaspora and national scope, for every event the
scrapper has published in its serving model (scrapper
`prod-db/elections-strategy/SERVING_MODEL_DESIGN.md`, prod migration
`20261020T140000__elections_serving_generations`). On 2026-10-21 these are
`ro:local:2024` and `ro:parliamentary:2020`; further events arrive as the scrapper
publishes them. The legacy `elections.result_rows` table and the catalog and county
source report over it were retired on 2026-10-21 (user decision; scrapper prod
migration `20261021T090000`).

The scrapper owns the data and the decisions behind it. Each event has one active,
audited generation; the server reads only that generation.

## 2. Schema → domain model

| Source                                                 | Model (`core/types.ts`)                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `serving_active` (event, publication, activation time) | `ElectionEvent.publication`                                              |
| `serving_occurrences` + contest counts per office      | `ElectionOccurrence` (one ballot day; round and kind are attributes)     |
| `serving_contests` + `core.territories` names          | `ElectionContest`, `ElectionPlace`                                       |
| `serving_competitors`                                  | `ElectionCompetitor` (party and minority keys are the spine `actor_key`) |
| `result_tallies`                                       | `ElectionTally` (votes, and mandates per allocation phase)               |
| `turnout_figures`                                      | `ElectionTurnoutFigure`                                                  |
| `figure_coverage`                                      | `ElectionCoverageCell`                                                   |

Every read first resolves the active publication of its event (through the
`active_*` views), then reads that publication's rows by `publication_id`, in one
read-only, repeatable-read transaction with a 5 s statement timeout. An event's
family and year are parts of its key (`ro:<family>:<year>[:<first ballot date>]`).
Place names come from `core.territories` by SIRUTA or county code; diaspora and
national have none, nor does a retired SIRUTA.

Not served: candidate tallies and candidacy names (results stay party-level, a
user decision of 2026-10-20; independents appear as competitors under their ballot
label), decision ids, source pointers, the generation's source selections (until a
public provenance contract exists), manifests, `attrs` and inactive generations.

## 3. Figure rules

- Values are non-negative integers served as decimal strings; 0 means the source
  printed 0, and a missing figure has no row. Every figure keeps its status
  (`VERIFIED`, `UNCHECKED`, `SUSPECT`), construction, source level, finality,
  completeness, diaspora inclusion and issues.
- Issues are public codes (`ELECTION_ISSUE_CODES`): only `MISSING_SCOPE` keeps its
  detail, a place key. Any other detail can name an internal decision and is
  dropped; an unknown code fails the response.
- A vote share is of the same scope's valid votes, only when both count the same
  voters (completeness, missing places, diaspora inclusion, all voters).
- Participation (voted / registered) only when both are complete, unflagged and not
  SUSPECT, and never for the diaspora (its registration does not bound it).
- A race (leader, runner-up, margin in votes and points, tie) only inside a
  contest, only when every vote tally of the place counts the same voters and none
  is SUSPECT; it carries their status, completeness, finality and issues. A leader
  is never a winner; votes are never mandates; mandate phases are never summed.
- All arithmetic is integer (BigInt); percentages round half-up to two decimals.

## 4. Surfaces

| REST (`/api/v1/elections`)                                                   | GraphQL                | MCP                           |
| ---------------------------------------------------------------------------- | ---------------------- | ----------------------------- |
| `GET /events`                                                                | `electionEvents`       | `list_election_events`        |
| `GET /events/lookup?eventKey`                                                | `electionEvent`        | `get_election_event`          |
| `GET /contests?occurrenceKey&offices&statuses&jurisdictionTypes&countyCodes` | `electionContests`     | `list_election_contests`      |
| `GET /contests/lookup?contestKey`                                            | `electionContest`      | —                             |
| `GET /results/lookup?occurrenceKey&office&scopeKey[&contestKey]`             | `electionResult`       | `get_election_result`         |
| `GET /results?occurrenceKey&office&scopeType[&contestKey]`                   | `electionResultScopes` | `list_election_result_scopes` |
| `GET /competitors?eventKey&kinds`                                            | `electionCompetitors`  | `list_election_competitors`   |

All three call the same usecases. REST decodes the query, checks it against a
TypeBox schema per route, and answers with the shared envelope and
`Cache-Control: no-store`.

## 5. Tests

- Unit: `tests/unit/elections/` (figure rules, keys, usecases, compiled SQL over a
  capturing driver).
- Integration: `tests/integration/elections/` (REST, GraphQL and MCP parity over an
  in-memory repository; the real composition mount).
- Real DDL: `tests/e2e/elections-results.test.ts` with
  `vitest.elections-e2e.config.ts`. It applies the two digest-pinned scrapper
  migrations on an external fixture database (`TEST_DATABASE_URL`,
  `ELECTIONS_TEST_FIXTURE_ID`, `SCRAPPER_REPO_ROOT`) and seeds an active
  generation, an inactive sealed generation and an unactivated event.

## 6. Deviation: offset pages on every surface

Foundation §5.3 lets each endpoint choose offset or cursor pagination and §14.4
admits offset with a total where the count is cheap; §6.2 asks GraphQL lists for
Relay connections backed by the REST cursor. Every elections list is a bounded
collection of one active generation with an indexed, exact count (events: a
handful; contests of one occurrence, places of one office, competitors of one
event: at most a few thousand), so REST uses offset pages: `page` ≥ 1, `pageSize`
from 1 to 100, exact `total`. GraphQL and MCP expose the same offset page instead
of a Relay connection, so one page means the same items on all three surfaces.
This is the module's one deviation; a cursor would replace it if a list grows
beyond a cheap exact count.
