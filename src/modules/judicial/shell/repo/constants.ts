/**
 * Judicial module — the loader↔server privacy contract constants (plan 08 §3.1).
 *
 * `PUBLISHABLE_RULES` mirrors the scrapper loader's high-precision publishable
 * subset of `case_parties.classifier_rule`. The server RE-ASSERTS this predicate
 * at read time (inside `PartyDictionaryRepo.getPublishableName`) so it never
 * trusts the loader alone.
 *
 * `CLASSIFIER_VERSION` is the version this rule set is valid for. If the server
 * reads a `case_parties.classifier_version` it does not recognize, the gate
 * SELF-DISABLES (returns no name + a caveat) rather than risk widening — a loader
 * vocabulary change cannot silently leak (§3.1 req 1).
 */

/**
 * The high-precision classifier rules that make a `name_key_id` PUBLISHABLE.
 * EXCLUDES the risky `I.I.` double-initial rule and the weak `fallback`/
 * `person_shape` rules (those yield kind='company' but name_key_id=NULL until
 * gate #9 promotes them).
 */
export const PUBLISHABLE_RULES = [
  'company_legal_form',
  'org_form',
  'insolvency_marker',
  'public_entity_anchor',
] as const;

/** The classifier version the `PUBLISHABLE_RULES` set is valid for. */
export const CLASSIFIER_VERSION = 'party-kind-v0';

/** Party kinds whose names may ever be published (mirrors the dictionary DB CHECK). */
export const PUBLISHABLE_PARTY_KINDS = ['company', 'public_entity'] as const;

/** The ONLY `party_company_candidates.validation_status` the server treats as fact. */
export const PUBLISHED_STATUS = 'published';

/** `case_legal_references.source_field` value that must NOT surface (its span is a forbidden column). */
export const FORBIDDEN_REF_SOURCE_FIELD = 'solution_summary';
