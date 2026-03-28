export interface InvalidClerkWebhookPayloadError {
  type: 'InvalidClerkWebhookPayload';
  message: string;
}

export interface ClerkWebhookVerificationError {
  type: 'INVALID_SIGNATURE' | 'EXPIRED' | 'UNKNOWN';
  message: string;
}
