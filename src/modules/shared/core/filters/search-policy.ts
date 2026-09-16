export type SearchPolicy = 'baseline' | 'prefix-all';

export const BASE_SEARCH_FIELDS = ['identifier_exact', 'identifiers', 'title', 'aliases'] as const;

/** Engine admits ten terms. Count punctuation/letter-digit boundaries conservatively. */
export function searchQueryProblem(
  q: string,
  policy: SearchPolicy = 'baseline'
): string | undefined {
  // Frozen 251-query benchmark max: 66 bytes. Leave room for long legal names,
  // but bound work before normalization/tokenization; revalidate at full scale.
  if (new TextEncoder().encode(q).length > 2048) return 'Search query exceeds 2048 bytes';
  if (
    Array.from(q).some((char) => {
      const code = char.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  )
    return 'Search query contains unsupported control characters';
  if ((q.match(/"/gu)?.length ?? 0) % 2 !== 0) return 'Close the quoted phrase before searching';
  if (/(^|[^\p{L}\p{N}])-\S/u.test(q)) return 'Negative search terms are not supported';
  const folded = q
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
  // Latin names, contiguous digits, and individual other letters. The latter
  // deliberately overcounts scripts whose tokenizer may split an unspaced run.
  const terms = folded.match(/\p{Script=Latin}+|\p{N}+|\p{L}/gu) ?? [];
  // Prefix mode pins Romanian tokenization. Baseline retains legacy engine
  // detection and its ten-word limit for a behavior-compatible rollback.
  if (policy === 'prefix-all' && terms.length > 10)
    return 'Use at most 10 search terms; punctuation separates terms';
  if (q.trim() !== '' && terms.length === 0) return 'Enter a name or identifier';
  return undefined;
}

export function searchRequestPolicy(q: string, policy: SearchPolicy = 'baseline') {
  return {
    ...(policy === 'prefix-all' ? { locales: ['ron'] } : {}),
    matchingStrategy: policy === 'baseline' ? 'last' : 'all',
    attributesToSearchOn:
      policy === 'prefix-all' && !q.includes('"')
        ? [...BASE_SEARCH_FIELDS, 'name_prefixes']
        : [...BASE_SEARCH_FIELDS],
  } as const;
}
