# NGO database contract

Run `pnpm test:ngo-contract` with `NGO_DATA_REPO` pointing at an installed scraper
checkout and `TEST_DATABASE_URL` pointing at disposable PostgreSQL 18/pgvector.
Use the Zeus agents Docker instance for local work. Never provide a serving or raw
database URL. Missing prerequisites fail the command.

The scraper fixture creates and drops its own uniquely named database, applies the
real migrations, and inserts synthetic rows. The actual server repository uses a
separate connection with the minimal reader role. Tests cover profile mapping,
exact monetary strings, dictionary labels, privacy withdrawal, year filtering and
private-relation denial. The scraper's own 14-case SQL suite covers identity and
release guards using the same fixture.

Run this command before publishing changes to the NGO module or its SQL contract.
Record both `git rev-parse HEAD` values and any uncommitted changes with the result.
It is a local release gate today: server CI has no cross-repository credential for
the private scraper repository. Automating that checkout is deferred until such
access is approved. No production migration runs from this test or from the server.
