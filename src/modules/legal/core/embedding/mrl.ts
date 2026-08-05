/**
 * Qwen3 embedding conventions — PORTED VERBATIM from the scrapper's
 * `src/embeddings/qwen3.ts` (the corpus side). These are a FROZEN retrieval
 * contract: the corpus vectors in `legal-sections-*` were produced with
 * exactly these strings and exactly this truncation, so any drift here
 * silently degrades retrieval without a single error. The port is pinned by
 * `tests/fixtures/legal/tldf/mrl-qwen3-100023-win1.json` — a real
 * 4096-dim corpus vector and its scrapper-produced 1024-dim truncation —
 * with FLOAT EQUALITY in `tests/unit/legal/tldf-fixtures.test.ts`.
 *
 * Query side: documents are embedded WITHOUT an instruction prefix; queries
 * carry the English task instruction below (Qwen3-Embedding model card), and
 * the query text goes through the SAME normalization as the corpus.
 */

import { err, ok, type Result } from 'neverthrow';

export const QWEN3_MODEL_ID = 'Qwen/Qwen3-Embedding-8B';
export const QWEN3_RAW_DIMENSIONS = 4096;
export const QWEN3_QUERY_TEMPLATE_VERSION = 'qwen3-instruct/v1';

/** Task instructions for the two legal retrieval surfaces (byte-frozen). */
export const QWEN3_QUERY_TASKS = {
  legalDoc:
    'Given a Romanian legal research query, retrieve the most relevant Romanian legal acts by their summaries.',
  legalSection:
    'Given a Romanian legal question, retrieve the most relevant Romanian statutory provisions, articles, and paragraphs.',
} as const;

export function buildQwen3QueryInput(taskInstruction: string, query: string): string {
  return `Instruct: ${taskInstruction}\nQuery: ${normalizeEmbeddingInput(query)}`;
}

/**
 * Legacy Romanian cedilla codepoints → the standard comma-below forms.
 * `ş`/`ţ` (U+015F/U+0163) are visually the SAME letters as `ș`/`ț`
 * (U+0219/U+021B) but distinct codepoints NFC does not unify; ~93% of the
 * legal corpus is stored with the legacy cedilla while modern keyboards emit
 * comma-below. Canonicalizes (never strips) — applied identically corpus-side.
 */
const ROMANIAN_CEDILLA_TO_COMMA: Record<string, string> = {
  ş: 'ș', // ş → ș
  Ş: 'Ș', // Ş → Ș
  ţ: 'ț', // ţ → ț
  Ţ: 'Ț', // Ţ → Ț
};

export function normalizeEmbeddingInput(text: string): string {
  return text
    .normalize('NFC')
    .replaceAll(/[ŞşŢţ]/gu, (ch) => ROMANIAN_CEDILLA_TO_COMMA[ch] ?? ch)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll(/(?<=\p{L})-\n(?=\p{L})/gu, '')
    .replaceAll(/[ \t]+/g, ' ')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

export interface MrlDimensionError {
  readonly reason: 'mrl_dimension_error';
  readonly message: string;
}

/**
 * Matryoshka truncation: keep the first `dims` components, then L2-normalize.
 * Valid for Qwen3 embeddings (MRL-trained); renormalization is required —
 * a truncated prefix is no longer unit-norm.
 *
 * Numerically identical to the scrapper original; only the invalid-dims
 * signal differs (the scrapper lane throws and aborts, this core returns
 * `Result` per the server core contract). The fixture pin covers the numeric
 * path float-for-float.
 */
export function truncateAndRenormalize(
  vector: number[],
  dims: number
): Result<number[], MrlDimensionError> {
  if (dims <= 0 || dims > vector.length) {
    return err({
      reason: 'mrl_dimension_error',
      message: `Cannot truncate a ${String(vector.length)}-dim vector to ${String(dims)} dims.`,
    });
  }
  const prefix = vector.slice(0, dims);
  let sumSquares = 0;
  for (const value of prefix) {
    sumSquares += value * value;
  }
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) {
    return ok(prefix);
  }
  return ok(prefix.map((value) => value / norm));
}

export function l2Norm(vector: number[]): number {
  let sumSquares = 0;
  for (const value of vector) {
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares);
}
