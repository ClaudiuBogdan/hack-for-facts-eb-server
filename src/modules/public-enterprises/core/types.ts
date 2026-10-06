import type { FilterInput, Organization } from '@/modules/shared/index.js';

/**
 * Registry observation families, exactly as the scraper's R5 public views name
 * them. AMEPIP company-year, AMEPIP form and S1001 are PRIMARY (they make a
 * current member); JSON-APT is an overlay and never makes a member.
 */
export const PUBLIC_ENTERPRISE_FAMILIES = [
  'amepip_company_year',
  'amepip_form_group',
  's1001',
  'json_apt',
] as const;
export type PublicEnterpriseFamily = (typeof PUBLIC_ENTERPRISE_FAMILIES)[number];

/** Source lanes served by `public_source_snapshots`, in their fixed display order. */
export const PUBLIC_ENTERPRISE_SOURCE_FAMILIES = ['amepip', 's1001', 'json_apt'] as const;
export type PublicEnterpriseSourceFamily = (typeof PUBLIC_ENTERPRISE_SOURCE_FAMILIES)[number];

/** Control edges come from these two lanes only. */
export const PUBLIC_ENTERPRISE_EDGE_FAMILIES = ['s1001', 'json_apt'] as const;
export type PublicEnterpriseEdgeFamily = (typeof PUBLIC_ENTERPRISE_EDGE_FAMILIES)[number];

/** Authority levels as the source edge reports them ('unknown' for JSON-APT). */
export const PUBLIC_ENTERPRISE_AUTHORITY_LEVELS = [
  'central',
  'county',
  'local',
  'unknown',
] as const;

/** Indicator cell kinds as the AMEPIP parser classified the original cell. */
export const PUBLIC_ENTERPRISE_VALUE_KINDS = ['number', 'boolean', 'text', 'empty'] as const;
export type PublicEnterpriseValueKind = (typeof PUBLIC_ENTERPRISE_VALUE_KINDS)[number];

/**
 * available: the lane has a current accepted public snapshot.
 * partial: same, but its raw capture was recorded `partial`.
 * unavailable: the lane is not loaded; this never means a CUI is absent from it.
 */
export type PublicEnterpriseLaneStatus = 'available' | 'partial' | 'unavailable';

/** One source lane. All snapshot fields are null when the lane is unavailable. */
export interface PublicEnterpriseSource {
  readonly family: PublicEnterpriseSourceFamily;
  readonly scope: string | null;
  readonly laneStatus: PublicEnterpriseLaneStatus;
  readonly snapshotId: string | null;
  readonly rawStatus: string | null;
  readonly sourceUrl: string | null;
  readonly contentSha256: string | null;
  /** When the platform observed (captured) the source, not a publication date. */
  readonly observedAt: string | null;
  readonly sourceLastModifiedAt: string | null;
  readonly acceptedAt: string | null;
  readonly loadedAt: string | null;
}

/** A registry observation as reported by its source (names and statuses unverified). */
export interface PublicEnterpriseRegistryObservation {
  readonly id: string;
  readonly snapshotId: string;
  readonly sourceFamily: PublicEnterpriseFamily;
  readonly sourceRecordKey: string;
  readonly cui: string;
  readonly rawCui: string | null;
  readonly cuiChecksumStatus: string;
  readonly publishStatus: string;
  readonly observedName: string | null;
  readonly observedYear: number | null;
  readonly statusRaw: string | null;
  readonly statusNormalized: string | null;
  readonly rawSubordination: string | null;
  readonly derivedAuthorityLevel: string | null;
  readonly sourceEvidenceKey: string;
  readonly sourceUrl: string | null;
}

/** A control edge as reported by its source; not an ownership claim. */
export interface PublicEnterpriseAuthorityEdge {
  readonly id: string;
  readonly snapshotId: string;
  readonly sourceFamily: PublicEnterpriseEdgeFamily;
  readonly sourceRecordKey: string;
  readonly enterpriseCui: string;
  readonly authorityCui: string | null;
  /** The authority name exactly as the source wrote it, not a resolved identity. */
  readonly authorityName: string | null;
  readonly rawSubordination: string | null;
  readonly authorityLevel: string;
  readonly authorityLevelMethod: string;
  readonly aptTypeId: number | null;
  readonly enterpriseStatusRaw: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly sourceEvidenceKey: string;
  readonly sourceUrl: string | null;
}

/** One AMEPIP indicator cell. Numbers are exact decimal text; text_value is served NULL. */
export interface PublicEnterpriseIndicator {
  readonly id: string;
  readonly snapshotId: string;
  readonly enterpriseCui: string;
  readonly year: number;
  readonly sourceSheet: string;
  readonly version: string;
  readonly indicatorKey: string;
  readonly kpiCode: string | null;
  readonly indicatorName: string;
  readonly measureUnit: string | null;
  readonly valueKind: PublicEnterpriseValueKind;
  /** The original cell; '' and null stay distinct. */
  readonly rawValue: string | null;
  readonly numericValue: string | null;
  readonly booleanValue: boolean | null;
  readonly textValue: string | null;
  readonly sourceRowNumber: number | null;
  readonly sourceEvidenceKey: string;
  readonly sourceUrl: string | null;
}

/** A public anchor's current membership (historical anchors: false and []). */
export interface PublicEnterpriseMembership {
  readonly cui: string;
  readonly isCurrentMember: boolean;
  readonly currentFamilies: readonly PublicEnterpriseFamily[];
}

/** A list row. `organization` is null when the kernel identity is withheld or absent. */
export interface PublicEnterpriseSummary extends PublicEnterpriseMembership {
  readonly organization: Organization | null;
}

export interface PublicEnterpriseProfile extends PublicEnterpriseSummary {
  readonly registryObservations: readonly PublicEnterpriseRegistryObservation[];
  readonly authorityEdges: readonly PublicEnterpriseAuthorityEdge[];
  readonly sources: readonly PublicEnterpriseSource[];
}

/** The repository's profile read, before kernel identity is attached. */
export interface PublicEnterpriseProfileRecord extends PublicEnterpriseMembership {
  readonly registryObservations: readonly PublicEnterpriseRegistryObservation[];
  readonly authorityEdges: readonly PublicEnterpriseAuthorityEdge[];
  readonly sources: readonly PublicEnterpriseSource[];
}

export interface PublicEnterpriseListRequest {
  readonly filter: FilterInput;
  readonly page: number;
  readonly pageSize: number;
}

export interface PublicEnterpriseMembershipPage {
  readonly items: readonly PublicEnterpriseMembership[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface PublicEnterprisePage {
  readonly items: readonly PublicEnterpriseSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface PublicEnterpriseIndicatorRequest {
  readonly cui: string;
  readonly filter: FilterInput;
  readonly first: number;
  readonly after?: string;
}

/** `snapshotId` is the current AMEPIP snapshot the page (and its cursor) is pinned to. */
export interface PublicEnterpriseIndicatorPage {
  readonly items: readonly PublicEnterpriseIndicator[];
  readonly next: string | null;
  readonly snapshotId: string | null;
}
