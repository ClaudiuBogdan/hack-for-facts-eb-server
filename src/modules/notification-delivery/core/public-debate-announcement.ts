import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

export const PUBLIC_DEBATE_ANNOUNCEMENT_FAMILY_ID = 'public_debate_announcement' as const;
export const PUBLIC_DEBATE_ANNOUNCEMENT_TEMPLATE_ID = 'public_debate_announcement' as const;
export const PUBLIC_DEBATE_ANNOUNCEMENT_TIME_ZONE = 'Europe/Bucharest' as const;

const LOCAL_DATE_PATTERN_SOURCE = '^\\d{4}-\\d{2}-\\d{2}$';
const LOCAL_TIME_PATTERN_SOURCE = '^([01]\\d|2[0-3]):[0-5]\\d$';
const LOCAL_DATE_PATTERN = new RegExp(LOCAL_DATE_PATTERN_SOURCE, 'u');
const LOCAL_TIME_PATTERN = new RegExp(LOCAL_TIME_PATTERN_SOURCE, 'u');

export const PublicDebateAnnouncementPayloadSchema = Type.Object(
  {
    date: Type.String({ minLength: 1, pattern: LOCAL_DATE_PATTERN_SOURCE }),
    time: Type.String({ minLength: 1, pattern: LOCAL_TIME_PATTERN_SOURCE }),
    location: Type.String({ minLength: 1 }),
    announcement_link: Type.String({ minLength: 1 }),
    online_participation_link: Type.Optional(Type.String({ minLength: 1 })),
    description: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

export type PublicDebateAnnouncementPayload = Static<typeof PublicDebateAnnouncementPayloadSchema>;

export const PublicDebateAnnouncementOutboxMetadataSchema = Type.Object({
  campaignKey: Type.Literal('funky'),
  familyId: Type.Literal(PUBLIC_DEBATE_ANNOUNCEMENT_FAMILY_ID),
  entityCui: Type.String({ minLength: 1 }),
  entityName: Type.String({ minLength: 1 }),
  publicDebate: PublicDebateAnnouncementPayloadSchema,
  announcementFingerprint: Type.String({ minLength: 1 }),
  configUpdatedAt: Type.String({ minLength: 1 }),
  triggerSource: Type.Optional(Type.String({ minLength: 1 })),
  triggeredByUserId: Type.Optional(Type.String({ minLength: 1 })),
});

export type PublicDebateAnnouncementOutboxMetadata = Static<
  typeof PublicDebateAnnouncementOutboxMetadataSchema
>;

const getComparableLocalDebateMinute = (
  publicDebate: Pick<PublicDebateAnnouncementPayload, 'date' | 'time'>
): string | null => {
  if (!LOCAL_DATE_PATTERN.test(publicDebate.date) || !LOCAL_TIME_PATTERN.test(publicDebate.time)) {
    return null;
  }

  return `${publicDebate.date}T${publicDebate.time}`;
};

const getComparableTriggerMinute = (triggerTime: Date, timeZone: string): string | null => {
  if (Number.isNaN(triggerTime.getTime())) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(triggerTime)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  const year = parts['year'];
  const month = parts['month'];
  const day = parts['day'];
  const hour = parts['hour'];
  const minute = parts['minute'];

  if (
    typeof year !== 'string' ||
    typeof month !== 'string' ||
    typeof day !== 'string' ||
    typeof hour !== 'string' ||
    typeof minute !== 'string'
  ) {
    return null;
  }

  return `${year}-${month}-${day}T${hour}:${minute}`;
};

export const isPublicDebateAnnouncementAfterTriggerTime = (input: {
  publicDebate: Pick<PublicDebateAnnouncementPayload, 'date' | 'time'>;
  triggerTime: Date;
  timeZone?: string;
}): boolean => {
  const debateMinute = getComparableLocalDebateMinute(input.publicDebate);
  const triggerMinute = getComparableTriggerMinute(
    input.triggerTime,
    input.timeZone ?? PUBLIC_DEBATE_ANNOUNCEMENT_TIME_ZONE
  );

  return debateMinute !== null && triggerMinute !== null && debateMinute > triggerMinute;
};

const getValidationMessage = (value: unknown): string => {
  const [firstError] = [...Value.Errors(PublicDebateAnnouncementOutboxMetadataSchema, value)];
  if (firstError !== undefined && typeof firstError.message === 'string') {
    return firstError.message;
  }

  return 'Invalid public-debate-announcement metadata';
};

export const parsePublicDebateAnnouncementOutboxMetadata = (
  value: unknown
): Result<PublicDebateAnnouncementOutboxMetadata, string> => {
  if (!Value.Check(PublicDebateAnnouncementOutboxMetadataSchema, value)) {
    return err(getValidationMessage(value));
  }

  return ok(value);
};
