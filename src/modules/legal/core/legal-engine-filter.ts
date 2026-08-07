/**
 * Translate a validated `FilterInput` into the engine's filter shape.
 *
 * The dangerous failure here is silent breadth. If the caller asks for
 * `fiscalImpactNull` or an `exclude` clause and this translator quietly drops
 * it, the engine answers a BROADER question than the one asked and the extra
 * rows look exactly like legitimate hits. So every field this cannot express is
 * NAMED in `unsupported`, and the caller refuses the request rather than
 * serving a wider answer under a narrower label.
 *
 * The §5.2-C live-status default lives here too: with `includeHistorical=false`
 * and no explicit status filter, the engine leg carries the same status
 * restriction the SQL path applies, so the two surfaces agree on what "current
 * law" means.
 */

import type { LegalEngineFilter } from './legal-opensearch-query.js';
import type { FilterInput } from '@/modules/shared/index.js';

/**
 * Acts with these statuses are "live" (§5.2-C). ONE definition, shared by the
 * SQL retrieval paths and the engine filter — two copies would drift into two
 * different meanings of "in force".
 */
export const LEGAL_LIVE_STATUSES: readonly string[] = [
  'in-vigoare',
  'modificat',
  'abrogat-partial',
  'suspendat',
  'necunoscut',
];

/**
 * Field → the operators THAT FIELD can express, not a global allowlist. A
 * shared set let `actType: { contains: 'leg' }` — which MCP accepts, since its
 * filter input is an open record — translate into an EXACT terms filter, so a
 * substring request came back as an equality answer with no warning.
 */
const FIELD_OPS: Readonly<Record<string, readonly string[]>> = {
  actType: ['eq', 'in'],
  issuerSlug: ['eq', 'in'],
  status: ['eq', 'in'],
  domain: ['eq', 'in'],
  category: ['eq', 'in'],
  penaltiesMentioned: ['eq'],
  year: ['eq'],
  yearFrom: ['gte'],
  yearTo: ['lte'],
};

export interface EngineFilterTranslation {
  readonly filter: LegalEngineFilter;
  /**
   * `field.op` pairs the engine cannot express. NON-EMPTY MEANS REFUSE — a
   * request whose filter was partly understood must not be answered.
   */
  readonly unsupported: readonly string[];
}

const asStrings = (value: unknown): string[] | null => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    const out = value.filter((v): v is string => typeof v === 'string');
    return out.length === value.length ? out : null;
  }
  return null;
};

const asInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null;

export const toEngineFilter = (
  input: FilterInput,
  includeHistorical: boolean
): EngineFilterTranslation => {
  const unsupported: string[] = [];
  const out: {
    -readonly [K in keyof LegalEngineFilter]: LegalEngineFilter[K];
  } = {};

  for (const [field, raw] of Object.entries(input)) {
    if (raw === undefined) continue;
    if (field === 'exclude') {
      // Negation has no place in the compiled clause list, and pretending it
      // was applied is exactly the silent-breadth failure.
      unsupported.push('exclude');
      continue;
    }
    if (field === 'q') {
      // `q` inside the filter is a SECOND text constraint, distinct from the
      // query this translator is given. It was accepted and thrown away, so a
      // caller narrowing by text got the unnarrowed answer back. There is no
      // engine clause for it here, so it is named and the request refused.
      unsupported.push('q');
      continue;
    }
    const fieldOps = FIELD_OPS[field];
    if (fieldOps === undefined) {
      unsupported.push(field);
      continue;
    }

    const ops = raw as Record<string, unknown>;
    for (const [op, value] of Object.entries(ops)) {
      if (!fieldOps.includes(op)) {
        unsupported.push(`${field}.${op}`);
        continue;
      }
      switch (field) {
        case 'actType': {
          const v = asStrings(value);
          if (v === null) unsupported.push(`${field}.${op}`);
          else out.actType = v;
          break;
        }
        case 'issuerSlug': {
          const v = asStrings(value);
          if (v === null) unsupported.push(`${field}.${op}`);
          else out.issuerSlug = v;
          break;
        }
        case 'status': {
          const v = asStrings(value);
          if (v === null) unsupported.push(`${field}.${op}`);
          else out.status = v;
          break;
        }
        case 'domain': {
          const v = asStrings(value);
          if (v === null) unsupported.push(`${field}.${op}`);
          else out.domain = v;
          break;
        }
        case 'category': {
          const v = asStrings(value);
          if (v === null) unsupported.push(`${field}.${op}`);
          else out.category = v;
          break;
        }
        case 'penaltiesMentioned': {
          if (typeof value !== 'boolean') unsupported.push(`${field}.${op}`);
          else out.penaltiesMentioned = value;
          break;
        }
        case 'year': {
          const v = asInt(value);
          if (v === null) unsupported.push(`${field}.${op}`);
          else out.year = v;
          break;
        }
        case 'yearFrom': {
          const v = asInt(value);
          if (v === null) unsupported.push(`${field}.${op}`);
          else out.yearFrom = v;
          break;
        }
        case 'yearTo': {
          const v = asInt(value);
          if (v === null) unsupported.push(`${field}.${op}`);
          else out.yearTo = v;
          break;
        }
        default:
          unsupported.push(`${field}.${op}`);
      }
    }
  }

  // §5.2-C: historical acts stay out unless asked for. An explicit status is
  // INTERSECTED with the live set, never allowed to replace it — the SQL path
  // ANDs the two, so letting the explicit list win here made the same request
  // return abrogated acts from the engine and none from Postgres. Asking for
  // `status: abrogat` with `includeHistorical: false` is a contradiction, and
  // the honest answer to a contradiction is the empty set, not history.
  if (!includeHistorical) {
    out.status =
      out.status === undefined
        ? [...LEGAL_LIVE_STATUSES]
        : out.status.filter((status) => LEGAL_LIVE_STATUSES.includes(status));
  }

  return { filter: out, unsupported };
};
