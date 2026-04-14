import type { CampaignAdminInteractionConfig } from './campaign-admin-config.js';
import type { InteractiveStateRecord } from './types.js';

function toNullableTrimmedString(value: string | null | undefined): string | null {
  const trimmedValue = value?.trim();
  return trimmedValue === undefined || trimmedValue === '' ? null : trimmedValue;
}

function stripLocalePrefix(pathname: string): string {
  const strippedPathname = pathname.replace(/^\/(?:en|ro)(?=\/|$)/, '');
  return strippedPathname === '' ? '/' : strippedPathname;
}

export function extractInteractionEntityCui(
  record: Pick<InteractiveStateRecord, 'scope'>
): string | null {
  if (record.scope.type !== 'entity') {
    return null;
  }

  return toNullableTrimmedString(record.scope.entityCui);
}

export function buildCampaignProvocariStepPath(
  entityCui: string,
  stepLocation: NonNullable<CampaignAdminInteractionConfig['interactionStepLocation']>
): string {
  const encodedEntityCui = encodeURIComponent(entityCui.trim());
  const encodeSegment = (value: string) => encodeURIComponent(value.trim());

  return `/primarie/${encodedEntityCui}/buget/provocari/${encodeSegment(stepLocation.moduleSlug)}/${encodeSegment(stepLocation.challengeSlug)}/${encodeSegment(stepLocation.stepSlug)}`;
}

export function buildCampaignAdminInteractionStepLink(input: {
  record: Pick<InteractiveStateRecord, 'scope' | 'sourceUrl'>;
  interactionConfig: Pick<CampaignAdminInteractionConfig, 'interactionStepLocation'> | null;
}): string | null {
  const entityCui = extractInteractionEntityCui(input.record);

  if (
    entityCui === null ||
    input.interactionConfig?.interactionStepLocation === null ||
    input.interactionConfig?.interactionStepLocation === undefined
  ) {
    return null;
  }

  const fallbackPath = buildCampaignProvocariStepPath(
    entityCui,
    input.interactionConfig.interactionStepLocation
  );
  const sourceUrl = toNullableTrimmedString(input.record.sourceUrl);

  if (sourceUrl === null) {
    return fallbackPath;
  }

  try {
    const parsedUrl = new URL(sourceUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return fallbackPath;
    }

    if (stripLocalePrefix(parsedUrl.pathname) !== fallbackPath) {
      return fallbackPath;
    }

    return `${fallbackPath}${parsedUrl.search}${parsedUrl.hash}`;
  } catch {
    return fallbackPath;
  }
}
