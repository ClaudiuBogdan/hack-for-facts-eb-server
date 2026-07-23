# B2-F1 — Parliament member speeches/control-items offset pagination has no unique tiebreak

|                       |                                                        |
| --------------------- | ------------------------------------------------------ |
| **Original severity** | Medium                                                 |
| **Verified verdict**  | Confirmed · Severity unchanged (Medium)                |
| **Confidence**        | CONFIRMED                                              |
| **Domain**            | correctness                                            |
| **Modules / files**   | `src/modules/parliament/shell/repo/parliament-repo.ts` |
| **Fix effort**        | S                                                      |
| **Merge-blocker?**    | no (owner-call — data-correctness, user-visible)       |

## TL;DR

Two offset-paginated member-activity queries — `listMemberSpeeches` (`order by s.spoken_at desc`) and `listMemberControlItems` (`order by c.item_date desc`) — sort on a **non-unique** date column with no secondary tiebreak. Under Postgres, rows that share the same date are returned in an unstable order across `LIMIT/OFFSET` pages, so rows straddling a page boundary get **skipped or duplicated**. The sibling `listMemberInitiatives` was explicitly patched for exactly this bug (`.orderBy('mi.initiative_key','desc')`) but the fix was never propagated. One-line fix: append `.orderBy('s.speech_key','desc')` and `.orderBy('c.item_key','desc')` (both are the tables' unique/PK columns already in the SELECT).

## Evidence (re-verified against current code)

`listMemberControlItems` — `parliament-repo.ts:1501-1531`:

```ts
.where('c.mandate_key', '=', mandateKey)
.orderBy('c.item_date', 'desc')      // :1519  ← non-unique, NO tiebreak
.limit(p.pageSize)
.offset(offsetFor(p))                // :1521  ← offset pagination
```

`c.item_key` is selected at :1508 (the unique key) but never used in ORDER BY.

`listMemberSpeeches` — `parliament-repo.ts:1533-1557`:

```ts
.where('s.mandate_key', '=', mandateKey)
.where('s.quarantined', '=', false)
.where(sql`coalesce(s.privacy_class, 'public') = 'public'`)
.orderBy('s.spoken_at', 'desc')      // :1543  ← non-unique, NO tiebreak
.limit(p.pageSize)
.offset(offsetFor(p))                // :1545  ← offset pagination
```

`s.speech_key` is in `SPEECH_SELECT` but not in ORDER BY.

The **fixed** sibling, `listMemberInitiatives` — `parliament-repo.ts:1919-1966`, with a comment naming the audit bug:

```ts
.orderBy(sql`${regDateIso} desc nulls last`)
.orderBy('mi.initiative_key', 'desc')  // :1954 — UNIQUE (PK) tiebreak → TOTAL order (stable offset pagination)
```

Comment at :1930-1933: _"then initiative_key DESC as a UNIQUE (PK) tiebreak → TOTAL order (stable offset pagination). The OLD `initiative_key ASC` surfaced NULL-date legacy items on page 1 … (audit bug)."_ — the same class of bug, already recognised and fixed here only.

Contrast with the **cursor** speech path `listMemberSpeechesCursor` (:1562+) which does it right: `order by coalesce(s.spoken_at::text,'') desc, s.speech_key desc` (:1604) — keyset on `(spoken_at, speech_key)`. So the correct ordering shape already exists in the same file; the offset legacy queries simply don't use it.

## Root cause

`LIMIT/OFFSET` pagination requires a **total order** in the ORDER BY to be stable across pages. When the sort key (`spoken_at` / `item_date`) has ties, Postgres is free to return tied rows in any order per query execution; a row that was the last of page N can reappear as the first of page N+1 (duplicate) or be jumped over (skip). The date columns are additionally sparse/nullable — many rows can share a date (or NULL). The fix template already lives one function away.

## Blast radius & impact

- **Reachable via GraphQL, client-controlled offsets:**
  - `ParliamentMember.controlItems(page, pageSize)` → resolver `parliament-repo`… `resolvers.ts:572` → `getMemberControlItems` → `listMemberControlItems`.
  - `ParliamentMember.speeches(page, pageSize)` — the **LEGACY** offset field (`typedefs.ts:177-178`, "kept for existing callers") → `resolvers.ts:584` → `getMemberSpeeches` → `listMemberSpeeches`.
- Per-mandate speech volume is large (repo comment at :1559: _"~35k rows (median 72)"_), and any single busy plenary day yields many `spoken_at` ties → high probability of straddled boundaries for prolific members.
- **Impact:** a client paging through a member's speeches/control items can silently miss interventions or see the same one twice. Data-integrity/trust bug on a public transparency surface; not a crash, not a security leak. Counts (`total`) stay correct; only the paged windows drift.
- **Bounded by:** the newer `speechesConnection` (cursor) field is unaffected — only the legacy offset `speeches` and `controlItems` fields are wrong. Single-page reads (result set ≤ pageSize) never trip it.

## Reproduction / falsifiable scenario

Pick a member with ≥ `pageSize+1` control items where the `pageSize`-th and `pageSize+1`-th rows share `item_date`:

```graphql
{
  parliamentMember(mandateKey: "…") {
    a: controlItems(page: 1, pageSize: 20) {
      items {
        itemKey
        itemDate
      }
    }
    b: controlItems(page: 2, pageSize: 20) {
      items {
        itemKey
        itemDate
      }
    }
  }
}
```

Run twice. Because tied `item_date` rows have no deterministic order, the union of `a`+`b` `itemKey`s can differ between runs and/or the boundary `itemKey` can appear in both `a` and `b` or in neither. With a stable tiebreak the two runs are identical and partition the set exactly.

## Additional context discovered

- **Scan of every other offset-paginated list in the module** (all `.offset(` sites):
  - `:463` member list — `orderBy` ends with `m.mandate_key asc` in **both** sort branches (:454-456) → has unique tiebreak. **Safe.**
  - `:935` bills list — `billOrderBy(sort)` (:900-915) appends `b.bill_key asc` in **every** branch → **safe.**
  - `:2255` person-committee list — `order by pc.mandate_key asc` only. `mandate_key` is likely **not** unique in a person↔committee mapping (a member can hold multiple seats), so this is a **possible secondary instance** of the same bug — lower confidence, worth a glance; not in the original finding.
  - `:1956` initiatives — already fixed (`mi.initiative_key desc`).
  - `listMemberDeclarations` (:1968) returns all rows unpaginated → N/A.
- No test pins page-boundary stability for these lists (grep of `tests/` finds no offset-partition assertions for member speeches/control items).
- `speech_key` and `item_key` are both already projected in the respective SELECTs, so the fix needs no extra columns and no index change (`speeches_mandate_idx` referenced at :1561 already orders by `(mandate_key, spoken_at, speech_key)` per the cursor comment).

## Fix options

- **Option A (recommended):** append the unique key to each ORDER BY:
  - `listMemberSpeeches`: add `.orderBy('s.speech_key', 'desc')` after :1543.
  - `listMemberControlItems`: add `.orderBy('c.item_key', 'desc')` after :1519.
    Mirrors the initiatives fix (:1954) and the cursor path (:1604). Zero API/shape change; index-friendly if a matching `(mandate_key, date desc, key desc)` index exists (else still correct, just possibly a sort node).
- **Option B:** migrate the legacy offset `speeches`/`controlItems` fields to keyset/cursor like `speechesConnection`. Correct long-term but larger blast radius (schema + client changes) — overkill for a one-line correctness fix; defer.
- **Test to pin it:** an e2e/integration test that seeds a member with tied dates spanning a page boundary and asserts `page1 ∪ page2` is a duplicate-free exact partition.

## Related

- Sibling fixed precedent: `listMemberInitiatives` (`parliament-repo.ts:1919-1966`).
- Correct cursor precedent: `listMemberSpeechesCursor` (`parliament-repo.ts:1562+`).
- Main report: B2 (parliament) findings.
