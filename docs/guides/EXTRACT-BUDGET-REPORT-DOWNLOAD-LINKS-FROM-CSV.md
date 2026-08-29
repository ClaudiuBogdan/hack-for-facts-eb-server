# Extract budget-report XML and spreadsheet links from a CSV

## Goal

For every CSV row, query the development GraphQL API for the report belonging to
one institution, report type, and report date, then retain the public XML and
Excel download links.

This procedure uses:

- endpoint: `https://api-dev.transparenta.eu/graphql`
- query: `reports`
- exact institution key: `entity_cui`
- exact report-type key: the GraphQL `ReportType` enum
- inclusive date filters: `report_date_start` and `report_date_end`
- public file field: `download_links`

`file_source` is an internal source/object path. It is useful for lineage, but it
is not the public download URL and must not be used in place of
`download_links`.

## Recommended CSV contract

Use these required columns:

```csv
institution_cui,report_type,report_date
3228381,DETAILED,2026-06-30
```

Rules:

- Keep `institution_cui` as a string. Do not let spreadsheet software convert it
  to a floating-point number or scientific notation.
- Use `YYYY-MM-DD` for `report_date`.
- Use one of the GraphQL enum values below for `report_type`.
- If the source CSV contains only institution names, resolve and review the CUI
  first. A name is not an exact substitute for `entity_cui`, and fuzzy name
  matching should not silently choose an institution.

## Report-type values

| GraphQL value                     | Meaning in the database                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `DETAILED`                        | Executie bugetara detaliata                                |
| `PRINCIPAL_AGGREGATED`            | Executie bugetara agregata la nivel de ordonator principal |
| `SECONDARY_AGGREGATED`            | Executie bugetara agregata la nivel de ordonator secundar  |
| `COMMITMENT_DETAILED`             | Executie - Angajamente bugetare detaliat                   |
| `COMMITMENT_PRINCIPAL_AGGREGATED` | Executie - Angajamente bugetare agregat principal          |
| `COMMITMENT_SECONDARY_AGGREGATED` | Executie - Angajamente bugetare agregat secundar           |

Do not send the Romanian database label as the GraphQL variable. Send the enum
value from the first column.

## Verified GraphQL query

Send an HTTP `POST` with `Content-Type: application/json`:

```graphql
query GetInstitutionReportFiles($cui: String!, $reportType: ReportType!, $date: String!) {
  reports(
    filter: {
      entity_cui: $cui
      report_type: $reportType
      report_date_start: $date
      report_date_end: $date
    }
    limit: 100
    offset: 0
  ) {
    nodes {
      report_id
      entity_cui
      report_type
      report_date
      reporting_year
      reporting_period
      file_source
      download_links
    }
    pageInfo {
      totalCount
      hasNextPage
    }
  }
}
```

Variables for the sample CSV row:

```json
{
  "cui": "3228381",
  "reportType": "DETAILED",
  "date": "2026-06-30"
}
```

The complete HTTP JSON body has three top-level fields:

```json
{
  "operationName": "GetInstitutionReportFiles",
  "query": "<the GraphQL query above>",
  "variables": {
    "cui": "3228381",
    "reportType": "DETAILED",
    "date": "2026-06-30"
  }
}
```

Using variables is important: it avoids constructing GraphQL source text from
CSV values and keeps validation in the GraphQL type system.

## Per-row processing procedure

For each CSV row:

1. Trim the three required values and validate them before calling the API.
   Require a non-empty CUI, one of the six report-type enum values, and a real
   ISO calendar date.
2. Build the JSON request body with the row values in `variables`.
3. Send a `POST` to the endpoint. Set `Accept: application/json` and
   `Content-Type: application/json`. The optional
   `x-apollo-operation-name` header may be set to
   `GetInstitutionReportFiles` for explicit operation identification.
4. Treat a non-2xx HTTP response as a request failure. Also inspect the top-level
   GraphQL `errors` array even when the HTTP status is 200.
5. Read `data.reports.nodes`. An empty array is a valid “no matching report”
   result, not a parsing failure.
6. If `pageInfo.hasNextPage` is true, repeat the same request with `offset`
   increased by the number of nodes already received. Keep `limit` bounded; 100
   is sufficient for the exact filter in normal use.
