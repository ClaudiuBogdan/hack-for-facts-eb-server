/**
 * Identifier source port. Core use-cases receive an IdGenerator instead of
 * calling `crypto.randomUUID()` so created records have assertable IDs in
 * tests.
 *
 * Production adapter: `uuidIds` in `src/infra/ids` (core cannot import it —
 * the infra boundary keeps core pure).
 */
export interface IdGenerator {
  newId(): string;
}
