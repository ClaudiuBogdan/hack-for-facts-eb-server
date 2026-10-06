# Public-enterprise database contract

Run `pnpm test:public-enterprises-contract` with `PUBLIC_ENTERPRISES_DATA_REPO`
pointing at an installed scraper checkout and `TEST_DATABASE_URL` pointing at
disposable PostgreSQL 18. Use the Zeus agents Docker instance for local work.
Never provide a serving or raw database URL. Missing prerequisites fail the
command.

The scraper's PG fixture creates and drops its own uniquely named database. The
test applies the real public-enterprise migrations (`20260629T160000`, the
`20260630T120000` cutover and the `20261006T180000` public read views) and
inserts reviewed literal rows. The server repository connects separately as a
role that can read only the five public views. Kernel identity is an in-memory
fake.

Cases cover the view-only reader, source-lane availability, literal profile and
indicator values (exact decimals, `''` versus null, null `textValue`), list and
indicator pagination with stale-cursor rejection, privacy withdrawal of an
anchor, fact, evidence, dictionary entry or snapshot, and GraphQL/MCP
equivalence.

Run this command before publishing changes to the public-enterprise module or
its SQL contract, and record both `git rev-parse HEAD` values. Server CI cannot
check out the private scraper repository, so this is a local release gate. No
migration runs from the server or from the running API.