7. For every returned report, inspect each string in `download_links`:
   - XML: URL pathname ends in `.xml`, case-insensitively.
   - spreadsheet: URL pathname ends in `.xls` or `.xlsx`,
     case-insensitively.
   - ignore `.pdf` and unrelated formats for this task.
8. Deduplicate identical URLs while preserving the association with
   `report_id`.
9. Write the result and an explicit status such as `matched`, `no_report`, or
   `report_without_requested_file`.

Use a URL parser and test the URL pathname, rather than testing the complete
string. This continues to work when a server adds query parameters after the
extension.

Although the request asks for “XLS”, the live report tested below exposes an
`.xlsx` workbook. The spreadsheet rule must therefore accept both `.xls` and
`.xlsx`.

### Recommended output shape

A normalized, one-file-per-row output avoids losing data if one report contains
multiple files of the same format:

```csv
input_row,institution_cui,report_type,report_date,report_id,file_format,download_url,status
2,3228381,DETAILED,2026-06-30,ffff306bf02ba18e226211100ca7c3dfa16e39b9a57bc8b25a6610e8c56944bb,xlsx,https://static.anaf.ro/...,matched
2,3228381,DETAILED,2026-06-30,ffff306bf02ba18e226211100ca7c3dfa16e39b9a57bc8b25a6610e8c56944bb,xml,https://static.anaf.ro/...,matched
```

If downstream consumers require one row per input institution, use `xml_urls`
and `spreadsheet_urls` columns that serialize all matching URLs, rather than
silently keeping only the first.

## Optional file-delivery verification

Link extraction and file downloading should be separate steps. If the workflow
must prove that a link currently serves a file:

1. Follow redirects.
2. Try `HEAD`.
3. If the host does not support `HEAD`, issue a small ranged `GET`; if ranges are
   not supported, stream the response with a strict byte/time limit.
4. Accept these expected content types:
   - XML: `application/xml` or `text/xml`
   - XLS: `application/vnd.ms-excel`
   - XLSX:
     `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
5. Record a delivery failure separately from a GraphQL no-match. The report may
   exist in the registry even if an upstream host is temporarily unavailable.

Do not download every file merely to extract its URL.

## Live verification

Verified on 2026-07-28 against
`https://api-dev.transparenta.eu/graphql`.

The exact sample filter:

- `entity_cui`: `3228381`
- `report_type`: `DETAILED`
- `report_date_start`: `2026-06-30`
- `report_date_end`: `2026-06-30`

returned one report:

- report ID:
  `ffff306bf02ba18e226211100ca7c3dfa16e39b9a57bc8b25a6610e8c56944bb`
- `pageInfo.totalCount`: `1`
- `pageInfo.hasNextPage`: `false`
- `report_date`: `1782777600000`, which is the Unix-millisecond
  representation of `2026-06-30T00:00:00.000Z`
- spreadsheet:
  `https://static.anaf.ro/rapfxb/LOT723/20260630_FXB-EXB-900_TREZ181_4192812_3228381_01_125496009.xlsx`
- XML:
  `https://static.anaf.ro/rapfxb/LOT723/20260630_FXB-EXB-900_TREZ181_4192812_3228381_01_125496008.xml`

Both public URLs were then checked directly:

| File | HTTP status | Content-Type                                                        | Content-Length | Body signature                     |
| ---- | ----------: | ------------------------------------------------------------------- | -------------: | ---------------------------------- |
| XLSX |         200 | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |   27,027 bytes | ZIP/Office Open XML, `50 4b 03 04` |
| XML  |         200 | `application/xml`                                                   |   35,511 bytes | XML declaration, `<?xml`           |

This verifies both the GraphQL lookup and delivery of the actual XML/XLSX files,
not only the presence of URL-shaped strings.

## Operational notes

- A plain `GET` to `/graphql` is not the report lookup. Use a JSON `POST`.
- Live introspection is disabled, so clients should keep the reviewed query as a
  checked-in operation instead of discovering the schema at runtime.
- The endpoint returned an `x-ratelimit-limit` of 300 requests per minute during
  verification. Treat the headers as authoritative, throttle below the current
  limit, and honor `429` plus `Retry-After` if returned.
- Cache results for duplicate `(institution_cui, report_type, report_date)`
  tuples in the input CSV.
- Keep the original input row number in success and error records so a failed
  lookup can be traced without rereading the entire CSV.
- Never infer success solely from HTTP 200: GraphQL can return HTTP 200 with a
  top-level `errors` array.
