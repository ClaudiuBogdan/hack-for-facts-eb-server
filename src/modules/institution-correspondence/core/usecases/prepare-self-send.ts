import { randomUUID } from 'crypto';

import { err, ok, type Result } from 'neverthrow';

import { createValidationError, type InstitutionCorrespondenceError } from '../errors.js';
import {
  DEFAULT_NGO_IDENTITY,
  EMAIL_REGEX,
  normalizeOptionalString,
  parseOptionalDate,
  getBudgetYear,
} from './helpers.js';

import type { CorrespondenceTemplateRenderer } from '../ports.js';
import type { PrepareSelfSendInput, PrepareSelfSendOutput } from '../types.js';

export interface PrepareSelfSendDeps {
  templateRenderer: CorrespondenceTemplateRenderer;
  auditCcRecipients: string[];
  captureAddress: string;
}

export function prepareSelfSend(
  deps: PrepareSelfSendDeps,
  input: PrepareSelfSendInput
): Promise<Result<PrepareSelfSendOutput, InstitutionCorrespondenceError>> {
  const entityCui = input.entityCui.trim();
  const institutionEmail = input.institutionEmail.trim();
  const requesterOrganizationName = normalizeOptionalString(input.requesterOrganizationName);
  const publicationDate = parseOptionalDate(input.budgetPublicationDate);

  if (entityCui === '') {
    return Promise.resolve(err(createValidationError('entityCui is required.')));
  }

  if (!EMAIL_REGEX.test(institutionEmail)) {
    return Promise.resolve(
      err(createValidationError('institutionEmail must be a valid email address.'))
    );
  }

  const threadKey = randomUUID();
  const rendered = deps.templateRenderer.renderPublicDebateRequest({
    institutionEmail,
    requesterOrganizationName,
    ngoIdentity: DEFAULT_NGO_IDENTITY,
    budgetYear: getBudgetYear(publicationDate),
    threadKey,
  });

  return Promise.resolve(
    ok({
      created: true,
      existingThread: null,
      threadKey,
      captureAddress: deps.captureAddress,
      subject: rendered.subject,
      body: rendered.text,
      cc: [deps.captureAddress, ...deps.auditCcRecipients],
    })
  );
}
