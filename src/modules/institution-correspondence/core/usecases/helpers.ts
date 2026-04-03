import { createHash } from 'crypto';

import { FUNKY_CITIZENS_NGO_IDENTITY, PUBLIC_DEBATE_REQUEST_TYPE } from '../types.js';

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SUBJECT_THREAD_KEY_PREFIX = '[teu:';
const THREAD_KEY_SUBJECT_REGEX = new RegExp(`\\${SUBJECT_THREAD_KEY_PREFIX}([^\\]]+)\\]`, 'i');

export const normalizeOptionalString = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : null;
};

export const normalizeEmailAddress = (value: string): string => value.trim().toLowerCase();

export const normalizeEmailSubject = (value: string): string =>
  value.trim().replaceAll(/\s+/g, ' ').toLowerCase();

export const buildSelfSendInteractionKey = (associationEmail: string, subject: string): string => {
  const normalizedPayload = `${normalizeEmailAddress(associationEmail)}\n${normalizeEmailSubject(subject)}`;
  const digest = createHash('sha256').update(normalizedPayload).digest('hex');
  return `funky:correlation:self_send:${digest}`;
};

export const getBudgetYear = (publicationDate: Date | null): number => {
  return publicationDate?.getUTCFullYear() ?? new Date().getUTCFullYear();
};

export const parseOptionalDate = (value: string | null | undefined): Date | null => {
  if (value === undefined || value === null || value.trim() === '') {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const toIsoString = (value: Date | null): string | null =>
  value !== null ? value.toISOString() : null;

export const computeContestationDeadline = (publicationDate: Date | null): Date | null => {
  if (publicationDate === null) {
    return null;
  }

  return new Date(publicationDate.getTime() + 15 * 24 * 60 * 60 * 1000);
};

export const embedThreadKeyInSubject = (subject: string, threadKey: string): string => {
  return `${subject} ${SUBJECT_THREAD_KEY_PREFIX}${threadKey}]`;
};

export const extractThreadKeyFromSubject = (subject: string): string | null => {
  const match = THREAD_KEY_SUBJECT_REGEX.exec(subject);
  return match?.[1]?.trim() ?? null;
};

export const extractMessageReferences = (headers: Record<string, string>): string[] => {
  const normalizedHeaders = Object.entries(headers).reduce<Record<string, string>>((acc, entry) => {
    acc[entry[0].toLowerCase()] = entry[1];
    return acc;
  }, {});

  const references = new Set<string>();
  const candidates = [
    normalizedHeaders['in-reply-to'],
    normalizedHeaders['references'],
    normalizedHeaders['message-id'],
  ];

  for (const candidate of candidates) {
    if (candidate === undefined) {
      continue;
    }

    const matches = candidate.match(/<[^>]+>/g);
    if (matches !== null) {
      for (const match of matches) {
        references.add(match.trim());
      }
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed !== '') {
      references.add(trimmed);
    }
  }

  return [...references];
};

export const buildSharedCorrespondenceInboxAddress = (receiveDomain: string): string => {
  return `contact@${receiveDomain.trim().toLowerCase()}`;
};

export const DEFAULT_NGO_IDENTITY = FUNKY_CITIZENS_NGO_IDENTITY;
export const DEFAULT_REQUEST_TYPE = PUBLIC_DEBATE_REQUEST_TYPE;
