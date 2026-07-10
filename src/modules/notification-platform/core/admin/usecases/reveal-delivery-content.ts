import { err, ok, type Result } from 'neverthrow';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { PlatformDeliveryError } from '../../delivery/errors.js';
import type { DeliveryRepo } from '../../delivery/ports.js';
import type { ValidationError } from '../../shared/errors.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { RevealedDeliveryContent } from '../types.js';

export interface RevealDeliveryContentDeps {
  deliveries: DeliveryRepo;
  audit: AuditLedgerPort;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface RevealDeliveryContentInput {
  deliveryId: string;
  adminUserId: string;
  reason: string;
}

export type RevealDeliveryContentResult = RevealedDeliveryContent;
export type RevealDeliveryContentError = PlatformDeliveryError | AuditError | ValidationError;

export const revealDeliveryContent = async (
  deps: RevealDeliveryContentDeps,
  input: RevealDeliveryContentInput
): Promise<Result<RevealDeliveryContentResult, RevealDeliveryContentError>> => {
  if (input.reason.trim().length === 0) {
    return err({ type: 'ValidationError', message: 'Reveal reason is required', field: 'reason' });
  }
  const found = await deps.deliveries.findById(input.deliveryId);
  if (found.isErr()) {
    return err(found.error);
  }
  if (found.value === null) {
    return err({ type: 'NotFound', entity: 'delivery', id: input.deliveryId });
  }
  const audited = await deps.audit.append({
    action: 'admin.content_revealed',
    occurredAt: deps.clock.now(),
    actor: input.adminUserId,
    userId: found.value.userId,
    deliveryId: found.value.id,
    reason: input.reason,
  });
  if (audited.isErr()) {
    return err(audited.error);
  }
  return ok({
    deliveryId: found.value.id,
    templateId: found.value.templateId,
    templateVersion: found.value.templateVersion,
    subject: found.value.renderedSubject,
    html: found.value.renderedHtml,
    text: found.value.renderedText,
    contentHash: found.value.contentHash,
  });
};
