/**
 * Reference module — row → view-model mappers (plan §2). Pure functions:
 * snake_case rows → camelCase domain types. jsonb arrays/objects arrive parsed.
 * `field_trace` is mapped ONLY when present (the repo omits it from the select
 * unless includeTrace is requested), and never reaches the MCP/card surface.
 *
 * `mapPublicEntity` returns the DETAIL type (`ReferencePublicEntity`); the CARD
 * shape (`ReferencePublicEntityCard`, no field_trace) is the same object with
 * `fieldTrace: null` — assignable to the card type since the detail extends it.
 * The embedded `territory` (kernel `Territory`) is supplied by the usecase, not the
 * mapper (the mapper passes it through).
 */

import type {
  ReferenceClassificationCode,
  ReferencePublicEntity,
  Territory,
} from '../../core/types.js';

/** Defensive: coerce a jsonb value to a string[] (tags). Non-strings dropped. */
const toStringArray = (v: unknown): readonly string[] => {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
};

/** Defensive: coerce a jsonb value to an opaque object[] (main_creditors / issues). */
const toObjectArray = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

export interface PublicEntityRow {
  cui: string;
  name: string;
  address: string | null;
  entity_type: string | null;
  category: string | null;
  tags: unknown;
  is_uat: boolean | null;
  territorial_siruta_code: string | null;
  uat_mapping_method: string | null;
  uat_mapping_confidence: string | null;
  uat_unresolved_reason: string | null;
  parent1_cui: string | null;
  parent2_cui: string | null;
  main_creditors: unknown;
  default_report_type: string | null;
  issues: unknown;
  field_trace?: unknown;
  updated_at: string;
}

export const mapPublicEntity = (
  r: PublicEntityRow,
  territory: Territory | null,
  includeTrace: boolean
): ReferencePublicEntity => ({
  cui: r.cui,
  name: r.name,
  address: r.address,
  entityType: r.entity_type,
  category: r.category,
  tags: toStringArray(r.tags),
  isUat: r.is_uat === true,
  territorialSirutaCode: r.territorial_siruta_code,
  uatMapping: {
    method: r.uat_mapping_method,
    confidence: r.uat_mapping_confidence,
    unresolvedReason: r.uat_unresolved_reason,
  },
  parents: { cui1: r.parent1_cui, cui2: r.parent2_cui },
  mainCreditors: toObjectArray(r.main_creditors),
  defaultReportType: r.default_report_type,
  issues: toObjectArray(r.issues),
  fieldTrace:
    includeTrace &&
    r.field_trace !== null &&
    r.field_trace !== undefined &&
    typeof r.field_trace === 'object' &&
    !Array.isArray(r.field_trace)
      ? (r.field_trace as Record<string, unknown>)
      : null,
  updatedAt: r.updated_at,
  territory,
});

export interface ClassificationRow {
  system: string;
  code: string;
  label: string | null;
  parent_code: string | null;
}

export const mapClassification = (r: ClassificationRow): ReferenceClassificationCode => ({
  system: r.system,
  code: r.code,
  label: r.label,
  parentCode: r.parent_code,
});
