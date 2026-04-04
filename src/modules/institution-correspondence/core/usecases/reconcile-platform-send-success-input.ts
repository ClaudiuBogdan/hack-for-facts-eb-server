import type { CorrespondenceAttachmentMetadata } from '../types.js';

export interface ReconcilePlatformSendSuccessInput {
  threadKey: string;
  resendEmailId: string;
  messageId?: string | null;
  observedAt: Date;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses?: string[];
  bccAddresses?: string[];
  subject: string;
  textBody?: string | null;
  htmlBody?: string | null;
  headers?: Record<string, string>;
  attachments?: CorrespondenceAttachmentMetadata[];
}
