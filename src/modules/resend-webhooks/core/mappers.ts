import type {
  ResendEmailWebhookEvent,
  ResendWebhookEmailEventInsert,
  ResendWebhookTags,
} from './types.js';

const isStringRecord = (value: unknown): value is Record<string, string> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
};

export const parseTags = (value: unknown): ResendWebhookTags | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    const tags = value.filter(
      (entry): entry is { name: string; value: string } =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as { name?: unknown }).name === 'string' &&
        typeof (entry as { value?: unknown }).value === 'string'
    );

    return tags;
  }

  return isStringRecord(value) ? value : null;
};

export const extractTagValue = (
  tags: ResendWebhookTags | null | undefined,
  tagName: string
): string | undefined => {
  if (tags === null || tags === undefined) {
    return undefined;
  }

  if (Array.isArray(tags)) {
    const tag = tags.find((entry) => entry.name === tagName);
    return tag?.value;
  }

  return tags[tagName];
};

export const extractThreadKey = (tags: ResendWebhookTags | null | undefined): string | null =>
  extractTagValue(tags, 'thread_key') ?? null;

export const mapResendEmailWebhookEventToInsert = (
  svixId: string,
  event: ResendEmailWebhookEvent
): ResendWebhookEmailEventInsert => {
  const tags = event.data.tags ?? null;

  return {
    svix_id: svixId,
    event_type: event.type,
    event_created_at: new Date(event.created_at),
    email_id: event.data.email_id,
    from_address: event.data.from,
    to_addresses: event.data.to,
    subject: event.data.subject,
    email_created_at: new Date(event.data.created_at),
    broadcast_id: event.data.broadcast_id ?? null,
    template_id: event.data.template_id ?? null,
    tags: tags !== null ? JSON.stringify(tags) : null,
    bounce_type: event.data.bounce?.type ?? null,
    bounce_sub_type: event.data.bounce?.subType ?? null,
    bounce_message: event.data.bounce?.message ?? null,
    bounce_diagnostic_code: event.data.bounce?.diagnosticCode ?? null,
    click_ip_address: event.data.click?.ipAddress ?? null,
    click_link: event.data.click?.link ?? null,
    click_timestamp:
      event.data.click?.timestamp !== undefined ? new Date(event.data.click.timestamp) : null,
    click_user_agent: event.data.click?.userAgent ?? null,
    thread_key: extractThreadKey(tags),
  };
};
